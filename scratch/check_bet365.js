const oddsApiService = require('../services/oddsApiService');
require('dotenv').config();

async function checkBet365Markets() {
    try {
        const data = await oddsApiService.fetch('odds', { 
            eventId: '70343198',
            bookmakers: 'Bet365'
        });
        
        if (data && data.bookmakers && data.bookmakers['Bet365']) {
            console.log('Bet365 Markets:', data.bookmakers['Bet365'].map(m => m.name).join(', '));
            const winner = data.bookmakers['Bet365'].find(m => m.name.toLowerCase().includes('winner') || m.name.toLowerCase().includes('result') || m.name === 'ML' || m.name === 'h2h');
            if (winner) {
                console.log('Potential Winner Market:', winner.name);
                console.log('Odds structure:', JSON.stringify(winner.odds[0], null, 2));
            }
        } else {
            console.log('No Bet365 data or request failed.');
        }
    } catch (err) {
        console.error('Error in checkBet365Markets:', err.message);
    }
}

checkBet365Markets();
