const mongoose = require('mongoose');

const teenPattiBetSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  roundId: { type: String, required: true },
  betType: {
    type: String,
    enum: ['A_BACK', 'A_LAY', 'B_BACK', 'B_LAY', 'A_PAIR_PLUS', 'B_PAIR_PLUS'],
    required: true
  },
  amount: { type: Number, required: true },
  liability: { type: Number, default: null }, // For LAY bets = round2(amount * (odds - 1))
  odds: { type: Number, required: true },
  payout: { type: Number, default: 0 },
  status: { type: String, enum: ['PENDING', 'WIN', 'LOSE'], default: 'PENDING' },
  createdAt: { type: Date, default: Date.now }
});

teenPattiBetSchema.index({ userId: 1, roundId: 1 });
teenPattiBetSchema.index({ roundId: 1, status: 1 });

module.exports = mongoose.model('TeenPattiBet', teenPattiBetSchema);
