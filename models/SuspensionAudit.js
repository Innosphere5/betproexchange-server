const mongoose = require('mongoose');

const suspensionAuditSchema = new mongoose.Schema({
  matchId: { type: String, required: true, index: true },
  marketName: { type: String, required: true, index: true },
  marketType: { type: String, required: true },
  oldStatus: { type: String },
  newStatus: { type: String, required: true },
  oldReasons: { type: [String], default: [] },
  newReasons: { type: [String], default: [] },
  topReason: { type: String, default: null },
  stateSeq: { type: Number, default: 0 },
  modelVersion: { type: String, default: 'suspension-v1.0' },
  ctxSummary: {
    now: Number,
    matchStatus: String,
    legalBalls: Number,
    wickets: Number,
    runs: Number,
    innings: Number,
    feedStale: Boolean,
    exposureRatio: Number,
    pEarlyEnd: Number
  },
  createdAt: { type: Date, default: Date.now }
});

// TTL index: auto-delete audits older than 3 days to prevent DB bloat
// (742k docs / 360MB filled the 512MB Atlas free tier)
suspensionAuditSchema.index({ createdAt: 1 }, { expireAfterSeconds: 3 * 24 * 60 * 60 });

module.exports = mongoose.model('SuspensionAudit', suspensionAuditSchema);
