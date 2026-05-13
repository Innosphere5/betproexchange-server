const axios = require('axios');
require('dotenv').config();

const API_TOKEN = process.env.API_KEY;
const BASE_URL = 'https://cricket.sportmonks.com/api/v2.0';

async function searchMatch() {
    try {
        const today = '2026-05-12';
        const future = '2026-05-16';
        const response = await axios.get(`${BASE_URL}/fixtures`, {
            params: { 
                api_token: API_TOKEN,
                'filter[starts_between]': `${today},${future}`,
                include: 'localteam,visitorteam,league'
            }
        });
        
        console.log(`Total fixtures: ${response.data.data.length}`);
        response.data.data.forEach(f => {
            const text = `${f.localteam?.name} v ${f.visitorteam?.name} (${f.league?.name})`.toLowerCase();
            if (text.includes('pakistan') || text.includes('zimbabwe')) {
                console.log(`ID: ${f.id} | League: ${f.league?.name} (ID: ${f.league_id}) | Teams: ${f.localteam?.name} v ${f.visitorteam?.name} | Date: ${f.starting_at}`);
            }
        });
    } catch (error) {
        console.error('Error fetching fixtures:', error.message);
    }
}

searchMatch();
