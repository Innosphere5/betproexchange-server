const mongoose = require('mongoose');

const oddsSchema = new mongoose.Schema({
  matchId: { type: String, required: true, unique: true, index: true },
  teamA: { type: String, required: true },
  teamB: { type: String, required: true },
  backOddsA: { type: Number, default: 0 },
  layOddsA: { type: Number, default: 0 },
  backOddsB: { type: Number, default: 0 },
  layOddsB: { type: Number, default: 0 },
  updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Odds', oddsSchema);
