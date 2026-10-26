const axios = require('axios');
const token = 'OfcS0PRNSVU48Ks0REentxysHdXVp35Xxo4yisudPLjMgaZkOPSd0dIT5zYJ';

/**
 * Format ball string into cricket scorecard badge notation
 */
function formatBallBadge(ball) {
  if (!ball || !ball.score) return '0';
  const sc = ball.score;
  if (sc.is_wicket || sc.out) return 'W';
  if (sc.six) return '6';
  if (sc.four) return '4';
  if (sc.noball || (sc.name && sc.name.toLowerCase().includes('no ball'))) {
    return sc.runs > 1 ? `${sc.runs}Nb` : 'Nb';
  }
  if (sc.noball_runs > 0) return `${sc.noball_runs}Nb`;
  if (sc.bye > 0) return `${sc.bye}B`;
  if (sc.leg_bye > 0) return `${sc.leg_bye}Lb`;
  if (sc.name && sc.name.toLowerCase().includes('wide')) {
    return sc.runs > 1 ? `${sc.runs}Wd` : 'Wd';
  }
  return String(sc.runs ?? 0);
}

/**
 * Parse a Sportmonks Cricket v2.0 fixture
 */
function parseSportmonksFixture(fixture) {
  if (!fixture) return null;

  const localTeamId = fixture.localteam_id;
  const visitorTeamId = fixture.visitorteam_id;
  const localTeamName = fixture.localteam?.name || 'Team 1';
  const visitorTeamName = fixture.visitorteam?.name || 'Team 2';

  const runsList = fixture.runs || [];
  const inn1 = runsList.find(r => r.inning === 1);
  const inn2 = runsList.find(r => r.inning === 2);

  // Identify which team batted 1st
  let inn1IsTeamA = true;
  if (inn1) {
    inn1IsTeamA = (inn1.team_id === localTeamId);
  } else if (fixture.toss_won_team_id && fixture.elected) {
    const tossWinnerIsTeamA = (fixture.toss_won_team_id === localTeamId);
    if (fixture.elected === 'batting') {
      inn1IsTeamA = tossWinnerIsTeamA;
    } else {
      inn1IsTeamA = !tossWinnerIsTeamA;
    }
  }

  const inn1Score = inn1 ? inn1.score : 0;
  const inn1Wickets = inn1 ? inn1.wickets : 0;
  const inn1Overs = inn1 ? Number(inn1.overs) : 0.0;

  const inn2Score = inn2 ? inn2.score : 0;
  const inn2Wickets = inn2 ? inn2.wickets : 0;
  const inn2Overs = inn2 ? Number(inn2.overs) : 0.0;

  const teamA_runs = inn1IsTeamA ? `${inn1Score}/${inn1Wickets}` : `${inn2Score}/${inn2Wickets}`;
  const teamB_runs = inn1IsTeamA ? `${inn2Score}/${inn2Wickets}` : `${inn1Score}/${inn1Wickets}`;

  // Current innings & batting team
  let currentInnings = 1;
  let battingTeam = inn1IsTeamA ? 'teamA' : 'teamB';
  let battingTeamName = inn1IsTeamA ? localTeamName : visitorTeamName;
  let bowlingTeamName = inn1IsTeamA ? visitorTeamName : localTeamName;
  let currentOvers = inn1Overs;
  let currentWickets = inn1Wickets;
  let currentScore = inn1Score;

  if (inn2) {
    currentInnings = 2;
    battingTeam = inn1IsTeamA ? 'teamB' : 'teamA';
    battingTeamName = inn1IsTeamA ? visitorTeamName : localTeamName;
    bowlingTeamName = inn1IsTeamA ? localTeamName : visitorTeamName;
    currentOvers = inn2Overs;
    currentWickets = inn2Wickets;
    currentScore = inn2Score;
  }

  // Target calculation
  let target = 0;
  if (fixture.rpc_target && Number(fixture.rpc_target) > 0) {
    target = Number(fixture.rpc_target);
  } else if (fixture.note && /target\s+(\d+)/i.test(fixture.note)) {
    target = parseInt(fixture.note.match(/target\s+(\d+)/i)[1], 10);
  } else if (inn1 && (inn2 || fixture.status === 'Innings Break' || fixture.status === '2nd Innings')) {
    target = inn1Score + 1;
  }

  // Format determination (max overs)
  const totalOversMax = fixture.total_overs_played || (
    fixture.type === 'T20I' || fixture.type === 'T20' ? 20 :
    fixture.type === 'ODI' ? 50 :
    fixture.type === 'T10' ? 10 : 20
  );
  const totalBallsMax = totalOversMax * 6;

  // Overs formatting
  const oversWhole = Math.floor(currentOvers);
  const oversBalls = Math.round((currentOvers % 1) * 10);
  const totalBallsBowled = oversWhole * 6 + oversBalls;
  const oversFraction = oversWhole + (oversBalls / 6);

  // CRR
  let runRate = "0.00";
  if (oversFraction > 0) {
    runRate = (currentScore / oversFraction).toFixed(2);
  }

  // Remaining runs and balls (for 2nd innings or target chase)
  let remRuns = 0;
  let remBalls = 0;
  let reqRunRate = "0.00";

  if (target > 0) {
    remRuns = Math.max(0, target - (inn2 ? inn2Score : 0));
    const inn2Balls = inn2 ? (Math.floor(inn2Overs) * 6 + Math.round((inn2Overs % 1) * 10)) : 0;
    remBalls = Math.max(0, totalBallsMax - inn2Balls);
    if (remBalls > 0 && remRuns > 0) {
      reqRunRate = ((remRuns / remBalls) * 6).toFixed(2);
    }
  }

  // Ball-by-ball thisOver calculation
  const ballsList = fixture.balls || [];
  let thisOver = [];
  let lastBallText = '';

  if (ballsList.length > 0) {
    // Current scoreboard identifier (S1 for 1st inn, S2 for 2nd inn)
    const currentScoreboard = currentInnings === 2 ? 'S2' : 'S1';
    const innBalls = ballsList.filter(b => !b.scoreboard || b.scoreboard === currentScoreboard);
    const activeBalls = innBalls.length > 0 ? innBalls : ballsList;

    const latestBallObj = activeBalls[activeBalls.length - 1];
    if (latestBallObj) {
      const latestBallNumber = latestBallObj.ball;
      const currentOverIndex = Math.floor(latestBallNumber);

      // Find all balls in this current over
      const ballsInOver = activeBalls.filter(b => Math.floor(b.ball) === currentOverIndex);
      thisOver = ballsInOver.map(formatBallBadge);

      const bowlerName = latestBallObj.bowler?.fullname || latestBallObj.bowler?.lastname || 'Bowler';
      const batsmanName = latestBallObj.batsman?.fullname || latestBallObj.batsman?.lastname || 'Batsman';
      const actionName = latestBallObj.score?.name || `${latestBallObj.score?.runs || 0} Runs`;
      lastBallText = `${latestBallObj.ball}: ${actionName} (${bowlerName} to ${batsmanName})`;
    }
  }

  // Batsmen on crease
  const battingList = fixture.batting || [];
  let batsmen = battingList.filter(b => b.active === true).map(b => ({
    id: b.player_id,
    name: b.batsman?.fullname || 'Batsman',
    runs: b.score ?? 0,
    balls: b.ball ?? 0,
    fours: b.four_x ?? 0,
    sixes: b.six_x ?? 0,
    strikeRate: b.rate ?? (b.ball > 0 ? Number(((b.score / b.ball) * 100).toFixed(1)) : 0)
  }));

  // Bowler
  const bowlingList = fixture.bowling || [];
  let activeBowlerObj = bowlingList.find(b => b.active === true);
  if (!activeBowlerObj && bowlingList.length > 0) {
    activeBowlerObj = bowlingList[bowlingList.length - 1];
  }

  let bowler = null;
  if (activeBowlerObj) {
    bowler = {
      id: activeBowlerObj.player_id,
      name: activeBowlerObj.bowler?.fullname || 'Bowler',
      overs: activeBowlerObj.overs ?? 0,
      maidens: activeBowlerObj.medians ?? 0,
      runs: activeBowlerObj.runs ?? 0,
      wickets: activeBowlerObj.wickets ?? 0,
      economy: activeBowlerObj.rate ?? 0
    };
  }

  // Status mapping
  const isFinished = fixture.status === 'Finished' || 
                     fixture.status === 'Aband.' || 
                     fixture.status === 'Postp.' || 
                     fixture.live === false;

  const status = isFinished ? 'completed' : 'live';
  const oversDisplay = isFinished ? 'Final' : String(currentOvers);

  let winner = null;
  if (isFinished) {
    if (fixture.winner_team_id === localTeamId) winner = localTeamName;
    else if (fixture.winner_team_id === visitorTeamId) winner = visitorTeamName;
    else if (fixture.note && fixture.note.toLowerCase().includes('won')) {
      if (fixture.note.toLowerCase().includes(localTeamName.toLowerCase())) winner = localTeamName;
      else if (fixture.note.toLowerCase().includes(visitorTeamName.toLowerCase())) winner = visitorTeamName;
    }
  }

  // Official periods map
  const periods = {
    "0": {
      participant1Score: inn1IsTeamA ? inn1Score : inn2Score,
      participant2Score: inn1IsTeamA ? inn2Score : inn1Score,
      updatedAt: new Date().toISOString()
    }
  };
  if (inn1) {
    periods["1"] = {
      participant1Score: inn1IsTeamA ? inn1Score : 0,
      participant2Score: inn1IsTeamA ? 0 : inn1Score,
      updatedAt: inn1.updated_at || new Date().toISOString()
    };
  }
  if (inn2) {
    periods["2"] = {
      participant1Score: inn1IsTeamA ? 0 : inn2Score,
      participant2Score: inn1IsTeamA ? inn2Score : 0,
      updatedAt: inn2.updated_at || new Date().toISOString()
    };
  }

  return {
    matchId: String(fixture.id),
    fixtureId: fixture.id,
    teamA: localTeamName,
    teamB: visitorTeamName,
    league: fixture.league?.name || 'Cricket',
    teamA_runs,
    teamB_runs,
    overs: oversDisplay,
    wickets: currentWickets,
    target,
    runRate,
    reqRunRate,
    thisOver,
    remRuns,
    remBalls,
    battingTeam,
    battingTeamName,
    bowlingTeamName,
    innings: currentInnings,
    statusText: fixture.status || (isFinished ? 'Finished' : 'Live'),
    status,
    winner,
    batsmen,
    bowler,
    lastBall: lastBallText,
    tossWinner: fixture.tosswon?.name || null,
    tossDecision: fixture.elected || null,
    periods,
    lastUpdated: new Date()
  };
}

async function runTest() {
  const res = await axios.get('https://cricket.sportmonks.com/api/v2.0/livescores', {
    params: { 
      api_token: token,
      include: 'runs,balls,scoreboards,localteam,visitorteam,batting.batsman,bowling.bowler,tosswon,league'
    }
  });
  const m = res.data.data?.[0];
  const parsed = parseSportmonksFixture(m);
  console.log('PARSED LIVE SCORE PAYLOAD:');
  console.log(JSON.stringify(parsed, null, 2));
}

runTest();
