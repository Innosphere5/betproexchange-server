const mongoose = require('mongoose');
require('dotenv').config();

const Match = require('../models/Match');
const oddsApiRest = require('../services/oddsApiRest');

function normalize(name) {
    if (!name) return '';
    let n = name.toLowerCase().trim();
    n = n.replace(/\bwomen\b/g, '').replace(/\bw\b/g, '').replace(/\bteam\b/g, '')
         .replace(/\bcricket\b/g, '').replace(/\bnational\b/g, '')
         .replace(/\bmen\b/g, '').replace(/\bxi\b/g, '');
    n = n.replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, '');

    const aliases = {
        'royalchallengers': 'rcb', 'bengaluru': 'rcb', 'bangalore': 'rcb',
        'lucknow': 'lsg', 'sunrisers': 'srh', 'hyderabad': 'srh',
        'mumbaiindians': 'mi', 'mumbai': 'mi', 'chennaisuperkings': 'csk',
        'chennai': 'csk', 'delhicapitals': 'dc', 'delhi': 'dc',
        'rajasthanroyals': 'rr', 'rajasthan': 'rr', 'gujarattitans': 'gt',
        'gujarat': 'gt', 'kolkataknightriders': 'kkr', 'kolkata': 'kkr',
        'punjabkings': 'pbks', 'kingsxi': 'pbks', 'punjab': 'pbks'
    };
    for (const [key, value] of Object.entries(aliases)) {
        if (n.includes(key)) return value;
    }
    return n;
}

async function testLink() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('Connected to DB');

        const dbMatches = await Match.find({ status: { $in: ['live', 'upcoming'] } });
        console.log(`Found ${dbMatches.length} active matches in DB:`);
        dbMatches.forEach(m => {
            console.log(`- DB: "${m.teamA}" vs "${m.teamB}" | ID: ${m.matchId} | Status: ${m.status} | Start: ${m.startTime}`);
            console.log(`      Normalized: "${normalize(m.teamA)}" vs "${normalize(m.teamB)}"`);
        });

        console.log('\nFetching today\'s fixtures from Odds API...');
        const fixtures = await oddsApiRest.getFixturesToday();
        if (!fixtures || !Array.isArray(fixtures)) {
            console.log('No fixtures returned from API today or API error.', fixtures);
            process.exit(0);
        }

        console.log(`Found ${fixtures.length} fixtures in Odds API today:`);
        fixtures.forEach(f => {
            const home = f.participants?.participant1Name || f.home_team || f.home || '';
            const away = f.participants?.participant2Name || f.away_team || f.away || '';
            const commenceTime = f.startTime ? new Date(f.startTime * 1000).toISOString() : f.commence_time || '';
            const id = f.fixtureId || f.id;

            console.log(`- API: "${home}" vs "${away}" | ID: ${id} | Start: ${commenceTime}`);
            console.log(`       Normalized: "${normalize(home)}" vs "${normalize(away)}"`);

            // Try to link
            const apiHome = normalize(home);
            const apiAway = normalize(away);
            const apiTime = commenceTime ? new Date(commenceTime).getTime() : 0;

            let linked = false;
            for (const match of dbMatches) {
                const dbHome = normalize(match.teamA);
                const dbAway = normalize(match.teamB);
                const dbTime = new Date(match.startTime).getTime();

                const teamsMatch = (dbHome === apiHome && dbAway === apiAway) || (dbHome === apiAway && dbAway === apiHome);
                if (teamsMatch) {
                    const timeDiff = apiTime > 0 ? Math.abs(dbTime - apiTime) / (1000 * 60 * 60) : 0;
                    console.log(`       [Teams Match] Time diff: ${timeDiff.toFixed(2)} hours`);
                    if (timeDiff <= 12 || apiTime === 0) {
                        console.log(`       🚀 LINK SUCCESS! Linked to DB Match ${match.matchId} ("${match.teamA}" v "${match.teamB}")`);
                        linked = true;
                        break;
                    }
                }
            }
            if (!linked) {
                console.log(`       ❌ LINK FAILED`);
            }
        });

        process.exit(0);
    } catch (err) {
        console.error('Error:', err);
        process.exit(1);
    }
}

testLink();
