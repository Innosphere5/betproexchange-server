const mongoose = require('mongoose');
const User = require('../models/User');
mongoose.connect('mongodb://127.0.0.1:27017/betproexchange').then(async () => {
  const users = await User.find({}).lean();
  console.log("=== ALL USERS ===");
  for (const u of users) {
    console.log(`Username: ${u.username}, Role: ${u.role}`);
  }
  mongoose.disconnect();
}).catch(err => {
  console.error(err);
});
