const mongoose = require('mongoose');
const { updateOdds } = require('../services/oddsService');
require('dotenv').config();

async function triggerUpdate() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('Connected to DB. Triggering Odds Update...');
    await updateOdds();
    console.log('Update cycle finished.');
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

triggerUpdate();
