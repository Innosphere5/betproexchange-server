const { getData } = require('../services/apiManager');
require('dotenv').config();

async function checkMatch() {
    const matchId = '69917';
    console.log(`Checking Match ${matchId}...`);
    try {
        const response = await getData(`fixtures/${matchId}`, {
            include: 'runs,balls,scoreboards,localteam,visitorteam'
        });
        console.log('Match Data:', JSON.stringify(response, null, 2));
    } catch (err) {
        console.error('Error:', err.message);
    }
}

checkMatch();
