/**
 * Free up MongoDB storage by purging old suspensionaudits,
 * then fix corrupted match data.
 */
const mongoose = require('mongoose');
require('dotenv').config();

async function freeSpaceAndCleanup() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('✅ Connected to MongoDB');
  
  const db = mongoose.connection.db;
  
  // ═══════════════════════════════════════════════════════
  // STEP 1: Free space by purging suspensionaudits
  // ═══════════════════════════════════════════════════════
  console.log('\n🗑️ STEP 1: Purging suspensionaudits collection (742k docs, ~360MB)...');
  
  const audits = db.collection('suspensionaudits');
  const auditCount = await audits.countDocuments();
  console.log(`   Current count: ${auditCount}`);
  
  // Keep only last 7 days of audits; delete the rest
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  
  // Try to delete by createdAt first, fallback to drop entire collection
  let result;
  try {
    result = await audits.deleteMany({ createdAt: { $lt: sevenDaysAgo } });
    console.log(`   Deleted ${result.deletedCount} old audits (> 7 days)`);
    
    const remaining = await audits.countDocuments();
    console.log(`   Remaining: ${remaining}`);
    
    // If still too many, delete more (keep only last 1 day)
    if (remaining > 50000) {
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      result = await audits.deleteMany({ createdAt: { $lt: oneDayAgo } });
      console.log(`   Extra purge: deleted ${result.deletedCount} more (> 1 day)`);
    }
  } catch (e) {
    // If createdAt field doesn't exist, try _id-based deletion (ObjectId encodes timestamp)
    console.log('   No createdAt field, trying _id-based deletion...');
    const cutoffId = mongoose.Types.ObjectId.createFromTime(Math.floor(sevenDaysAgo.getTime() / 1000));
    result = await audits.deleteMany({ _id: { $lt: cutoffId } });
    console.log(`   Deleted ${result.deletedCount} old audits`);
    
    const remaining = await audits.countDocuments();
    if (remaining > 50000) {
      // Nuclear option: drop the whole collection if too big
      console.log(`   Still ${remaining} docs. Dropping entire collection...`);
      await audits.drop();
      console.log(`   ✅ Collection dropped`);
    }
  }

  // ═══════════════════════════════════════════════════════
  // STEP 2: Fix corrupted match data
  // ═══════════════════════════════════════════════════════
  console.log('\n🔧 STEP 2: Fixing corrupted match data...');
  const Match = db.collection('matches');
  
  // 2a. NZ v India upcoming 2nd Test
  const nzIndia = await Match.findOne({ matchId: 'id2703194973528276' });
  if (nzIndia) {
    console.log(`\n   📋 NZ v India (${nzIndia.teamA} v ${nzIndia.teamB}):`);
    console.log(`      status: ${nzIndia.status}, startTime: ${nzIndia.startTime}`);
    console.log(`      has score data: ${JSON.stringify(nzIndia.score || {}).length > 5}`);
    
    const r1 = await Match.updateOne(
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
    console.log(`      ✅ Fixed: ${r1.modifiedCount} doc updated`);
  }
  
  // 2b. SA v Bangladesh future ODI
  const saBan = await Match.findOne({ matchId: 'id2701556069238758' });
  if (saBan) {
    console.log(`\n   📋 SA v Bangladesh (${saBan.teamA} v ${saBan.teamB}):`);
    console.log(`      status: ${saBan.status}, startTime: ${saBan.startTime}`);
    console.log(`      has score data: ${JSON.stringify(saBan.score || {}).length > 5}`);
    
    const r2 = await Match.updateOne(
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
    console.log(`      ✅ Fixed: ${r2.modifiedCount} doc updated`);
  }
  
  // 2c. Check for any other future matches wrongly marked as live
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const wronglyLive = await Match.find({
    status: 'live',
    startTime: { $gt: tomorrow }
  }).toArray();
  
  if (wronglyLive.length > 0) {
    console.log(`\n   ⚠️ Found ${wronglyLive.length} more future matches wrongly set as 'live':`);
    for (const m of wronglyLive) {
      console.log(`      - ${m.teamA} v ${m.teamB} (${m.matchId}) starts ${m.startTime}`);
      await Match.updateOne(
        { matchId: m.matchId },
        {
          $set: { status: 'upcoming', score: {}, marketStatus: null, bookmakerMarketStatus: null, statusText: null, lastUpdated: new Date() },
          $unset: { oddsApiEventId: '', winner: '' }
        }
      );
      console.log(`        ✅ Reset to upcoming`);
    }
  } else {
    console.log('\n   ✅ No other future matches wrongly set to live');
  }

  // Final storage check
  const finalAuditCount = await db.collection('suspensionaudits').countDocuments().catch(() => 0);
  console.log(`\n📊 Final suspensionaudits count: ${finalAuditCount}`);
  
  await mongoose.disconnect();
  console.log('\n✅ All cleanup complete. Disconnected.');
}

freeSpaceAndCleanup().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
