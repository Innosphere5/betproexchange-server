const mongoose = require('mongoose');

const betSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  matchId: { type: String, required: true, index: true },
  matchName: { type: String, required: true },
  runner: { type: String, required: true },
  stake: { type: Number, required: true },
  odds: { type: Number, required: true },
  type: { type: String, enum: ['back', 'lay'], default: 'back' },
  isLive: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
  status: { type: String, enum: ['pending', 'won', 'lost', 'cancelled', 'MATCHED', 'WIN', 'LOSE', 'CANCELLED'], default: 'pending' },
  result: { type: String, default: null },
  payout: { type: Number, default: 0 },
  settledAt: { type: Date, default: null }
}, { timestamps: true });

module.exports = mongoose.model('Bet', betSchema);
