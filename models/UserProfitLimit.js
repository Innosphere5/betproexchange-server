const mongoose = require('mongoose');

const userProfitLimitSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  username: { type: String, required: true, index: true },
  parentId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  parentUsername: { type: String, default: null },
  role: { type: String, enum: ['user', 'master', 'supermaster', 'admin', 'superadmin'], default: 'user' },
  maxProfit: { type: Number, default: 10000000 }, // Overall max profit per bet/market
  cricket: { type: Number, default: 5000000 },
  casino: { type: Number, default: 500000 },
  aviator: { type: Number, default: 500000 },
  aviatorX: { type: Number, default: 500000 },
  teenpatti: { type: Number, default: 500000 },
  soccer: { type: Number, default: 2000000 },
  tennis: { type: Number, default: 1000000 },
  fancy: { type: Number, default: 2000000 },
  bookmaker: { type: Number, default: 2000000 },
  dailyProfitCap: { type: Number, default: 20000000 },
  currentProfit: { type: Number, default: 0 },
  isEnabled: { type: Boolean, default: true },
  applyToChildren: { type: Boolean, default: false },
  lastUpdatedBy: { type: String, default: 'system' }
}, { timestamps: true });

userProfitLimitSchema.index({ parentId: 1, isEnabled: 1 });
userProfitLimitSchema.index({ username: 1 }, { unique: true });

module.exports = mongoose.model('UserProfitLimit', userProfitLimitSchema);

