const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  walletBalance: { type: Number, default: 0 },
  settings: {
    stake1: { type: Number, default: 2000 },
    stake2: { type: Number, default: 5000 },
    stake3: { type: Number, default: 10000 },
    stake4: { type: Number, default: 25000 },
    plus1: { type: Number, default: 1000 },
    plus2: { type: Number, default: 5000 },
    plus3: { type: Number, default: 10000 },
    plus4: { type: Number, default: 25000 },
  },
  role: { type: String, enum: ['user', 'master', 'supermaster', 'admin', 'superadmin'], default: 'user' },
  share: { type: Number, default: 0, min: 0, max: 100 },
  credit: { type: Number, default: 0 },
  parentId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  status: { type: String, enum: ['active', 'inactive'], default: 'active' },
  allowSettlement: { type: Boolean, default: true },
  clientId: {
    type: String,
    default: () => Math.floor(1000000 + Math.random() * 9000000).toString()
  },
  phone: { type: String, default: '' },
  reference: { type: String, default: '' },
  notes: { type: String, default: '' },
  commission: { type: Number, default: 2.0 },
  bettingAllowed: { type: Boolean, default: true },
  userDomain: { type: String, default: '1 (betproexch.com)' },
  maxBetSizes: {
    soccer: { type: Number, default: 1000000 },
    tennis: { type: Number, default: 250000 },
    cricket: { type: Number, default: 5000000 },
    fancy: { type: Number, default: 2000000 },
    races: { type: Number, default: 200000 },
    casino: { type: Number, default: 50000 },
    greyhound: { type: Number, default: 50000 },
    bookmaker: { type: Number, default: 2000000 },
    aviator: { type: Number, default: 50000 },
    aviatorX: { type: Number, default: 50000 },
    teenpatti: { type: Number, default: 50000 }
  },
  profitLimits: {
    isEnabled: { type: Boolean, default: true },
    maxProfit: { type: Number, default: 10000000 },
    cricket: { type: Number, default: 5000000 },
    soccer: { type: Number, default: 2000000 },
    tennis: { type: Number, default: 1000000 },
    fancy: { type: Number, default: 2000000 },
    bookmaker: { type: Number, default: 2000000 },
    casino: { type: Number, default: 500000 },
    aviator: { type: Number, default: 500000 },
    aviatorX: { type: Number, default: 500000 },
    teenpatti: { type: Number, default: 500000 },
    dailyProfitCap: { type: Number, default: 20000000 }
  },
  createdAt: { type: Date, default: Date.now }
});

userSchema.index({ parentId: 1 });
userSchema.index({ parentId: 1, role: 1 }); // Hierarchy traversal with role filter
userSchema.index({ role: 1 }); // Role-based queries
userSchema.index({ status: 1 }); // Status filtering

module.exports = mongoose.model('User', userSchema);
