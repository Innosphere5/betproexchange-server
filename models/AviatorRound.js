const mongoose = require('mongoose');

const aviatorRoundSchema = new mongoose.Schema({
  roundId: { type: String, required: true, unique: true },
  status: { type: String, enum: ['BETTING_OPEN', 'FLYING', 'CRASHED'], required: true },
  startTime: { type: Date, default: Date.now },
  endTime: { type: Date, default: null },
  serverSeed: { type: String, required: true },
  serverSeedHash: { type: String, required: true },
  clientSeed: { type: String, default: 'betproexchange' },
  nonce: { type: Number, required: true },
  crashPoint: { type: Number, required: true }
});

module.exports = mongoose.model('AviatorRound', aviatorRoundSchema);
