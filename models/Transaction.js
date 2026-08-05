const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
  userId: { type: String, required: true }, // The user who gets/loses the money
  amount: { type: Number, required: true },
  type: { type: String, default: 'LOAD_BALANCE' },
  description: { type: String },
  matchName: { type: String },    // For Cricket/Casino event name
  selection: { type: String },    // For Team/Choice (A/B)
  category: { type: String, enum: ['cricket', 'casino', 'wallet', 'credit', 'share_settlement'], default: 'cricket' },
  bettor: { type: String },       // The original user who placed the bet
  downline: { type: String },     // The direct downline user name for the transaction
  performedBy: { type: String },  // Username of the admin/master
  createdAt: { type: Date, default: Date.now }
});

transactionSchema.index({ userId: 1, type: 1 });
transactionSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model('Transaction', transactionSchema);
