const axios = require('axios');
require('dotenv').config();

const API_TOKEN = process.env.API_KEY;
const BASE_URL = 'https://cricket.sportmonks.com/api/v2.0';

async function listWideFixtures() {
    try {
        const today = '2026-05-10';
        const future = '2026-05-20';
        const response = await axios.get(`${BASE_URL}/fixtures`, {
            params: { 
                api_token: API_TOKEN,
                'filter[starts_between]': `${today},${future}`,
                include: 'localteam,visitorteam,league'
            }
        });
        
        console.log(`Total fixtures found: ${response.data.data.length}`);
        response.data.data.forEach(f => {
            console.log(`ID: ${f.id} | League: ${f.league?.name} (ID: ${f.league_id}) | Teams: ${f.localteam?.name} v ${f.visitorteam?.name} | Status: ${f.status} | Date: ${f.starting_at}`);
        });
    } catch (error) {
        console.error('Error fetching fixtures:', error.message);
    }
}

listWideFixtures();
