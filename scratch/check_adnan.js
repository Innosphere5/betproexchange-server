const mongoose = require('mongoose');
require('dotenv').config();
const User = require('../models/User');

const checkUser = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        const user = await User.findOne({ username: 'adnan' });
        if (user) {
            console.log('User adnan found:');
            console.log('Role:', user.role);
            console.log('Share:', user.share);
        } else {
            console.log('User adnan NOT found');
        }
        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
};

checkUser();
