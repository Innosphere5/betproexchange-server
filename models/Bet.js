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
  status: { type: String, enum: ['OPEN', 'MATCHED', 'WIN', 'LOSE', 'CANCELLED'], default: 'MATCHED' }
}, { timestamps: true });

module.exports = mongoose.model('Bet', betSchema);
