const mongoose = require('mongoose');

const teenPattiHandSchema = new mongoose.Schema({
  roundId: { type: String, required: true, unique: true },
  status: { type: String, enum: ['DEALING', 'BETTING_OPEN', 'BETTING_CLOSED', 'RESULT_DECLARED'], required: true },
  startTime: { type: Date, default: Date.now },
  result: { type: String, enum: ['A', 'B', 'PENDING'], default: 'PENDING' },
  cards: { type: Object, default: null }, // { A: [], B: [] }
  handNames: { type: Object, default: null } // { A: "", B: "" }
});

module.exports = mongoose.model('TeenPattiHand', teenPattiHandSchema);
