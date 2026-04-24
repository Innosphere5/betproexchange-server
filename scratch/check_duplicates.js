const mongoose = require('mongoose');
require('dotenv').config();
const User = require('../models/User');

const checkDuplicates = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        const allUsers = await User.find({ username: { $regex: /^adnan$/i } });
        console.log(`Found ${allUsers.length} users matching 'adnan' (case-insensitive):`);
        allUsers.forEach(u => {
            console.log(`- Username: ${u.username}, Role: ${u.role}, ID: ${u._id}`);
        });
        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
};

checkDuplicates();
