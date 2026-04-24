const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
  userId: { type: String, required: true }, // Using username consistent with other models
  amount: { type: Number, required: true },
  type: { type: String, enum: ['LOAD_BALANCE', 'WITHDRAW', 'BET_PAYOUT', 'BET_DEDUCTION', 'COMMISSION', 'HIERARCHY_P_L'], default: 'LOAD_BALANCE' },
  description: { type: String },
  performedBy: { type: String }, // Username of the admin/master
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Transaction', transactionSchema);
