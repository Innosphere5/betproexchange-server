const Match = require('../models/Match');
const { getEvents } = require('./apiManager');

/**
 * updateLiveScores
 * 
 * Fetches live scores for all supported cricket categories.
 * Maps v4 score structure (array of {name, score}) to our database format.
 */
const updateLiveScores = async (io) => {
    try {
        const liveMatches = await Match.find({ status: 'live' });

        if (liveMatches.length === 0) {
            return;
        }

        const sportsToFetch = [
            'cricket_ipl',
            'cricket_psl',
            'cricket_test_match',
            'cricket_odi',
            'cricket_international_t20'
        ];

        let allScoreData = [];

        for (const sport of sportsToFetch) {
            const data = await getEvents(sport, 'scores');
            if (Array.isArray(data)) {
                allScoreData = [...allScoreData, ...data];
            }
        }

        if (allScoreData.length === 0) return;

        let updatedCount = 0;

        for (const match of liveMatches) {
            const freshMatch = allScoreData.find(e => e.id?.toString() === match.matchId);

            if (freshMatch && freshMatch.scores) {
                // v4 scores format: [{ name: "Team A", score: "100" }, { name: "Team B", score: "50" }]
                const homeScoreObj = freshMatch.scores.find(s => s.name === freshMatch.home_team);
                const awayScoreObj = freshMatch.scores.find(s => s.name === freshMatch.away_team);

                const newScore = {
                    home: homeScoreObj ? homeScoreObj.score : (match.score?.home || '0/0'),
                    away: awayScoreObj ? awayScoreObj.score : (match.score?.away || '0/0')
                };

                // Only update if something changed
                if (newScore.home !== match.score?.home || newScore.away !== match.score?.away) {
                    await Match.updateOne(
                        { matchId: match.matchId },
                        {
                            $set: {
                                score:       newScore,
                                lastUpdated: new Date()
                            }
                        }
                    );
                    updatedCount++;
                }
            }
        }

        if (updatedCount > 0 && io) {
            console.log(`[ScoreService] Updated scores for ${updatedCount} matches.`);
            const allMatches = await Match.find().sort({ startTime: 1 });
            io.emit('matches_updated', allMatches);
        } else if (liveMatches.length > 0 && io) {
            // Even if score didn't change, sync the 'live' state occasionally
            const allMatches = await Match.find().sort({ startTime: 1 });
            io.emit('matches_updated', allMatches);
        }

    } catch (error) {
        console.error('[ScoreService] Error updating scores:', error.message);
    }
};

module.exports = { updateLiveScores };

