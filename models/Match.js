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
    lastUpdated: { type: Date, default: Date.now }
  },
  startTime: { type: Date, required: true },
  lastUpdated: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Match', matchSchema);
