const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  walletBalance: { type: Number, default: 50000 },
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
  role: { type: String, enum: ['user', 'master', 'admin', 'superadmin'], default: 'user' },
  share: { type: Number, default: 0, min: 0, max: 100 },
  parentId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  status: { type: String, enum: ['active', 'inactive'], default: 'active' },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('User', userSchema);
