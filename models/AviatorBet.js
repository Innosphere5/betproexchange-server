const mongoose = require('mongoose');

const aviatorBetSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  roundId: { type: String, required: true },
  betSlot: { type: Number, enum: [1, 2], required: true },
  stake: { type: Number, required: true },
  autoCashoutMultiplier: { type: Number, default: null },
  cashoutMultiplier: { type: Number, default: null },
  cashoutTime: { type: Date, default: null },
  payout: { type: Number, default: 0 },
  status: { type: String, enum: ['PENDING', 'WON', 'LOST', 'CANCELLED'], default: 'PENDING' },
  createdAt: { type: Date, default: Date.now }
});

aviatorBetSchema.index({ userId: 1, roundId: 1 });
aviatorBetSchema.index({ roundId: 1 });

module.exports = mongoose.model('AviatorBet', aviatorBetSchema);
