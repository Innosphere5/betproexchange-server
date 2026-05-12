const mongoose = require('mongoose');

const oddsMarketSchema = new mongoose.Schema({
  sportmonksMatchId: { type: String, required: true, index: true },
  oddsApiEventId: { type: String, required: true, index: true },

  teamA: { type: String },
  teamB: { type: String },

  teamABack: { type: Number, default: 0 },
  teamALay: { type: Number, default: 0 },

  teamBBack: { type: Number, default: 0 },
  teamBLay: { type: Number, default: 0 },

  bookmaker: { type: String },

  marketStatus: { type: String, enum: ['OPEN', 'SUSPENDED', 'CLOSED'], default: 'OPEN' },

  isLive: { type: Boolean, default: false },

  updatedAt: { type: Date, default: Date.now }
});

// Compound index for quick lookups
oddsMarketSchema.index({ sportmonksMatchId: 1, oddsApiEventId: 1 });

module.exports = mongoose.model('OddsMarket', oddsMarketSchema);
