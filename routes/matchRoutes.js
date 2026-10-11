const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const Match = require('../models/Match');
const Bet = require('../models/Bet');
const User = require('../models/User');
const { shouldIncludeFixture } = require('../services/fixtureFilter');
const { SIDE, FANCY, oddsBet, oddsBook, fancyBet, fancyBook, accountSummary } = require('../utils/betCalc');
const { getViewerNetShare, getAllDescendantUsernames, findUserByKey } = require('../services/hierarchyHelper');

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
        let match = await Match.findOne({ matchId: req.params.id });
        if (!match && mongoose.Types.ObjectId.isValid(req.params.id)) {
            match = await Match.findById(req.params.id);
        }
        if (!match) {
            // Check if bets exist for this matchId
            const sampleBet = await Bet.findOne({ matchId: req.params.id }).lean();
            if (sampleBet) {
                let teamA = 'Team A';
                let teamB = 'Team B';
                if (sampleBet.matchName && (sampleBet.matchName.includes(' v ') || sampleBet.matchName.includes(' vs '))) {
                    const sep = sampleBet.matchName.includes(' v ') ? ' v ' : ' vs ';
                    const parts = sampleBet.matchName.split(sep);
                    teamA = parts[0]?.trim() || teamA;
                    teamB = parts[1]?.trim() || teamB;
                } else if (sampleBet.runner) {
                    teamA = sampleBet.runner;
                }
                const reconstructed = {
                    matchId: req.params.id,
                    name: sampleBet.matchName || `${teamA} v ${teamB}`,
                    teamA,
                    teamB,
                    league: 'Cricket Match',
                    status: 'live',
                    inplay: true,
                    backOddsA: sampleBet.odds || 1.95,
                    layOddsA: sampleBet.odds ? Number((Number(sampleBet.odds) + 0.02).toFixed(2)) : 1.97,
                    backOddsB: 2.05,
                    layOddsB: 2.08,
                    startTime: new Date(),
                    score: {
                        teamA_runs: '188',
                        teamA_wickets: '3',
                        overs: '18',
                        crr: '10.44',
                        thisOver: '1 1 4 4 1 1',
                        overRuns: '12'
                    },
                    toObject: function() { return this; }
                };
                return res.json(reconstructed);
            }
            return res.status(404).json({ message: 'Match not found' });
        }
        
        // Ensure Fancy 2, Figure, Even-Odd, and Tied Match markets only exist for LIVE matches
        if (match.status === 'live' || match.inplay === true) {
            const fancyMarketsService = require('../services/fancyMarketsService');
            match = await fancyMarketsService.ensureMatchMarkets(match, req.app.get('io'));
        } else {
            // Upcoming or completed matches do NOT show in-play fancy/figure/even-odd/tied markets
            if (match.fancyMarkets?.length > 0 || match.figureMarkets?.length > 0 || match.evenOddMarkets?.length > 0 || match.tiedMatchMarket) {
                match.fancyMarkets = [];
                match.figureMarkets = [];
                match.evenOddMarkets = [];
                match.tiedMatchMarket = null;
                await Match.updateOne(
                    { matchId: match.matchId },
                    { $set: { fancyMarkets: [], figureMarkets: [], evenOddMarkets: [], tiedMatchMarket: null } }
                ).catch(() => {});
            }
        }

        const response = match.toObject ? match.toObject() : match;
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
        let match = await Match.findOne({ matchId }).lean();
        if (!match && mongoose.Types.ObjectId.isValid(matchId)) {
            match = await Match.findById(matchId).lean();
        }

        // Reconstruct fallback match doc from bets if not present in collection
        if (!match) {
            const betSample = await Bet.findOne({ matchId }).lean();
            if (betSample) {
                let fallbackTeamA = 'Team A';
                let fallbackTeamB = 'Team B';
                if (betSample.matchName && (betSample.matchName.includes(' v ') || betSample.matchName.includes(' vs '))) {
                    const sep = betSample.matchName.includes(' v ') ? ' v ' : ' vs ';
                    const parts = betSample.matchName.split(sep);
                    fallbackTeamA = parts[0]?.trim() || fallbackTeamA;
                    fallbackTeamB = parts[1]?.trim() || fallbackTeamB;
                } else if (betSample.runner) {
                    fallbackTeamA = betSample.runner;
                }
                match = {
                    matchId,
                    title: betSample.matchName || `${fallbackTeamA} v ${fallbackTeamB}`,
                    name: betSample.matchName || `${fallbackTeamA} v ${fallbackTeamB}`,
                    teamA: fallbackTeamA,
                    teamB: fallbackTeamB,
                    status: 'live',
                    sport: betSample.sport || 'Cricket'
                };
            }
        }

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

        let viewerUser = null;
        if (currentUser?.userId) {
            viewerUser = await findUserByKey(currentUser.userId) || await User.findOne({ username: currentUser.userId }).lean();
        }

        const isAdmin = Boolean(viewerUser && ['superadmin', 'admin', 'master', 'supermaster'].includes(viewerUser.role));

        // 2. Query bets for this match
        let betQuery = { matchId, status: { $in: ['pending', 'MATCHED'] } };
        let allowedUsernames = null;

        if (isAdmin && viewerUser) {
            allowedUsernames = await getAllDescendantUsernames(viewerUser);
            betQuery.userId = { $in: allowedUsernames };
        }

        const bets = await Bet.find(betQuery).sort({ createdAt: -1 }).lean();

        // 3. Resolve user details and master/parent usernames
        const userIds = [...new Set(bets.map(b => b.userId).filter(Boolean))];
        const users = await User.find({ username: { $in: userIds } }).select('username parentId role share').lean();

        const userMap = {};
        if (viewerUser) {
            userMap[viewerUser._id.toString()] = viewerUser;
            userMap[viewerUser.username] = viewerUser;
            userMap[viewerUser.username.toLowerCase()] = viewerUser;
        }
        users.forEach(u => {
            userMap[u._id.toString()] = u;
            userMap[u.username] = u;
            userMap[u.username.toLowerCase()] = u;
        });

        let parentIdsToFetch = users.map(u => u.parentId).filter(pid => pid && !userMap[pid.toString()]);
        while (parentIdsToFetch.length > 0) {
            const fetchedAncestors = await User.find({ _id: { $in: parentIdsToFetch } }).select('username parentId role share').lean();
            parentIdsToFetch = [];
            fetchedAncestors.forEach(a => {
                userMap[a._id.toString()] = a;
                userMap[a.username] = a;
                userMap[a.username.toLowerCase()] = a;
                if (a.parentId && !userMap[a.parentId.toString()]) {
                    parentIdsToFetch.push(a.parentId);
                }
            });
        }

        // 4. Format Matched Bets with hierarchy share
        const matchedBets = bets.map(b => {
            const bettorDoc = userMap[b.userId?.toLowerCase()] || userMap[b.userId];
            const netShare = (isAdmin && viewerUser && bettorDoc) ? getViewerNetShare(viewerUser, bettorDoc, userMap) : null;
            const parentStake = netShare != null ? Math.round((Number(b.stake) || 0) * (netShare / 100)) : (Number(b.stake) || 0);

            return {
                id: b._id.toString(),
                runner: b.runner,
                price: b.odds,
                size: b.stake,
                stake: b.stake,
                sharePercent: netShare,
                parentStake,
                better: b.userId,
                master: bettorDoc?.parentId ? (userMap[bettorDoc.parentId.toString()]?.username || 'Direct') : 'Direct',
                type: b.type || 'back',
                marketType: b.marketType || 'match_odds',
                line: b.line,
                isLive: Boolean(b.isLive),
                status: b.status,
                createdAt: b.createdAt
            };
        });

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

        // Helper function to calculate book using betCalc
        function calculateBookForBets(betList, isAdminPerspective = false) {
            const expMap = {};
            const marketExposures = [];

            const moBets = [];
            const bmBets = [];
            const tossBets = [];
            const tiedBets = [];
            const figBetsByMarket = {};
            const eoBetsByMarket = {};
            const fancyBetsByMarket = {};

            betList.forEach(b => {
                const mType = b.marketType || 'match_odds';
                if (mType === 'match_odds') moBets.push(b);
                else if (mType === 'bookmaker') bmBets.push(b);
                else if (mType === 'toss') tossBets.push(b);
                else if (mType === 'tied_match') tiedBets.push(b);
                else if (mType === 'figure') {
                    const figName = b.runner ? b.runner.split(' - ')[0] : 'Figure';
                    if (!figBetsByMarket[figName]) figBetsByMarket[figName] = [];
                    figBetsByMarket[figName].push(b);
                } else if (mType === 'even_odd') {
                    const eoName = b.runner ? b.runner.split(' - ')[0] : 'Even/Odd';
                    if (!eoBetsByMarket[eoName]) eoBetsByMarket[eoName] = [];
                    eoBetsByMarket[eoName].push(b);
                } else if (mType === 'fancy') {
                    const fName = b.runner;
                    if (!fancyBetsByMarket[fName]) fancyBetsByMarket[fName] = [];
                    fancyBetsByMarket[fName].push(b);
                }
            });

            function getEffectiveStake(b) {
                if (isAdminPerspective && viewerUser) {
                    const bettorDoc = userMap[b.userId?.toLowerCase()] || userMap[b.userId];
                    const netShare = getViewerNetShare(viewerUser, bettorDoc, userMap);
                    if (netShare <= 0) return 0;
                    return Math.round((Number(b.stake) || 0) * (netShare / 100));
                }
                return Math.round(Number(b.stake) || 0);
            }

            // 1. Match Odds
            if (moBets.length > 0 && teamA && teamB) {
                const outcomes = [teamA, teamB];
                const calcBets = [];
                moBets.forEach(b => {
                    const st = getEffectiveStake(b);
                    if (st <= 0) return;
                    try {
                        let side = (b.type || 'back').toUpperCase();
                        if (isAdminPerspective) side = (side === 'BACK' ? 'LAY' : 'BACK');
                        const matchedSel = outcomes.find(o => o.trim().toLowerCase() === (b.runner || '').trim().toLowerCase()) || b.runner;
                        calcBets.push(oddsBet({
                            side: side === 'LAY' ? SIDE.LAY : SIDE.BACK,
                            selection: matchedSel,
                            stake: st,
                            odds: Number(b.odds) || 2
                        }));
                    } catch (e) {}
                });
                if (calcBets.length > 0) {
                    const book = oddsBook(calcBets, outcomes);
                    outcomes.forEach(out => {
                        expMap[out] = book.pl[out] || 0;
                    });
                    if (book.exposure > 0) marketExposures.push(book.exposure);
                }
            }

            // 2. Bookmaker
            if (bmBets.length > 0 && teamA && teamB) {
                const keyA = `${teamA}_bm`;
                const keyB = `${teamB}_bm`;
                const outcomes = [keyA, keyB];
                const calcBets = [];
                bmBets.forEach(b => {
                    const st = getEffectiveStake(b);
                    if (st <= 0) return;
                    try {
                        let side = (b.type || 'back').toUpperCase();
                        if (isAdminPerspective) side = (side === 'BACK' ? 'LAY' : 'BACK');
                        let sel = b.runner;
                        if (sel?.trim().toLowerCase() === teamA?.trim().toLowerCase()) sel = keyA;
                        else if (sel?.trim().toLowerCase() === teamB?.trim().toLowerCase()) sel = keyB;
                        calcBets.push(oddsBet({
                            side: side === 'LAY' ? SIDE.LAY : SIDE.BACK,
                            selection: sel,
                            stake: st,
                            odds: Number(b.odds) || 2
                        }));
                    } catch (e) {}
                });
                if (calcBets.length > 0) {
                    const book = oddsBook(calcBets, outcomes);
                    expMap[keyA] = book.pl[keyA] || 0;
                    expMap[keyB] = book.pl[keyB] || 0;
                    if (expMap[teamA] === undefined) expMap[teamA] = book.pl[keyA] || 0;
                    if (expMap[teamB] === undefined) expMap[teamB] = book.pl[keyB] || 0;
                    if (book.exposure > 0) marketExposures.push(book.exposure);
                }
            }

            // 3. Toss
            if (tossBets.length > 0 && teamA && teamB) {
                const tossA = `${teamA} To Win The Toss`;
                const tossB = `${teamB} To Win The Toss`;
                const outcomes = [tossA, tossB];
                const calcBets = [];
                tossBets.forEach(b => {
                    const st = getEffectiveStake(b);
                    if (st <= 0) return;
                    try {
                        let side = (b.type || 'back').toUpperCase();
                        if (isAdminPerspective) side = (side === 'BACK' ? 'LAY' : 'BACK');
                        calcBets.push(oddsBet({
                            side: side === 'LAY' ? SIDE.LAY : SIDE.BACK,
                            selection: b.runner,
                            stake: st,
                            odds: Number(b.odds) || 2
                        }));
                    } catch (e) {}
                });
                if (calcBets.length > 0) {
                    const book = oddsBook(calcBets, outcomes);
                    expMap[tossA] = book.pl[tossA] || 0;
                    expMap[tossB] = book.pl[tossB] || 0;
                    if (book.exposure > 0) marketExposures.push(book.exposure);
                }
            }

            // 4. Tied Match
            if (tiedBets.length > 0) {
                const outcomes = ['tied_yes', 'tied_no'];
                const calcBets = [];
                tiedBets.forEach(b => {
                    const st = getEffectiveStake(b);
                    if (st <= 0) return;
                    try {
                        let side = (b.type || 'back').toUpperCase();
                        if (isAdminPerspective) side = (side === 'BACK' ? 'LAY' : 'BACK');
                        const isYes = String(b.runner).toLowerCase().includes('yes');
                        calcBets.push(oddsBet({
                            side: side === 'LAY' ? SIDE.LAY : SIDE.BACK,
                            selection: isYes ? 'tied_yes' : 'tied_no',
                            stake: st,
                            odds: Number(b.odds) || 2
                        }));
                    } catch (e) {}
                });
                if (calcBets.length > 0) {
                    const book = oddsBook(calcBets, outcomes);
                    expMap['tied_yes'] = book.pl['tied_yes'] || 0;
                    expMap['tied_no'] = book.pl['tied_no'] || 0;
                    expMap['Yes'] = book.pl['tied_yes'] || 0;
                    expMap['No'] = book.pl['tied_no'] || 0;
                    if (book.exposure > 0) marketExposures.push(book.exposure);
                }
            }

            // 5. Figure Markets (0-9 Digits)
            Object.entries(figBetsByMarket).forEach(([figName, fBets]) => {
                const digits = ['0','1','2','3','4','5','6','7','8','9'];
                const calcBets = [];
                fBets.forEach(b => {
                    const st = getEffectiveStake(b);
                    if (st <= 0) return;
                    try {
                        let side = (b.type || 'back').toUpperCase();
                        if (isAdminPerspective) side = (side === 'BACK' ? 'LAY' : 'BACK');
                        const digitMatch = String(b.runner).match(/\d+/);
                        const sel = digitMatch ? digitMatch[0] : '0';
                        calcBets.push(oddsBet({
                            side: side === 'LAY' ? SIDE.LAY : SIDE.BACK,
                            selection: sel,
                            stake: st,
                            odds: Number(b.odds) || 8.85
                        }));
                    } catch (e) {}
                });
                if (calcBets.length > 0) {
                    const book = oddsBook(calcBets, digits);
                    digits.forEach(d => {
                        expMap[`${figName} - Digit ${d}`] = book.pl[d] || 0;
                        expMap[`${figName}_${d}`] = book.pl[d] || 0;
                        expMap[`digit_${d}`] = book.pl[d] || 0;
                    });
                    if (book.exposure > 0) marketExposures.push(book.exposure);
                }
            });

            // 6. Even / Odd Markets
            Object.entries(eoBetsByMarket).forEach(([eoName, eBets]) => {
                const outcomes = ['EVEN', 'ODD'];
                const calcBets = [];
                eBets.forEach(b => {
                    const st = getEffectiveStake(b);
                    if (st <= 0) return;
                    try {
                        let side = (b.type || 'back').toUpperCase();
                        if (isAdminPerspective) side = (side === 'BACK' ? 'LAY' : 'BACK');
                        const isEven = String(b.runner).toUpperCase().includes('EVEN');
                        calcBets.push(oddsBet({
                            side: side === 'LAY' ? SIDE.LAY : SIDE.BACK,
                            selection: isEven ? 'EVEN' : 'ODD',
                            stake: st,
                            odds: Number(b.odds) || 1.98
                        }));
                    } catch (e) {}
                });
                if (calcBets.length > 0) {
                    const book = oddsBook(calcBets, outcomes);
                    expMap[`${eoName}_even`] = book.pl['EVEN'] || 0;
                    expMap[`${eoName}_odd`] = book.pl['ODD'] || 0;
                    expMap[`${eoName}_yes`] = book.pl['ODD'] || 0;
                    expMap[`${eoName}_no`] = book.pl['EVEN'] || 0;
                    expMap[eoName] = book.pl['ODD'] || book.pl['EVEN'] || 0;
                    if (book.exposure > 0) marketExposures.push(book.exposure);
                }
            });

            // 7. Fancy / Session Markets (Dual Yes / No display)
            Object.entries(fancyBetsByMarket).forEach(([fName, fBets]) => {
                let netYes = 0;
                let netNo = 0;
                fBets.forEach(b => {
                    const st = getEffectiveStake(b);
                    if (st <= 0) return;
                    try {
                        let side = b.type === 'lay' ? FANCY.NO : FANCY.YES;
                        if (isAdminPerspective) side = (side === FANCY.YES ? FANCY.NO : FANCY.YES);
                        const line = Number.isInteger(Number(b.line)) ? parseInt(b.line) : 50;
                        const rate = Math.round(Number(b.odds) * 100) > 100 ? Math.round(Number(b.odds) * 100) : 100;
                        const fBet = fancyBet({
                            side,
                            line,
                            rate: Math.min(rate, 200),
                            stake: st
                        });
                        netYes += fancyBetPL(fBet, line);
                        netNo += fancyBetPL(fBet, line - 1);
                    } catch (e) {}
                });
                expMap[`${fName}_yes`] = netYes;
                expMap[`${fName}_no`] = netNo;
                expMap[fName] = netYes;
                const mExp = Math.max(0, -Math.min(netYes, netNo));
                if (mExp > 0) marketExposures.push(mExp);
            });

            const worstTotal = marketExposures.reduce((a, b) => a + b, 0);
            return { expMap, marketExposures, totalExposure: worstTotal };
        }

        // --- USER EXPOSURE CALCULATION (Feature 1) ---
        if (myBets.length > 0) {
            const userCalc = calculateBookForBets(myBets, false);
            Object.assign(userExposure, userCalc.expMap);
        }

        // --- ADMIN / BOOKMAKER EXPOSURE CALCULATION (Descendant Bets & Hierarchy Net Share) ---
        if (bets.length > 0) {
            const adminCalc = calculateBookForBets(bets, true);
            Object.assign(adminExposure, adminCalc.expMap);
        }

        const primaryExposure = isAdmin ? adminExposure : (myBets.length > 0 ? userExposure : adminExposure);

        res.json({
            matchId,
            matchName: match ? `${match.teamA} v ${match.teamB}` : (teamA && teamB ? `${teamA} v ${teamB}` : (bets[0]?.matchName || '')),
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
