const mongoose = require('mongoose');

const marketOddsSchema = new mongoose.Schema({
  matchId: { type: String, required: true, unique: true, index: true },
  oddsApiEventId: { type: String, required: true, index: true },
  teamA: {
    back: { type: Number, default: 0 },
    lay: { type: Number, default: 0 }
  },
  teamB: {
    back: { type: Number, default: 0 },
    lay: { type: Number, default: 0 }
  },
  bookmaker: { type: String },
  marketStatus: { type: String, enum: ['OPEN', 'SUSPENDED', 'CLOSED'], default: 'OPEN' },
  updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('MarketOdds', marketOddsSchema);
