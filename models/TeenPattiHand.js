const mongoose = require('mongoose');

const teenPattiHandSchema = new mongoose.Schema({
  roundId: { type: String, required: true, unique: true },
  status: {
    type: String,
    enum: ['DEALING', 'BETTING_OPEN', 'BETTING_CLOSED', 'RESULT_DECLARED'],
    required: true
  },
  startTime: { type: Date, default: Date.now, expires: 86400 }, // Auto-purge after 24h
  result: { type: String, enum: ['A', 'B', 'PENDING'], default: 'PENDING' },
  cards: { type: Object, default: null }, // { A: [], B: [] }
  handNames: { type: Object, default: null }, // { A: "", B: "" }
  seedHash: { type: String, default: null }
});

module.exports = mongoose.model('TeenPattiHand', teenPattiHandSchema);
