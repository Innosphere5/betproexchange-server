const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const Match = require('../models/Match');
const Bet = require('../models/Bet');
const User = require('../models/User');
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

// Get Match Bets & Exposure (Feature 1: P/L in green/red, Feature 2: Matched Bets for all users)
router.get('/:id/bets', async (req, res) => {
    try {
        const { id: matchId } = req.params;
        const match = await Match.findOne({ matchId }).lean();

        // 1. Authenticate user if token provided
        let currentUser = null;
        const authHeader = req.header('Authorization');
        if (authHeader) {
            try {
                const token = authHeader.replace('Bearer ', '').trim();
                currentUser = jwt.verify(token, process.env.JWT_SECRET);
            } catch (e) {
                // Token invalid or expired, continue as guest
            }
        }

        // 2. Query all active bets for this match
        const bets = await Bet.find({
            matchId,
            status: { $in: ['pending', 'MATCHED'] }
        }).sort({ createdAt: -1 }).lean();

        // 3. Resolve user details and master/parent usernames
        const userIds = [...new Set(bets.map(b => b.userId))];
        const users = await User.find({ username: { $in: userIds } }).select('username parentId role').lean();
        const parentIds = [...new Set(users.map(u => u.parentId).filter(Boolean))];
        const parents = await User.find({ _id: { $in: parentIds } }).select('username role').lean();

        const parentMap = {};
        parents.forEach(p => {
            parentMap[p._id.toString()] = p.username;
        });

        const userMap = {};
        users.forEach(u => {
            userMap[u.username] = {
                username: u.username,
                master: u.parentId ? (parentMap[u.parentId.toString()] || 'Direct') : 'Direct',
                role: u.role
            };
        });

        // 4. Format Matched Bets (Feature 2)
        const matchedBets = bets.map(b => ({
            id: b._id.toString(),
            runner: b.runner,
            price: b.odds,
            size: b.stake,
            better: b.userId,
            master: userMap[b.userId]?.master || 'Direct',
            type: b.type || 'back',
            marketType: b.marketType || 'match_odds',
            isLive: Boolean(b.isLive),
            status: b.status,
            createdAt: b.createdAt
        }));

        const openBets = [];

        // 5. Calculate Runner Exposures (Feature 1)
        const teamA = match ? match.teamA : null;
        const teamB = match ? match.teamB : null;
        const isLive = match ? match.status === 'live' : false;

        const userExposure = {};
        const adminExposure = {};

        if (teamA) {
            userExposure[teamA] = 0;
            adminExposure[teamA] = 0;
            userExposure[`${teamA} To Win The Toss`] = 0;
            adminExposure[`${teamA} To Win The Toss`] = 0;
            userExposure[`${teamA}_bm`] = 0;
            adminExposure[`${teamA}_bm`] = 0;
        }
        if (teamB) {
            userExposure[teamB] = 0;
            adminExposure[teamB] = 0;
            userExposure[`${teamB} To Win The Toss`] = 0;
            adminExposure[`${teamB} To Win The Toss`] = 0;
            userExposure[`${teamB}_bm`] = 0;
            adminExposure[`${teamB}_bm`] = 0;
        }

        const currentUsername = currentUser?.userId;
        const myBets = currentUsername ? bets.filter(b => b.userId === currentUsername) : [];

        // --- USER EXPOSURE CALCULATION (Feature 1) ---
        if (myBets.length > 0) {
            if (isLive) {
                // Live match: user backed team is in profit (+profit in green), opposing team is in loss (-stake in red)
                myBets.forEach(b => {
                    const isBack = b.type === 'back';
                    const odds = b.odds;
                    const stake = b.stake;
                    const profit = Math.round(stake * (odds - 1));

                    if (b.marketType === 'match_odds' || !b.marketType) {
                        [teamA, teamB].filter(Boolean).forEach(r => {
                            const isThis = b.runner?.trim().toLowerCase() === r?.trim().toLowerCase();
                            if (isBack) {
                                if (isThis) userExposure[r] = (userExposure[r] || 0) + profit;
                                else userExposure[r] = (userExposure[r] || 0) - stake;
                            } else {
                                if (isThis) userExposure[r] = (userExposure[r] || 0) - profit;
                                else userExposure[r] = (userExposure[r] || 0) + stake;
                            }
                        });
                    } else if (b.marketType === 'toss') {
                        const tossA = `${teamA} To Win The Toss`;
                        const tossB = `${teamB} To Win The Toss`;
                        [tossA, tossB].forEach(r => {
                            const isThis = b.runner?.trim().toLowerCase() === r?.trim().toLowerCase();
                            if (isBack) {
                                if (isThis) userExposure[r] = (userExposure[r] || 0) + profit;
                                else userExposure[r] = (userExposure[r] || 0) - stake;
                            } else {
                                if (isThis) userExposure[r] = (userExposure[r] || 0) - profit;
                                else userExposure[r] = (userExposure[r] || 0) + stake;
                            }
                        });
                    } else if (b.marketType === 'bookmaker') {
                        [teamA, teamB].filter(Boolean).forEach(r => {
                            const isThis = b.runner?.trim().toLowerCase() === r?.trim().toLowerCase() ||
                                           b.runner?.trim().toLowerCase() === `${r}_bm`.trim().toLowerCase();
                            const key = `${r}_bm`;
                            if (isBack) {
                                if (isThis) userExposure[key] = (userExposure[key] || 0) + profit;
                                else userExposure[key] = (userExposure[key] || 0) - stake;
                            } else {
                                if (isThis) userExposure[key] = (userExposure[key] || 0) - profit;
                                else userExposure[key] = (userExposure[key] || 0) + stake;
                            }
                        });
                    } else if (b.marketType === 'fancy') {
                        const key = b.runner;
                        if (isBack) {
                            userExposure[`${key}_yes`] = (userExposure[`${key}_yes`] || 0) + profit;
                            userExposure[`${key}_no`] = (userExposure[`${key}_no`] || 0) - stake;
                        } else {
                            userExposure[`${key}_yes`] = (userExposure[`${key}_yes`] || 0) - profit;
                            userExposure[`${key}_no`] = (userExposure[`${key}_no`] || 0) + stake;
                        }
                        userExposure[key] = (userExposure[key] || 0) + (isBack ? profit : -profit);
                    }
                });
            } else {
                // Not live match: "simple logic is that match is not live user bet on match and the amount show the bottom of that team like given image in red because the result not comes so it goes to red."
                myBets.forEach(b => {
                    const stake = b.stake;
                    if (b.marketType === 'match_odds' || !b.marketType) {
                        [teamA, teamB].filter(Boolean).forEach(r => {
                            const isThis = b.runner?.trim().toLowerCase() === r?.trim().toLowerCase();
                            if (isThis) {
                                userExposure[r] = (userExposure[r] || 0) - stake;
                            }
                        });
                    } else if (b.marketType === 'toss') {
                        const tossA = `${teamA} To Win The Toss`;
                        const tossB = `${teamB} To Win The Toss`;
                        [tossA, tossB].forEach(r => {
                            const isThis = b.runner?.trim().toLowerCase() === r?.trim().toLowerCase();
                            if (isThis) {
                                userExposure[r] = (userExposure[r] || 0) - stake;
                            }
                        });
                    } else if (b.marketType === 'bookmaker') {
                        [teamA, teamB].filter(Boolean).forEach(r => {
                            const isThis = b.runner?.trim().toLowerCase() === r?.trim().toLowerCase() ||
                                           b.runner?.trim().toLowerCase() === `${r}_bm`.trim().toLowerCase();
                            const key = `${r}_bm`;
                            if (isThis) {
                                userExposure[key] = (userExposure[key] || 0) - stake;
                            }
                        });
                    } else if (b.marketType === 'fancy') {
                        const key = b.runner;
                        userExposure[key] = (userExposure[key] || 0) - stake;
                        userExposure[`${key}_yes`] = (userExposure[`${key}_yes`] || 0) - stake;
                        userExposure[`${key}_no`] = (userExposure[`${key}_no`] || 0) - stake;
                    }
                });
            }
        }

        // --- ADMIN / BOOKMAKER EXPOSURE CALCULATION (All bets) ---
        bets.forEach(b => {
            const isBack = b.type === 'back';
            const odds = b.odds;
            const stake = b.stake;
            const profit = Math.round(stake * (odds - 1));

            if (b.marketType === 'match_odds' || !b.marketType) {
                [teamA, teamB].filter(Boolean).forEach(r => {
                    const isThis = b.runner?.trim().toLowerCase() === r?.trim().toLowerCase();
                    if (isLive) {
                        if (isBack) {
                            if (isThis) adminExposure[r] = (adminExposure[r] || 0) - profit;
                            else adminExposure[r] = (adminExposure[r] || 0) + stake;
                        } else {
                            if (isThis) adminExposure[r] = (adminExposure[r] || 0) + profit;
                            else adminExposure[r] = (adminExposure[r] || 0) - stake;
                        }
                    } else {
                        if (isThis) {
                            adminExposure[r] = (adminExposure[r] || 0) - stake;
                        }
                    }
                });
            } else if (b.marketType === 'toss') {
                const tossA = `${teamA} To Win The Toss`;
                const tossB = `${teamB} To Win The Toss`;
                [tossA, tossB].forEach(r => {
                    const isThis = b.runner?.trim().toLowerCase() === r?.trim().toLowerCase();
                    if (isLive) {
                        if (isBack) {
                            if (isThis) adminExposure[r] = (adminExposure[r] || 0) - profit;
                            else adminExposure[r] = (adminExposure[r] || 0) + stake;
                        } else {
                            if (isThis) adminExposure[r] = (adminExposure[r] || 0) + profit;
                            else adminExposure[r] = (adminExposure[r] || 0) - stake;
                        }
                    } else {
                        if (isThis) {
                            adminExposure[r] = (adminExposure[r] || 0) - stake;
                        }
                    }
                });
            } else if (b.marketType === 'bookmaker') {
                [teamA, teamB].filter(Boolean).forEach(r => {
                    const isThis = b.runner?.trim().toLowerCase() === r?.trim().toLowerCase() ||
                                   b.runner?.trim().toLowerCase() === `${r}_bm`.trim().toLowerCase();
                    const key = `${r}_bm`;
                    if (isLive) {
                        if (isBack) {
                            if (isThis) adminExposure[key] = (adminExposure[key] || 0) - profit;
                            else adminExposure[key] = (adminExposure[key] || 0) + stake;
                        } else {
                            if (isThis) adminExposure[key] = (adminExposure[key] || 0) + profit;
                            else adminExposure[key] = (adminExposure[key] || 0) - stake;
                        }
                    } else {
                        if (isThis) {
                            adminExposure[key] = (adminExposure[key] || 0) - stake;
                        }
                    }
                });
            } else if (b.marketType === 'fancy') {
                const key = b.runner;
                if (isLive) {
                    if (isBack) {
                        adminExposure[`${key}_yes`] = (adminExposure[`${key}_yes`] || 0) - profit;
                        adminExposure[`${key}_no`] = (adminExposure[`${key}_no`] || 0) + stake;
                    } else {
                        adminExposure[`${key}_yes`] = (adminExposure[`${key}_yes`] || 0) + profit;
                        adminExposure[`${key}_no`] = (adminExposure[`${key}_no`] || 0) - stake;
                    }
                } else {
                    adminExposure[key] = (adminExposure[key] || 0) - stake;
                    adminExposure[`${key}_yes`] = (adminExposure[`${key}_yes`] || 0) - stake;
                    adminExposure[`${key}_no`] = (adminExposure[`${key}_no`] || 0) - stake;
                }
            }
        });

        const isAdmin = ['superadmin', 'admin', 'master', 'supermaster'].includes(currentUser?.role);
        const primaryExposure = myBets.length > 0 ? userExposure : (isAdmin ? adminExposure : userExposure);

        res.json({
            matchId,
            matchName: match ? `${match.teamA} v ${match.teamB}` : '',
            status: match?.status || 'upcoming',
            isLive,
            matchedBets,
            openBets,
            totalMatched: matchedBets.length,
            totalOpen: openBets.length,
            exposure: primaryExposure,
            userExposure,
            adminExposure
        });
    } catch (error) {
        console.error("Error in /api/matches/:id/bets:", error);
        res.status(500).json({ message: error.message });
    }
});

module.exports = router;
