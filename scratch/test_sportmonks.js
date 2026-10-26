const axios = require('axios');
const token = 'OfcS0PRNSVU48Ks0REentxysHdXVp35Xxo4yisudPLjMgaZkOPSd0dIT5zYJ';

async function test() {
  try {
    const res = await axios.get('https://cricket.sportmonks.com/api/v2.0/livescores', {
      params: { 
        api_token: token,
        include: 'runs,balls,scoreboards,localteam,visitorteam,batting.batsman,bowling.bowler,tosswon,league'
      }
    });
    const m = res.data.data?.[0];
    if (!m) {
      console.log('No live matches right now');
      return;
    }
    console.log('Match ID:', m.id);
    console.log('Match:', m.localteam?.name, 'vs', m.visitorteam?.name);
    console.log('Type:', m.type);
    console.log('Status:', m.status);
    console.log('Note:', m.note);
    console.log('Toss won:', m.tosswon?.name, 'elected to', m.elected);
    console.log('\nRuns:');
    (m.runs || []).forEach(r => {
      console.log(`  Team ${r.team_id} (Inning ${r.inning}): ${r.score}/${r.wickets} in ${r.overs} ov`);
    });
    console.log('\nBatting (Active / on crease):');
    (m.batting || []).filter(b => b.active).forEach(b => {
      console.log(`  * ${b.batsman?.fullname}: ${b.score} off ${b.ball}b (4s: ${b.four_x}, 6s: ${b.six_x}, SR: ${b.rate})`);
    });
    console.log('\nBowling (Active):');
    (m.bowling || []).filter(b => b.active).forEach(b => {
      console.log(`  * ${b.bowler?.fullname}: ${b.overs} ov, ${b.runs} r, ${b.wickets} w (Econ: ${b.rate})`);
    });
    console.log('\nLatest 8 balls:');
    (m.balls || []).slice(-8).forEach(b => {
      console.log(`  Ball ${b.ball}: ${b.score?.name} (${b.score?.runs} runs, Wicket: ${b.score?.is_wicket}) | Bowler: ${b.bowler?.fullname} | Striker: ${b.batsman?.fullname}`);
    });
  } catch (err) {
    console.error('Error:', err.message);
  }
}
test();
