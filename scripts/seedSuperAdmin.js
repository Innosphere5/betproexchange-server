const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const User = require('../models/User');

// All three SuperAdmin accounts configuration
const SUPERADMINS = [
    {
        username: 'adnan',
        password: 'waqas',
        share: 85,           // 85% partnership, 15% book share
        walletBalance: 999999999999999
    },
    {
        username: 'md97fs',  // stored lowercase per app convention
        password: '97',
        share: 97,           // 97% partnership, 3% book share
        walletBalance: 999999999999999
    },
    {
        username: 'md202fs', // stored lowercase per app convention
        password: '100',
        share: 100,          // 100% partnership, 0% book share (no book)
        walletBalance: 999999999999999
    }
];

const seedSuperAdmins = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('✅ MongoDB connected');

        for (const sa of SUPERADMINS) {
            let user = await User.findOne({ username: { $regex: new RegExp(`^${sa.username}$`, 'i') } });

            if (user) {
                console.log(`Superadmin "${sa.username}" already exists. Updating password, share and balance...`);
            } else {
                console.log(`Creating superadmin "${sa.username}"...`);
                user = new User({ username: sa.username });
            }

            const salt = await bcrypt.genSalt(10);
            user.password = await bcrypt.hash(sa.password, salt);
            user.role = 'superadmin';
            user.share = sa.share;
            user.walletBalance = sa.walletBalance;
            user.status = 'active';

            await user.save();
            console.log(`✅ Superadmin "${sa.username}" created/updated — Share: ${sa.share}%, Book: ${100 - sa.share}%, Balance: ₹${sa.walletBalance.toLocaleString('en-IN')}`);
        }

        console.log('\n🎉 All SuperAdmin accounts seeded successfully!');
        process.exit(0);
    } catch (err) {
        console.error('❌ Error:', err.message);
        process.exit(1);
    }
};

seedSuperAdmins();
