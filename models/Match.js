const mongoose = require('mongoose');

const matchSchema = new mongoose.Schema({
  matchId: { type: String, required: true, unique: true, index: true },
  leagueId: { type: Number, index: true }, // Added for Sportmonks league filtering
  teamA: { type: String, required: true },
  teamB: { type: String, required: true },
  league: { type: String, required: true },
  sportKey: { type: String, default: 'cricket_ipl' },
  status: { type: String, enum: ['upcoming', 'live', 'completed'], default: 'upcoming' },
  score: {
    teamA_runs: { type: String, default: "0/0" },
    teamB_runs: { type: String, default: "0/0" },
    overs: { type: String, default: "0.0" },
    wickets: { type: Number, default: 0 },
    target: { type: Number, default: 0 },
    runRate: { type: String, default: "0.00" },
    reqRunRate: { type: String, default: "0.00" },
    thisOver: { type: [String], default: [] },
    remRuns: { type: Number, default: 0 },
    remBalls: { type: Number, default: 0 },
    lastUpdated: { type: Date, default: Date.now }
  },
  startTime: { type: Date, required: true },
  winner: { type: String, default: null }, // Team name that won
  backOddsA: { type: Number, default: null },
  layOddsA: { type: Number, default: null },
  backOddsB: { type: Number, default: null },
  layOddsB: { type: Number, default: null },
  depthBackA: { type: String, default: null },
  depthLayA: { type: String, default: null },
  depthBackB: { type: String, default: null },
  depthLayB: { type: String, default: null },
  marketStatus: { type: String, enum: ['OPEN', 'SUSPENDED', 'CLOSED'], default: null },
  isPriority: { type: Boolean, default: false },
  lastUpdated: { type: Date, default: Date.now }

});

module.exports = mongoose.model('Match', matchSchema);
