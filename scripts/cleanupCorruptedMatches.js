/**
 * One-time cleanup script: Fix corrupted match data
 * 
 * 1. NZ v India (id2703194973528276): Has stale Day 2 Stumps score from 1st Test
 *    → Clear score, reset to clean upcoming state
 * 
 * 2. SA v Bangladesh (id2701556069238758): Future ODI showing as live with Test scores
 *    → Reset status to upcoming, clear score data
 */

const mongoose = require('mongoose');
require('dotenv').config();

const MONGO_URI = process.env.MONGO_URI;

async function cleanup() {
  await mongoose.connect(MONGO_URI);
  console.log('✅ Connected to MongoDB');

  const Match = mongoose.model('Match', new mongoose.Schema({}, { strict: false, collection: 'matches' }));

  // 1. Fix NZ v India upcoming 2nd Test
  const nzIndia = await Match.findOne({ matchId: 'id2703194973528276' });
  if (nzIndia) {
    console.log(`\n📋 NZ v India BEFORE:`);
    console.log(`   status: ${nzIndia.status}, startTime: ${nzIndia.startTime}`);
    console.log(`   score: ${JSON.stringify(nzIndia.score || {}).substring(0, 200)}`);
    console.log(`   oddsApiEventId: ${nzIndia.oddsApiEventId}`);
    console.log(`   isTestMatch: ${nzIndia.isTestMatch}`);

    const result1 = await Match.updateOne(
      { matchId: 'id2703194973528276' },
      {
        $set: {
          status: 'upcoming',
          score: {},
          marketStatus: null,
          bookmakerMarketStatus: null,
          statusText: null,
          isTestMatch: true,
          lastUpdated: new Date()
        },
        $unset: {
          oddsApiEventId: '',
          winner: ''
        }
      }
    );
    console.log(`   ✅ Fixed: ${result1.modifiedCount} doc(s) updated`);
  } else {
    console.log('⚠️ NZ v India match id2703194973528276 not found');
  }

  // 2. Fix SA v Bangladesh future ODI
  const saBan = await Match.findOne({ matchId: 'id2701556069238758' });
  if (saBan) {
    console.log(`\n📋 SA v Bangladesh BEFORE:`);
    console.log(`   status: ${saBan.status}, startTime: ${saBan.startTime}`);
    console.log(`   score: ${JSON.stringify(saBan.score || {}).substring(0, 200)}`);
    console.log(`   oddsApiEventId: ${saBan.oddsApiEventId}`);

    const result2 = await Match.updateOne(
      { matchId: 'id2701556069238758' },
      {
        $set: {
          status: 'upcoming',
          score: {},
          marketStatus: null,
          bookmakerMarketStatus: null,
          statusText: null,
          lastUpdated: new Date()
        },
        $unset: {
          oddsApiEventId: '',
          winner: ''
        }
      }
    );
    console.log(`   ✅ Fixed: ${result2.modifiedCount} doc(s) updated`);
  } else {
    console.log('⚠️ SA v Bangladesh match id2701556069238758 not found');
  }

  // Also check if any other future matches have been wrongly set to 'live'
  const now = new Date();
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const wronglyLive = await Match.find({
    status: 'live',
    startTime: { $gt: tomorrow }
  }).select('matchId teamA teamB startTime').lean();

  if (wronglyLive.length > 0) {
    console.log(`\n⚠️ Found ${wronglyLive.length} more future matches wrongly set as 'live':`);
    for (const m of wronglyLive) {
      console.log(`   - ${m.teamA} v ${m.teamB} (${m.matchId}) starts ${m.startTime}`);
      await Match.updateOne(
        { matchId: m.matchId },
        {
          $set: {
            status: 'upcoming',
            score: {},
            marketStatus: null,
            bookmakerMarketStatus: null,
            statusText: null,
            lastUpdated: new Date()
          },
          $unset: { oddsApiEventId: '', winner: '' }
        }
      );
      console.log(`     ✅ Reset to upcoming`);
    }
  } else {
    console.log('\n✅ No other future matches wrongly set to live');
  }

  await mongoose.disconnect();
  console.log('\n✅ Cleanup complete. Disconnected.');
}

cleanup().catch(err => {
  console.error('❌ Cleanup failed:', err);
  process.exit(1);
});
