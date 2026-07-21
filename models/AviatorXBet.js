const mongoose = require('mongoose');

const aviatorXBetSchema = new mongoose.Schema({
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

aviatorXBetSchema.index({ userId: 1, roundId: 1 });
aviatorXBetSchema.index({ roundId: 1 });

module.exports = mongoose.model('AviatorXBet', aviatorXBetSchema);
