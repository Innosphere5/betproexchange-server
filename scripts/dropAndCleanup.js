/**
 * Drop the suspensionaudits collection to free ~360MB.
 * Atlas may allow drop() even when write quota is exceeded.
 * Then fix the two corrupted matches.
 */
const mongoose = require('mongoose');
require('dotenv').config();

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('✅ Connected to MongoDB');
  const db = mongoose.connection.db;

  // Attempt 1: drop() the collection entirely
  try {
    console.log('🗑️ Dropping suspensionaudits collection...');
    await db.dropCollection('suspensionaudits');
    console.log('✅ suspensionaudits dropped successfully!');
  } catch (e) {
    console.log('❌ Drop failed:', e.message);
    
    // Attempt 2: use the compact/runCommand approach 
    try {
      console.log('Trying deleteMany in small batches...');
      const col = db.collection('suspensionaudits');
      let totalDeleted = 0;
      for (let i = 0; i < 100; i++) {
        const batch = await col.find({}).limit(5000).project({ _id: 1 }).toArray();
        if (batch.length === 0) break;
        const ids = batch.map(d => d._id);
        const r = await col.deleteMany({ _id: { $in: ids } });
        totalDeleted += r.deletedCount;
        if (totalDeleted % 50000 === 0) console.log(`   Deleted ${totalDeleted} so far...`);
      }
      console.log(`   Total deleted: ${totalDeleted}`);
    } catch (e2) {
      console.log('❌ Batch delete also failed:', e2.message);
      console.log('⚠️ The Atlas free tier blocks ALL writes (including deletes) when over quota.');
      console.log('⚠️ You need to either:');
      console.log('   1. Upgrade to M2 tier ($9/mo) temporarily in Atlas console');
      console.log('   2. Or wait for Atlas to auto-compact (may take hours)');
    }
  }

  // Now try to fix matches
  console.log('\n🔧 Attempting match fixes...');
  const Match = db.collection('matches');
  
  try {
    // NZ v India
    const r1 = await Match.updateOne(
      { matchId: 'id2703194973528276' },
      {
        $set: { status: 'upcoming', score: {}, marketStatus: null, bookmakerMarketStatus: null, statusText: null, isTestMatch: true, lastUpdated: new Date() },
        $unset: { oddsApiEventId: '', winner: '' }
      }
    );
    console.log(`✅ NZ v India fix: ${r1.modifiedCount} modified`);
    
    // SA v Bangladesh
    const r2 = await Match.updateOne(
      { matchId: 'id2701556069238758' },
      {
        $set: { status: 'upcoming', score: {}, marketStatus: null, bookmakerMarketStatus: null, statusText: null, lastUpdated: new Date() },
        $unset: { oddsApiEventId: '', winner: '' }
      }
    );
    console.log(`✅ SA v Bangladesh fix: ${r2.modifiedCount} modified`);
    
    // Check for other wrongly-live future matches
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const wronglyLive = await Match.find({ status: 'live', startTime: { $gt: tomorrow } }).toArray();
    for (const m of wronglyLive) {
      await Match.updateOne(
        { matchId: m.matchId },
        { $set: { status: 'upcoming', score: {}, marketStatus: null, bookmakerMarketStatus: null, statusText: null, lastUpdated: new Date() }, $unset: { oddsApiEventId: '', winner: '' } }
      );
      console.log(`✅ Fixed: ${m.teamA} v ${m.teamB} (${m.matchId})`);
    }
  } catch (e) {
    console.log('❌ Match fix failed:', e.message);
  }

  await mongoose.disconnect();
  console.log('\n✅ Done.');
}

run().catch(err => { console.error('❌', err.message); process.exit(1); });
