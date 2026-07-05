require('dotenv').config();
const mongoose = require('mongoose');

async function run() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("Connected to MongoDB");
    
    const User = require('../models/User');
    const users = await User.find({}).select('username role share parentId').lean();
    console.log("USERS IN DATABASE:");
    console.log(JSON.stringify(users, null, 2));
    
  } catch (err) {
    console.error(err);
  } finally {
    await mongoose.disconnect();
  }
}

run();
