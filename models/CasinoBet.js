const mongoose = require('mongoose');

const casinoBetSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  roundId: { type: String, required: true },
  choice: { type: String, enum: ['A', 'B'], required: true },
  amount: { type: Number, required: true },
  odds: { type: Number, required: true },
  status: { type: String, enum: ['PENDING', 'WIN', 'LOSE'], default: 'PENDING' },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('CasinoBet', casinoBetSchema);
