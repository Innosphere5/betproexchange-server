const mongoose = require('mongoose');

const casinoRoundSchema = new mongoose.Schema({
  roundId: { type: String, required: true, unique: true },
  status: { type: String, enum: ['BETTING_OPEN', 'BETTING_CLOSED', 'RESULT_DECLARED'], required: true },
  startTime: { type: Date, default: Date.now },
  result: { type: String, enum: ['A', 'B', 'PENDING'], default: 'PENDING' },
  cards: { type: Object, default: null }
});

module.exports = mongoose.model('CasinoRound', casinoRoundSchema);
