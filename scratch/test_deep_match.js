const mongoose = require('mongoose');
require('dotenv').config();
const Match = require('../models/Match');
const oddsApiService = require('../services/oddsApiService');

const normalize = (name) => {
    if (!name) return "";
    let n = name.toLowerCase().trim();
    n = n.replace(/\bwomen\b/g, "w");
    n = n.replace(/\bteam\b/g, "");
    n = n.replace(/\bcricket\b/g, "");
    n = n.replace(/\bnational\b/g, "");
    n = n.replace(/\bmen\b/g, "");
    n = n.replace(/\bxi\b/g, "");
    n = n.replace(/[^a-z0-9\s]/g, ""); 
    n = n.replace(/\s+/g, ""); 
    const aliases = { "royalchallengers": "rcb", "bengaluru": "rcb", "bangalore": "rcb", "lucknow": "lsg", "sunrisers": "srh", "mumbaiindians": "mi", "chennaisuperkings": "csk", "delhicapitals": "dc", "rajasthanroyals": "rr", "gujarattitans": "gt", "kolkataknightriders": "kkr", "punjabkings": "pbks" };
    for (const [key, value] of Object.entries(aliases)) { if (n.includes(key)) return value; }
    return n;
};

async function testDeepMatch() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        const dbMatches = await Match.find({ status: { $in: ['live', 'upcoming'] } });
        console.log(`DB Matches: ${dbMatches.map(m => `${m.teamA} (${normalize(m.teamA)}) v ${m.teamB} (${normalize(m.teamB)})`).join(' | ')}`);

        const data = await oddsApiService.fetch('events', { sport: 'cricket', status: 'pending,live' });
        
        if (Array.isArray(data)) {
            data.forEach(event => {
                const apiHome = normalize(event.home);
                const apiAway = normalize(event.away);
                
                dbMatches.forEach(match => {
                    const dbHome = normalize(match.teamA);
                    const dbAway = normalize(match.teamB);
                    
                    const teamsMatch = (dbHome === apiHome && dbAway === apiAway) || (dbHome === apiAway && dbAway === apiHome);
                    if (teamsMatch) {
                        console.log(`[OK] DB: ${match.teamA} v ${match.teamB} | API: ${event.home} v ${event.away}`);
                    }
                });
            });
        }
        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}

testDeepMatch();
