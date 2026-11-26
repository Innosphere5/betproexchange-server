const { createClient } = require('@supabase/supabase-js');
const { createRemoteJWKSet, jwtVerify } = require('jose');
require('dotenv').config();

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const SCHEMA_RETRY_MS = 60 * 1000;

/**
 * SupabaseService — Relational Archive, 24h Match Result Expiry & Ledger Store
 *
 * Designed as the PostgreSQL companion to MongoDB Atlas + Upstash Redis:
 *   - Redis (TCP): sub-5ms quotes, scores, catalog hot cache
 *   - MongoDB: active operational matches, nested markets, atomic wallet & bet locks
 *   - Supabase PostgreSQL: 24h completed result archive, settled bet archive,
 *     financial ledger, suspension audits, and JWKS token verification
 */
class SupabaseService {
  constructor() {
    this.url = process.env.SUPABASE_URL || '';
    this.publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY || '';
    this.secretKey = process.env.SUPABASE_SECRET_KEY || '';
    this.jwksUrl = process.env.SUPABASE_JWKS_URL || (this.url ? `${this.url.replace(/\/+$/, '')}/auth/v1/.well-known/jwks.json` : '');

    this.client = null;
    this.jwks = null;
    this.schemaMissingUntil = 0;
    this.schemaWarned = false;

    if (this.url && this.secretKey) {
      this.client = createClient(this.url, this.secretKey, {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false,
        },
        global: {
          headers: { 'x-application-name': 'betproexchange-server' },
        },
      });
    }

    if (this.jwksUrl) {
      try {
        this.jwks = createRemoteJWKSet(new URL(this.jwksUrl));
      } catch (err) {
        console.warn('[Supabase] Invalid SUPABASE_JWKS_URL:', err.message);
      }
    }
  }

  isConfigured() {
    return Boolean(this.client);
  }

  _isSchemaUnavailableError(error) {
    if (!error) return false;
    const code = String(error.code || '');
    const msg = String(error.message || '').toLowerCase();
    return (
      code === 'PGRST205' ||
      code === '42P01' ||
      code === '42501' ||
      msg.includes('could not find the table') ||
      msg.includes('does not exist') ||
      msg.includes('permission denied')
    );
  }

  _handleError(op, error) {
    if (!error) return;
    if (this._isSchemaUnavailableError(error)) {
      this.schemaMissingUntil = Date.now() + SCHEMA_RETRY_MS;
      if (!this.schemaWarned) {
        this.schemaWarned = true;
        console.warn(
          `[Supabase] Schema tables not initialized yet (${op}). Run supabase/migrations/001_betpro_dual_db.sql in Supabase SQL Editor.`
        );
      }
      return;
    }
    console.warn(`[Supabase] ${op} warning:`, error.message || String(error));
  }

  _canQuery() {
    return Boolean(this.client && Date.now() >= this.schemaMissingUntil);
  }

  /** Verify a Supabase-issued JWT using the configured JWKS endpoint. */
  async verifySupabaseJwt(token) {
    if (!token || !this.jwks) {
      throw new Error('Supabase JWKS verifier is not configured');
    }
    const { payload } = await jwtVerify(token, this.jwks);
    return payload;
  }

  /** Map a Mongo Match document (or plain object) into the match_results Postgres row. */
  static buildMatchResultRow(matchDoc, now = new Date()) {
    if (!matchDoc || !matchDoc.matchId) return null;
    const completedAt = matchDoc.completedAt ? new Date(matchDoc.completedAt) : now;
    const expiresAt = new Date(completedAt.getTime() + ONE_DAY_MS);
    return {
      match_id: String(matchDoc.matchId),
      team_a: String(matchDoc.teamA || 'Team A'),
      team_b: String(matchDoc.teamB || 'Team B'),
      league: String(matchDoc.league || 'Cricket'),
      status: 'completed',
      winner: matchDoc.winner || null,
      score: matchDoc.score || {},
      start_time: matchDoc.startTime ? new Date(matchDoc.startTime).toISOString() : null,
      completed_at: completedAt.toISOString(),
      expires_at: expiresAt.toISOString(),
      updated_at: now.toISOString(),
    };
  }

  /** Map a settled Bet document into the bet_settlement_archive Postgres row. */
  static buildSettledBetRow(bet) {
    if (!bet) return null;
    const betId = String(bet._id || bet.betId || '');
    if (!betId) return null;
    return {
      bet_id: betId,
      user_id: String(bet.userId || ''),
      match_id: String(bet.matchId || ''),
      match_name: String(bet.matchName || 'Cricket Match'),
      runner: String(bet.runner || ''),
      bet_type: String(bet.type || 'back'),
      market_type: String(bet.marketType || 'match_odds'),
      stake: Number(bet.stake || 0),
      odds: Number(bet.odds || 0),
      effective_odds: bet.effectiveOdds != null ? Number(bet.effectiveOdds) : null,
      closing_odds: bet.closingOdds != null ? Number(bet.closingOdds) : null,
      payout: Number(bet.payout || 0),
      status: String(bet.status || 'settled'),
      result: bet.result || null,
      settled_at: (bet.settledAt ? new Date(bet.settledAt) : new Date()).toISOString(),
      created_at: (bet.createdAt ? new Date(bet.createdAt) : new Date()).toISOString(),
    };
  }

  /** Map a Transaction document into the financial_ledger Postgres row. */
  static buildLedgerRow(tx) {
    if (!tx) return null;
    const mongoId = String(tx._id || tx.mongoTxId || '');
    if (!mongoId) return null;
    return {
      mongo_tx_id: mongoId,
      user_id: String(tx.userId || ''),
      amount: Number(tx.amount || 0),
      tx_type: String(tx.type || 'LOAD_BALANCE'),
      description: tx.description || null,
      match_name: tx.matchName || null,
      selection: tx.selection || null,
      category: tx.category || 'cricket',
      bettor: tx.bettor || null,
      bettor_net: tx.bettorNet != null ? Number(tx.bettorNet) : null,
      downline: tx.downline || null,
      performed_by: tx.performedBy || null,
      created_at: (tx.createdAt ? new Date(tx.createdAt) : new Date()).toISOString(),
    };
  }

  /** Archive a completed match result into Supabase with 24-hour auto-expiry. */
  async archiveCompletedMatchResult(matchDoc) {
    if (!this._canQuery()) return { ok: false, skipped: true };
    const row = SupabaseService.buildMatchResultRow(matchDoc);
    if (!row) return { ok: false, skipped: true };

    try {
      const { error } = await this.client
        .from('match_results')
        .upsert(row, { onConflict: 'match_id' });
      if (error) {
        this._handleError('archiveCompletedMatchResult', error);
        return { ok: false, error: error.message };
      }
      return { ok: true };
    } catch (err) {
      this._handleError('archiveCompletedMatchResult', err);
      return { ok: false, error: err.message };
    }
  }

  /** Delete all expired match_results rows (>24h old) from Supabase. */
  async purgeExpiredMatchResults(now = new Date()) {
    if (!this._canQuery()) return { deletedCount: 0, skipped: true };
    try {
      const nowIso = now.toISOString();
      const { data, error } = await this.client
        .from('match_results')
        .delete()
        .lte('expires_at', nowIso)
        .select('match_id');
      if (error) {
        this._handleError('purgeExpiredMatchResults', error);
        return { deletedCount: 0, error: error.message };
      }
      const deletedCount = Array.isArray(data) ? data.length : 0;
      if (deletedCount > 0) {
        console.log(`[Supabase] Purged ${deletedCount} expired match result(s) (>24h).`);
      }
      return { deletedCount };
    } catch (err) {
      this._handleError('purgeExpiredMatchResults', err);
      return { deletedCount: 0, error: err.message };
    }
  }

  /** Read non-expired completed match results (<24h old) from Supabase. */
  async getActiveMatchResults({ limit = 40 } = {}) {
    if (!this._canQuery()) return [];
    try {
      const nowIso = new Date().toISOString();
      const { data, error } = await this.client
        .from('match_results')
        .select('*')
        .gt('expires_at', nowIso)
        .order('completed_at', { ascending: false })
        .limit(limit);
      if (error) {
        this._handleError('getActiveMatchResults', error);
        return [];
      }
      return (data || []).map((r) => ({
        matchId: r.match_id,
        teamA: r.team_a,
        teamB: r.team_b,
        league: r.league,
        status: r.status || 'completed',
        winner: r.winner,
        score: r.score || {},
        startTime: r.start_time,
        completedAt: r.completed_at,
        expiresAt: r.expires_at,
        lastUpdated: r.updated_at || r.completed_at,
        source: 'supabase',
      }));
    } catch (err) {
      this._handleError('getActiveMatchResults', err);
      return [];
    }
  }

  /** Lookup a single non-expired match result by matchId (with/without 'id' prefix). */
  async getMatchResultById(lookupId) {
    if (!this._canQuery() || !lookupId) return null;
    const raw = String(lookupId).trim();
    const clean = raw.replace(/^id/i, '');
    const prefixed = `id${clean}`;
    try {
      const nowIso = new Date().toISOString();
      const { data, error } = await this.client
        .from('match_results')
        .select('*')
        .in('match_id', Array.from(new Set([raw, clean, prefixed])))
        .gt('expires_at', nowIso)
        .limit(1)
        .maybeSingle();
      if (error) {
        this._handleError('getMatchResultById', error);
        return null;
      }
      if (!data) return null;
      return {
        matchId: data.match_id,
        teamA: data.team_a,
        teamB: data.team_b,
        league: data.league,
        status: 'completed',
        isCompleted: true,
        winner: data.winner,
        score: data.score || {},
        startTime: data.start_time,
        completedAt: data.completed_at,
        marketStatus: 'CLOSED',
        bookmakerMarketStatus: 'CLOSED',
        tossMarketStatus: 'CLOSED',
        source: 'supabase',
      };
    } catch (err) {
      this._handleError('getMatchResultById', err);
      return null;
    }
  }

  /** Mirror settled bets to Supabase bet_settlement_archive. */
  async archiveSettledBets(bets) {
    if (!this._canQuery()) return { ok: false, skipped: true };
    const list = (Array.isArray(bets) ? bets : [bets])
      .map(SupabaseService.buildSettledBetRow)
      .filter(Boolean);
    if (list.length === 0) return { ok: true, count: 0 };

    try {
      const { error } = await this.client
        .from('bet_settlement_archive')
        .upsert(list, { onConflict: 'bet_id' });
      if (error) {
        this._handleError('archiveSettledBets', error);
        return { ok: false, error: error.message };
      }
      return { ok: true, count: list.length };
    } catch (err) {
      this._handleError('archiveSettledBets', err);
      return { ok: false, error: err.message };
    }
  }

  /** Mirror financial transactions to Supabase financial_ledger. */
  async archiveFinancialTransactions(txs) {
    if (!this._canQuery()) return { ok: false, skipped: true };
    const list = (Array.isArray(txs) ? txs : [txs])
      .map(SupabaseService.buildLedgerRow)
      .filter(Boolean);
    if (list.length === 0) return { ok: true, count: 0 };

    try {
      const { error } = await this.client
        .from('financial_ledger')
        .upsert(list, { onConflict: 'mongo_tx_id' });
      if (error) {
        this._handleError('archiveFinancialTransactions', error);
        return { ok: false, error: error.message };
      }
      return { ok: true, count: list.length };
    } catch (err) {
      this._handleError('archiveFinancialTransactions', err);
      return { ok: false, error: err.message };
    }
  }

  /** Mirror suspension audit rows to Supabase suspension_audit_log. */
  async archiveSuspensionAudits(audits) {
    if (!this._canQuery()) return { ok: false, skipped: true };
    const list = (Array.isArray(audits) ? audits : [audits])
      .map((a, idx) => {
        const id = String(a?._id || a?.mongoAuditId || `${a?.matchId || 'm'}_${a?.marketName || 'mkt'}_${a?.stateSeq || Date.now()}_${idx}`);
        if (!id) return null;
        return {
          mongo_audit_id: id,
          match_id: String(a.matchId || ''),
          market_type: String(a.marketType || 'fancy'),
          market_name: a.marketName || null,
          previous_status: a.oldStatus || a.previousStatus || null,
          new_status: String(a.newStatus || 'SUSPENDED'),
          reasons: Array.isArray(a.newReasons) ? a.newReasons : (Array.isArray(a.reasons) ? a.reasons : []),
          created_at: (a.createdAt ? new Date(a.createdAt) : new Date()).toISOString(),
        };
      })
      .filter(Boolean);
    if (list.length === 0) return { ok: true, count: 0 };

    try {
      const { error } = await this.client
        .from('suspension_audit_log')
        .upsert(list, { onConflict: 'mongo_audit_id' });
      if (error) {
        this._handleError('archiveSuspensionAudits', error);
        return { ok: false, error: error.message };
      }
      return { ok: true, count: list.length };
    } catch (err) {
      this._handleError('archiveSuspensionAudits', err);
      return { ok: false, error: err.message };
    }
  }

  /** Health diagnostic reported via /health and /api/pool-status. */
  async healthCheck() {
    if (!this.isConfigured()) {
      return { configured: false, reachable: false, schemaReady: false, jwksConfigured: Boolean(this.jwks) };
    }
    try {
      const { error } = await this.client
        .from('match_results')
        .select('match_id')
        .limit(1);
      if (!error) {
        this.schemaMissingUntil = 0;
        return { configured: true, reachable: true, schemaReady: true, jwksConfigured: Boolean(this.jwks) };
      }
      if (this._isSchemaUnavailableError(error)) {
        return {
          configured: true,
          reachable: true,
          schemaReady: false,
          jwksConfigured: Boolean(this.jwks),
          notice: 'Run supabase/migrations/001_betpro_dual_db.sql in Supabase SQL Editor',
        };
      }
      return {
        configured: true,
        reachable: true,
        schemaReady: false,
        jwksConfigured: Boolean(this.jwks),
        error: error.message,
      };
    } catch (err) {
      return {
        configured: true,
        reachable: false,
        schemaReady: false,
        jwksConfigured: Boolean(this.jwks),
        error: err.message,
      };
    }
  }
}

module.exports = new SupabaseService();
module.exports.SupabaseService = SupabaseService;
