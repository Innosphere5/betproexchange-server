-- =============================================================================
-- BetProExchange Dual-Database Relational Archive & Ledger Schema (Supabase)
-- =============================================================================
-- Architecture Specialization:
--   * Upstash Redis (TCP): <5ms hot quotes, live scores, catalog cache
--   * MongoDB Atlas: Active operational state (yesterday+today+live matches,
--     nested markets, atomic user wallet locks, open/matched bets, 24h TTL)
--   * Supabase PostgreSQL: Relational archive, 24h completed match results,
--     settled bet history, ACID financial ledger, and suspension audit log
-- =============================================================================

-- 1. Completed Match Results (Auto-expires 24 hours after completion)
CREATE TABLE IF NOT EXISTS public.match_results (
  match_id TEXT PRIMARY KEY,
  team_a TEXT NOT NULL,
  team_b TEXT NOT NULL,
  league TEXT DEFAULT 'Cricket',
  status TEXT NOT NULL DEFAULT 'completed',
  winner TEXT,
  score JSONB NOT NULL DEFAULT '{}'::jsonb,
  start_time TIMESTAMPTZ,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_match_results_expires_at
  ON public.match_results (expires_at);

CREATE INDEX IF NOT EXISTS idx_match_results_completed_at
  ON public.match_results (completed_at DESC);

-- 2. Settled Bet Archive (Offloads settled historical bets from MongoDB)
CREATE TABLE IF NOT EXISTS public.bet_settlement_archive (
  bet_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  match_id TEXT NOT NULL,
  match_name TEXT NOT NULL,
  runner TEXT NOT NULL,
  bet_type TEXT NOT NULL,
  market_type TEXT NOT NULL DEFAULT 'match_odds',
  stake NUMERIC(14, 2) NOT NULL,
  odds NUMERIC(10, 4) NOT NULL,
  effective_odds NUMERIC(10, 4),
  closing_odds NUMERIC(10, 4),
  payout NUMERIC(14, 2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  result TEXT,
  settled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bet_archive_user_settled
  ON public.bet_settlement_archive (user_id, settled_at DESC);

CREATE INDEX IF NOT EXISTS idx_bet_archive_match
  ON public.bet_settlement_archive (match_id);

-- 3. Immutable Relational Financial Ledger (Mirrors hierarchy & cash transactions)
CREATE TABLE IF NOT EXISTS public.financial_ledger (
  mongo_tx_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  amount NUMERIC(14, 2) NOT NULL,
  tx_type TEXT NOT NULL DEFAULT 'LOAD_BALANCE',
  description TEXT,
  match_name TEXT,
  selection TEXT,
  category TEXT DEFAULT 'cricket',
  bettor TEXT,
  bettor_net NUMERIC(14, 2),
  downline TEXT,
  performed_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_financial_ledger_user_created
  ON public.financial_ledger (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_financial_ledger_bettor_created
  ON public.financial_ledger (bettor, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_financial_ledger_downline_type
  ON public.financial_ledger (downline, tx_type);

-- 4. Market Suspension Audit Log
CREATE TABLE IF NOT EXISTS public.suspension_audit_log (
  mongo_audit_id TEXT PRIMARY KEY,
  match_id TEXT NOT NULL,
  market_type TEXT NOT NULL,
  market_name TEXT,
  previous_status TEXT,
  new_status TEXT NOT NULL,
  reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_suspension_audit_match_created
  ON public.suspension_audit_log (match_id, created_at DESC);

-- 5. Automated 24-Hour Result Match Purge Function
CREATE OR REPLACE FUNCTION public.purge_expired_match_results()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  deleted_count INTEGER := 0;
BEGIN
  DELETE FROM public.match_results
  WHERE expires_at <= NOW()
     OR completed_at <= (NOW() - INTERVAL '24 hours');

  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

-- Schedule hourly cleanup via pg_cron when available on Supabase tier
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule('betpro_purge_expired_match_results')
    WHERE EXISTS (
      SELECT 1 FROM cron.job WHERE jobname = 'betpro_purge_expired_match_results'
    );

    PERFORM cron.schedule(
      'betpro_purge_expired_match_results',
      '0 * * * *',
      'SELECT public.purge_expired_match_results();'
    );
  END IF;
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'pg_cron not enabled on this tier; backend sweeper handles 24h cleanup automatically.';
END $$;

-- 6. Strict Row Level Security & Explicit Role Grants (Service-role backend access)
GRANT USAGE ON SCHEMA public TO service_role;
GRANT ALL ON TABLE
  public.match_results,
  public.bet_settlement_archive,
  public.financial_ledger,
  public.suspension_audit_log
TO service_role;
GRANT EXECUTE ON FUNCTION public.purge_expired_match_results() TO service_role;

ALTER TABLE public.match_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bet_settlement_archive ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.financial_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.suspension_audit_log ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'match_results',
    'bet_settlement_archive',
    'financial_ledger',
    'suspension_audit_log'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS service_role_all ON public.%I;', tbl);
    EXECUTE format(
      'CREATE POLICY service_role_all ON public.%I FOR ALL TO service_role USING (true) WITH CHECK (true);',
      tbl
    );
  END LOOP;
END $$;
