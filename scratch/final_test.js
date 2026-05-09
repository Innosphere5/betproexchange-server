const mongoose = require('mongoose');
const User = require('../models/User');
const Bet = require('../models/Bet');
const Match = require('../models/Match');

async function test() {
    await mongoose.connect('mongodb+srv://gagndeep0101_db_user:gagan_user@betpro.v2ovyxx.mongodb.net/?retryWrites=true&w=majority&appName=betpro');
    
    // Simulate SuperAdmin role
    const activeMatches = await Match.find({ status: { $in: ['scheduled', 'live', 'upcoming'] } }).select('matchId teamA teamB backOddsA backOddsB layOddsA layOddsB').lean();
    const matchIds = activeMatches.map(m => m.matchId);
    
    let matchStatsQuery = { matchId: { $in: matchIds }, status: { $in: ['MATCHED', 'pending'] } };
    
    const bets = await Bet.find(matchStatsQuery).lean();
    console.log(`Found ${bets.length} bets total.`);
    
    const uniqueUserIds = [...new Set(bets.map(b => b.userId))];
    const betUsers = await User.find({ username: { $in: uniqueUserIds } }).lean();
    
    const parentIds = [...new Set(betUsers.filter(u => u.parentId).map(u => u.parentId))];
    const parentUsers = await User.find({ _id: { $in: parentIds } }).lean();
    
    const parentMap = {};
    parentUsers.forEach(p => { parentMap[p._id.toString()] = p.username; });

    const userMap = {};
    betUsers.forEach(u => {
      userMap[u.username] = {
        ...u,
        parentName: u.parentId ? parentMap[u.parentId.toString()] : 'Direct'
      };
    });

    const results = [];
    for (const m of activeMatches) {
        const runners = [m.teamA, m.teamB];
        const matchBets = bets.filter(b => b.matchId === m.matchId);
        
        runners.forEach(r => {
            let exposure = 0;
            matchBets.forEach(b => {
                const { runner, odds, stake, type } = b;
                const nR = runner?.trim().toLowerCase();
                const nTarget = r?.trim().toLowerCase();
                if (type === 'back') {
                    if (nR === nTarget) exposure -= (odds - 1) * stake;
                    else exposure += stake;
                } else {
                    if (nR === nTarget) exposure += (odds - 1) * stake;
                    else exposure -= stake;
                }
            });
            
            const runnerBets = matchBets.filter(b => b.runner?.trim().toLowerCase() === r?.trim().toLowerCase());
            
            results.push({
                matchId: m.matchId,
                name: r,
                amount: exposure,
                bets: runnerBets.length
            });
        });
    }

    const rr = results.find(res => res.name === 'Rajasthan Royals');
    console.log(`RR Result:`, JSON.stringify(rr));
    
    process.exit(0);
}

test();
