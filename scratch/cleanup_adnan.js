const mongoose = require('mongoose');
require('dotenv').config();
const User = require('../models/User');

const cleanup = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        
        // Delete all users that match 'adnan' case-insensitively
        const result = await User.deleteMany({ username: { $regex: /^adnan$/i } });
        console.log(`Deleted ${result.deletedCount} old 'adnan' users.`);

        // Create a fresh clean superadmin
        const bcrypt = require('bcryptjs');
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash('waqas', salt);

        const superAdmin = new User({
            username: 'adnan',
            password: hashedPassword,
            role: 'superadmin',
            share: 100,
            walletBalance: 999999999
        });

        await superAdmin.save();
        console.log('Created fresh superadmin: adnan / waqas');

        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
};

cleanup();
