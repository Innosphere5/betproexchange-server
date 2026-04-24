const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const User = require('../models/User');

const seedSuperAdmin = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('✅ MongoDB connected');

        const username = 'adnan';
        const password = 'waqas';

        let user = await User.findOne({ username: { $regex: new RegExp(`^${username}$`, 'i') } });

        if (user) {
            console.log('Superadmin user adnan already exists. Updating password and role...');
        } else {
            console.log('Creating superadmin user adnan...');
            user = new User({ username });
        }

        const salt = await bcrypt.genSalt(10);
        user.password = await bcrypt.hash(password, salt);
        user.role = 'superadmin';
        user.share = 100;
        user.walletBalance = user.walletBalance || 999999999; 

        await user.save();
        console.log(`✅ Superadmin user ${username} created/updated successfully!`);
        process.exit(0);
    } catch (err) {
        console.error('❌ Error:', err.message);
        process.exit(1);
    }
};

seedSuperAdmin();
