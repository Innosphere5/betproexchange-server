const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const User = require('../models/User');

const createAdmin = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('✅ MongoDB connected');

        // Drop the problematic index if it exists
        try {
            await mongoose.connection.collection('users').dropIndex('userId_1');
            console.log('✅ Dropped orphaned index userId_1');
        } catch (e) {
            console.log('ℹ️ Index userId_1 not found or already dropped');
        }

        const username = 'Adnan';
        const password = 'waqas';

        let user = await User.findOne({ username });

        if (user) {
            console.log('Admin user Adnan already exists. Updating password and role...');
        } else {
            console.log('Creating admin user Adnan...');
            user = new User({ username });
        }

        const salt = await bcrypt.genSalt(10);
        user.password = await bcrypt.hash(password, salt);
        user.role = 'admin';
        user.walletBalance = user.walletBalance || 1000000; // Give admin a lot of money

        await user.save();
        console.log(`✅ Admin user ${username} created/updated successfully!`);
        process.exit(0);
    } catch (err) {
        console.error('❌ Error:', err.message);
        process.exit(1);
    }
};

createAdmin();
