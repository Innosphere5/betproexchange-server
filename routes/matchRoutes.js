const express = require('express');
const router = express.Router();
const Match = require('../models/Match');
const { shouldIncludeFixture } = require('../services/fixtureFilter');

// Helper to deduplicate matches by team names
function deduplicateMatches(matches) {
    const uniqueMap = new Map();
    for (const m of matches) {
        const mObj = m.toObject ? m.toObject() : m;
        const key = [mObj.teamA, mObj.teamB].sort().join('-');
        
        if (uniqueMap.has(key)) {
            const existing = uniqueMap.get(key);
            const mHasOdds = mObj.backOddsA != null;
            const existingHasOdds = existing.backOddsA != null;
            
            if (mObj.status === 'live' && existing.status !== 'live') {
                uniqueMap.set(key, mObj);
            } else if (mObj.status === existing.status) {
                if (mHasOdds && !existingHasOdds) {
                    uniqueMap.set(key, mObj);
                } else if (mHasOdds === existingHasOdds) {
                    if (new Date(mObj.startTime) > new Date(existing.startTime)) {
                        uniqueMap.set(key, mObj);
                    }
                }
            }
        } else {
            uniqueMap.set(key, mObj);
        }
    }
    return Array.from(uniqueMap.values());
}

// Get only live matches
router.get('/live', async (req, res) => {
    try {
        const liveMatches = await Match.find({ status: 'live' }).sort({ startTime: -1 });
        const now = new Date();
        const filtered = deduplicateMatches(liveMatches)
            .filter((match) => shouldIncludeFixture(match, now))
            .filter((match) => Boolean(match.backOddsA !== null || match.backOddsB !== null || match.layOddsA !== null || match.layOddsB !== null))
            .slice(0, 7);
        res.json(filtered);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// Get odds status dashboard
router.get('/odds-status', async (req, res) => {
    try {
        const matches = await Match.find({ status: { $in: ['live', 'upcoming'] } });
        const oddsApiLiveService = require('../services/oddsApiLiveService');
        
        const linkedMap = oddsApiLiveService.eventToMatchId;
        const metadataMap = oddsApiLiveService.eventMetadata;
        
        const linkedDetails = [];
        for (const [eventId, matchId] of linkedMap.entries()) {
            const meta = metadataMap.get(eventId) || {};
            linkedDetails.push({
                oddsApiEventId: eventId,
                matchId: matchId,
                teams: `${meta.home} v ${meta.away}`,
                isLive: meta.isLive
            });
        }

        const debugInfo = {
            totalActiveMatchesInDb: matches.length,
            totalLinkedFixtures: linkedMap.size,
            linkedFixtures: linkedDetails,
            unlinkedActiveMatches: matches.filter(m => !Array.from(linkedMap.values()).map(String).includes(String(m.matchId))).map(m => ({
                matchId: m.matchId,
                teamA: m.teamA,
                teamB: m.teamB,
                status: m.status,
                startTime: m.startTime
            }))
        };
        
        res.json(debugInfo);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// Get all matches
router.get('/', async (req, res) => {
    try {
        const matches = await Match.find().sort({ startTime: 1 });
        const now = new Date();
        const filtered = deduplicateMatches(matches)
            .filter((match) => shouldIncludeFixture(match, now))
            .filter((match) => Boolean(match.backOddsA !== null || match.backOddsB !== null || match.layOddsA !== null || match.layOddsB !== null || match.status === 'live'))
            .slice(0, 7);
        res.json(filtered);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// Get match by ID
router.get('/:id', async (req, res) => {
    try {
        const match = await Match.findOne({ matchId: req.params.id });
        if (!match) return res.status(404).json({ message: 'Match not found' });
        
        const response = match.toObject();
        if (match.status === 'completed') {
            response.api_message = "Match is completed and result has been declared.";
            response.isCompleted = true;
        } else {
            response.isCompleted = false;
        }

        res.json(response);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

module.exports = router;
