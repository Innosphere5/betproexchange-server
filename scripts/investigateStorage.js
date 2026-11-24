/**
 * Investigate MongoDB storage usage per collection and find deletable data.
 */
const mongoose = require('mongoose');
require('dotenv').config();

async function investigate() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('✅ Connected to MongoDB');
  
  const db = mongoose.connection.db;
  
  // List all collections with their stats
  const collections = await db.listCollections().toArray();
  console.log(`\n📊 Collections (${collections.length}):\n`);
  
  let totalDocs = 0;
  const stats = [];
  
  for (const col of collections) {
    try {
      const collStats = await db.command({ collStats: col.name });
      const sizeMB = (collStats.size / (1024 * 1024)).toFixed(2);
      const storageMB = (collStats.storageSize / (1024 * 1024)).toFixed(2);
      const indexMB = (collStats.totalIndexSize / (1024 * 1024)).toFixed(2);
      stats.push({ name: col.name, docs: collStats.count, sizeMB, storageMB, indexMB });
      totalDocs += collStats.count;
    } catch (e) {
      stats.push({ name: col.name, docs: '?', sizeMB: '?', storageMB: '?', indexMB: '?' });
    }
  }
  
  // Sort by storage size descending
  stats.sort((a, b) => parseFloat(b.storageMB) - parseFloat(a.storageMB));
  
  for (const s of stats) {
    console.log(`  ${s.name}: ${s.docs} docs, data=${s.sizeMB}MB, storage=${s.storageMB}MB, indexes=${s.indexMB}MB`);
  }
  
  console.log(`\nTotal documents: ${totalDocs}`);
  
  // Check for large/purgeable collections
  // Check old matches that are completed
  const Match = db.collection('matches');
  const completedCount = await Match.countDocuments({ status: 'completed' });
  const liveCount = await Match.countDocuments({ status: 'live' });
  const upcomingCount = await Match.countDocuments({ status: 'upcoming' });
  console.log(`\n🏏 Matches: completed=${completedCount}, live=${liveCount}, upcoming=${upcomingCount}`);
  
  // Check for old completed matches older than 30 days
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const oldCompleted = await Match.countDocuments({ 
    status: 'completed', 
    startTime: { $lt: thirtyDaysAgo }
  });
  console.log(`   Old completed (>30 days): ${oldCompleted}`);
  
  // Check bets
  try {
    const Bets = db.collection('bets');
    const betsCount = await Bets.countDocuments();
    const settledBets = await Bets.countDocuments({ settled: true });
    console.log(`\n💰 Bets: total=${betsCount}, settled=${settledBets}`);
  } catch (e) { }
  
  // Check if there's a sessions collection
  try {
    const sessions = db.collection('sessions');
    const sessCount = await sessions.countDocuments();
    console.log(`\n🔑 Sessions: ${sessCount}`);
  } catch (e) { }
  
  // Check for log-like collections
  for (const name of ['logs', 'events', 'notifications', 'activities', 'audits', 'bethistories', 'transactions', 'ledgers']) {
    try {
      const col = db.collection(name);
      const count = await col.countDocuments();
      if (count > 0) console.log(`  📝 ${name}: ${count} docs`);
    } catch (e) { }
  }

  await mongoose.disconnect();
}

investigate().catch(err => { console.error(err); process.exit(1); });
