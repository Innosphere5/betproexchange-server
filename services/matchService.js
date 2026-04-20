const Match = require('../models/Match');
const { getEvents } = require('./apiManager');

/**
 * fetchUpcomingMatches
 * 
 * Migrated to the-odds-api.com v4.
 * Fetches IPL, Pakistan (PSL), and International Men's matches.
 * Automatically prunes old matches no longer in the API.
 */
const fetchUpcomingMatches = async (io) => {
    try {
        console.log('[MatchService] Syncing matches from v4 API...');

        const sportsToFetch = [
            'cricket_ipl',
            'cricket_psl',
            'cricket_test_match',
            'cricket_odi',
            'cricket_international_t20'
        ];

        let allFetchedMatches = [];

        for (const sport of sportsToFetch) {
            const data = await getEvents(sport, 'events');
            if (Array.isArray(data)) {
                allFetchedMatches = [...allFetchedMatches, ...data];
            }
        }

        if (allFetchedMatches.length === 0) {
            console.warn('[MatchService] No matches returned from API.');
            return;
        }

        const now = new Date();
        const activeIds = new Set();

        for (const event of allFetchedMatches) {
            const matchId = event.id.toString();
            activeIds.add(matchId);

            const startTime = new Date(event.commence_time);
            const isLive = startTime <= now;

            const matchData = {
                matchId:     matchId,
                teamA:       event.home_team,
                teamB:       event.away_team,
                league:      event.sport_title || 'Cricket',
                sportKey:    event.sport_key,
                startTime:   startTime,
                status:      isLive ? 'live' : 'upcoming',
                score: { 
                    teamA_runs: '0/0', 
                    teamB_runs: '0/0', 
                    overs: '0.0', 
                    lastUpdated: new Date() 
                },
                lastUpdated: new Date(),
            };

            await Match.findOneAndUpdate(
                { matchId: matchData.matchId },
                { $set: matchData },
                { upsert: true, new: true }
            );
        }

        // --- Pruning Logic ---
        // Remove matches that are no longer in the API (old/previous matches)
        const deleteResult = await Match.deleteMany({
            matchId: { $nin: Array.from(activeIds) }
        });

        if (deleteResult.deletedCount > 0) {
            console.log(`[MatchService] 🗑️ Pruned ${deleteResult.deletedCount} old matches.`);
        }

        console.log(`[MatchService] ✅ Sync complete. Active matches: ${activeIds.size}`);

        if (io) {
            const allMatches = await Match.find().sort({ startTime: 1 });
            io.emit('matches_updated', allMatches);
        }

    } catch (error) {
        console.error('[MatchService] Error during sync:', error.message);
    }
};

module.exports = { fetchUpcomingMatches };

