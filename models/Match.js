const mongoose = require('mongoose');

const matchSchema = new mongoose.Schema({
  matchId: { type: String, required: true, unique: true, index: true },
  teamA: { type: String, required: true },
  teamB: { type: String, required: true },
  league: { type: String, required: true },
  status: { type: String, enum: ['upcoming', 'live', 'completed'], default: 'upcoming' },
  score: {
    home: { type: String, default: "0/0" },
    away: { type: String, default: "0/0" }
  },
  startTime: { type: Date, required: true },
  lastUpdated: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Match', matchSchema);
