const Match = require('../models/Match');
const { getData } = require('./apiManager');

/**
 * fetchUpcomingMatches
 * 
 * Migrated to Sportmonks Cricket API v2.0.
 * Fetches fixtures for today and next 2 days.
 * Filters for International Matches (Men/Women, ODI/T20/Test/World Cups/Asia Cup).
 * Removed IPL and PSL focus.
 * Keeps only top 6 matches sorted by start time.
 */
const fetchUpcomingMatches = async (io) => {
    try {
        console.log('[MatchService] Syncing fixtures from Sportmonks v2 API...');

        // 1. Midnight Reset: Remove all matches from previous days (except LIVE)
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);

        const prunedOldCount = await Match.deleteMany({
            startTime: { $lt: todayStart },
            status: { $ne: 'live' }
        });

        if (prunedOldCount.deletedCount > 0) {
            console.log(`[MatchService] 🗑️ Midnight Reset: Cleaned ${prunedOldCount.deletedCount} previous matches.`);
        }

        const today = new Date().toISOString().split('T')[0];
        const lookaheadDays = 7;
        const endDate = new Date(Date.now() + lookaheadDays * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

        const response = await getData('fixtures', {
            filter: {
                'filter[starts_between]': `${today},${endDate}`,
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

        // Focused on International (Men and Women)
        const allowedLeagueIds = [2, 3, 4, 11, 12, 16, 17, 18, 19, 35, 41, 86, 141, 201, 258, 261];

        // 3. Filter and Map
        let matches = response.data
            .filter(f => allowedLeagueIds.includes(f.league_id))
            .map(f => ({
                matchId: f.id.toString(),
                leagueId: f.league_id,
                teamA: f.localteam?.name || 'Local Team',
                teamB: f.visitorteam?.name || 'Visitor Team',
                league: f.league?.name || 'Cricket',
                startTime: new Date(f.starting_at),
                status: f.status === 'Live' ? 'live' : 'upcoming',
                sportKey: 'cricket_international', // Unified key for cricket
                lastUpdated: new Date()
            }));

        // 4. Sort and Store (All today's matches + next 10 upcoming)
        const upcomingOrLive = matches.filter(m => m.status !== 'completed');
        upcomingOrLive.sort((a, b) => a.startTime - b.startTime);

        const todayEnd = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);
        const todayMatches = upcomingOrLive.filter(m => m.startTime < todayEnd);
        const futureMatches = upcomingOrLive.filter(m => m.startTime >= todayEnd).slice(0, 30);

        const topMatches = [...todayMatches, ...futureMatches];

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

        // 5. Final Pruning: Remove matches not in the fresh fetch
        // We remove them if they are for yesterday/past or if they are NOT in the fresh active list.
        // Special case: If a match is 'live' in DB but NOT in the activeIds, and it's old, prune it.
        const staleLiveTime = new Date(Date.now() - 12 * 60 * 60 * 1000); // 12 hours ago
        
        const deleteResult = await Match.deleteMany({
            matchId: { $nin: activeIds },
            $or: [
                { startTime: { $lt: todayStart } }, // Yesterday's matches
                { status: 'completed' },             // Any completed match not in the fresh list
                { status: 'live', startTime: { $lt: staleLiveTime } } // Ghost matches like Romania v Bulgaria
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

