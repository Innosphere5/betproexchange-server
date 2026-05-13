const mongoose = require('mongoose');
require('dotenv').config();
const Match = require('../models/Match');
const OddsMarket = require('../models/OddsMarket');
const oddsApiService = require('../services/oddsApiService');

const normalize = (name) => {
    if (!name) return "";
    let n = name.toLowerCase().trim();
    n = n.replace(/\bwomen\b/g, "");
    n = n.replace(/\bw\b/g, "");
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

async function forceSync() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('Connected to DB.');
        
        const dbMatches = await Match.find({ status: { $in: ['live', 'upcoming'] } });
        console.log(`Found ${dbMatches.length} matches in DB.`);

        const data = await oddsApiService.fetch('events', { sport: 'cricket', status: 'pending,live' });
        console.log(`Found ${data.length} events in Odds API.`);

        let linked = 0;
        for (const event of data) {
            const apiHome = normalize(event.home);
            const apiAway = normalize(event.away);
            
            for (const match of dbMatches) {
                const dbHome = normalize(match.teamA);
                const dbAway = normalize(match.teamB);
                
                const teamsMatch = (dbHome === apiHome && dbAway === apiAway) || (dbHome === apiAway && dbAway === apiHome);
                if (teamsMatch) {
                    console.log(`Linking ${match.teamA} v ${match.teamB} to API event ${event.id}`);
                    await OddsMarket.findOneAndUpdate(
                        { sportmonksMatchId: match.matchId },
                        {
                            sportmonksMatchId: match.matchId,
                            oddsApiEventId: event.id,
                            teamA: match.teamA,
                            teamB: match.teamB,
                            updatedAt: new Date()
                        },
                        { upsert: true }
                    );
                    linked++;
                }
            }
        }
        console.log(`Successfully linked ${linked} matches.`);
        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}

forceSync();
