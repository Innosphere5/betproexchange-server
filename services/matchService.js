const Match = require('../models/Match');
const { getData } = require('./apiManager');

/**
 * fetchUpcomingMatches
 * 
 * Migrated to Sportmonks Cricket API v2.0.
 * Fetches fixtures for today and next 2 days.
 * Filters for IPL (5), PSL (3), and International (10, 11, 12).
 * Keeps only top 6 matches sorted by start time.
 */
const fetchUpcomingMatches = async (io) => {
    try {
        console.log('[MatchService] Syncing fixtures from Sportmonks v2 API...');

        // 1. Cleanup: Remove matches older than 24 hours
        const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const prunedOldCount = await Match.deleteMany({ startTime: { $lt: twentyFourHoursAgo } });
        if (prunedOldCount.deletedCount > 0) {
            console.log(`[MatchService] 🗑️ Cleaned ${prunedOldCount.deletedCount} matches older than 24h.`);
        }

        const today = new Date().toISOString().split('T')[0];
        const twoDaysLater = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

        const response = await getData('fixtures', {
            filter: {
                'filter[starts_between]': `${today},${twoDaysLater}`,
            },
            include: 'localteam,visitorteam,league'
        });

        if (!response || !Array.isArray(response.data)) {
            console.warn('[MatchService] No fixtures returned or API error.');
            return;
        }

        console.log(`[MatchService] Total matches from API: ${response.data.length}`);
        if (response.data.length > 0) {
            console.log(`[MatchService] Sample Data (First 3):`, response.data.slice(0, 3).map(f => ({ id: f.id, league: f.league?.name, status: f.status })));
        }

        const allowedLeagueIds = [1, 8, 2, 3, 4, 11, 17, 18, 41];
        
        // 3. Filter and Map
        let matches = response.data
            .filter(f => allowedLeagueIds.includes(f.league_id))
            .map(f => ({
                matchId:   f.id.toString(),
                leagueId:  f.league_id,
                teamA:     f.localteam?.name || 'Local Team',
                teamB:     f.visitorteam?.name || 'Visitor Team',
                league:    f.league?.name || 'Cricket',
                startTime: new Date(f.starting_at),
                status:    f.status === 'Live' ? 'live' : 'upcoming',
                sportKey:  'cricket_international', // Unified key for cricket
                lastUpdated: new Date()
            }));

        // 4. Sort and Limit (Top 5-6 upcoming/live matches)
        const upcomingOrLive = matches.filter(m => m.status !== 'completed');
        upcomingOrLive.sort((a, b) => a.startTime - b.startTime);
        const topMatches = upcomingOrLive.slice(0, 6);

        // Keep completed matches too (we'll fetch them separately or they exist in DB)
        // For now, let's just make sure we don't delete them if they were recently completed.
        
        const activeIds = topMatches.map(m => m.matchId);
        
        for (const m of topMatches) {
            // Upsert with default score if new
            await Match.findOneAndUpdate(
                { matchId: m.matchId },
                { 
                    $set: m,
                    $setOnInsert: {
                        score: { 
                            teamA_runs: '0/0', 
                            teamB_runs: '0/0', 
                            overs: '0.0', 
                            lastUpdated: new Date() 
                        }
                    }
                },
                { upsert: true, returnDocument: 'after' }
            );
        }

        // 5. Prune matches not in the top 6 active list AND not completed recently
        // We keep completed matches for 24 hours
        const deleteResult = await Match.deleteMany({
            matchId: { $nin: activeIds },
            $or: [
                { status: { $ne: 'completed' } },
                { status: 'completed', lastUpdated: { $lt: twentyFourHoursAgo } }
            ]
        });

        if (deleteResult.deletedCount > 0) {
            console.log(`[MatchService] 🗑️ Pruned ${deleteResult.deletedCount} old or inactive matches.`);
        }

        console.log(`[MatchService] ✅ Sync complete. Top Matches: ${activeIds.length}`);

        if (io) {
            const allMatches = await Match.find().sort({ startTime: 1 });
            io.emit('matches_updated', allMatches);
        }

    } catch (error) {
        console.error('[MatchService] Error during sync:', error.message);
    }
};

module.exports = { fetchUpcomingMatches };

