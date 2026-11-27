const mongoose = require('mongoose');

const casinoBetSchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  roundId: { type: String, required: true, index: true },
  choice: { type: String, enum: ['A', 'B'], required: true },
  amount: { type: Number, required: true },
  odds: { type: Number, required: true },
  payout: { type: Number, default: 0 },
  status: { type: String, enum: ['PENDING', 'WIN', 'LOSE'], default: 'PENDING' },
  createdAt: { type: Date, default: Date.now }
});

casinoBetSchema.index({ userId: 1, roundId: 1 });
casinoBetSchema.index({ roundId: 1, status: 1 });

module.exports = mongoose.model('CasinoBet', casinoBetSchema);
