const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const auth = require('../middleware/auth');
const { getEffectiveWalletBalance, isSuperAdminRole } = require('../utils/superAdminWallet');

const JWT_SECRET = process.env.JWT_SECRET || 'a7df1cecb1c78b4b7bab8261102f22ab98715c8877cccacc392786588d189e15';

// Register User
router.post('/register', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    const normalizedUsername = String(username).toLowerCase().trim();
    let user = await User.findOne({ username: normalizedUsername });
    if (user) return res.status(400).json({ error: 'User already exists' });

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    user = new User({
      username: normalizedUsername,
      password: hashedPassword
    });

    await user.save();

    const payload = { userId: user.username, role: user.role };
    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });

    res.json({ token, user: { username: user.username, balance: user.walletBalance, role: user.role } });
  } catch (err) {
    console.error('Registration error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Login User
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    // Case-insensitive lookup with regex-escaping for SuperAdmin accounts like MD97FS, MD202FS, Adnan
    const safeUsername = String(username).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const user = await User.findOne({ username: { $regex: new RegExp(`^${safeUsername}$`, 'i') } });
    if (!user) return res.status(400).json({ error: 'Invalid credentials' });

    if (user.status === 'inactive') {
      return res.status(403).json({ error: 'Account is inactive. Please contact support.' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ error: 'Invalid credentials' });

    const payload = { userId: user.username, role: user.role };
    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });

    res.json({ token, user: { username: user.username, balance: getEffectiveWalletBalance(user), settings: user.settings, role: user.role, share: user.share || 0 } });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get Current User
router.get('/me', auth, async (req, res) => {
  try {
    const user = await User.findOne({ username: req.user.userId }).select('-password');
    if (user && isSuperAdminRole(user)) {
      const obj = user.toObject ? user.toObject() : { ...user };
      obj.walletBalance = getEffectiveWalletBalance(user);
      return res.json(obj);
    }
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Change Password
router.post('/change-password', auth, async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body || {};
    if (!oldPassword || !newPassword) {
      return res.status(400).json({ error: 'Old and new passwords are required' });
    }
    const user = await User.findOne({ username: req.user.userId });

    const isMatch = await bcrypt.compare(oldPassword, user.password);
    if (!isMatch) return res.status(400).json({ error: 'Incorrect old password' });

    const salt = await bcrypt.genSalt(10);
    user.password = await bcrypt.hash(newPassword, salt);
    await user.save();

    res.json({ success: true, message: 'Password changed successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Save Settings
router.post('/settings', auth, async (req, res) => {
  try {
    const { settings } = req.body || {};
    const user = await User.findOneAndUpdate(
      { username: req.user.userId },
      { $set: { settings: settings } },
      { new: true }
    );
    res.json({ success: true, settings: user?.settings });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
