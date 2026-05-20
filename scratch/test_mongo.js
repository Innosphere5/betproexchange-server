const mongoose = require('mongoose');

const uri = "mongodb://gagndeep0101_db_user:gagan_user@ac-pkdkyqy-shard-00-00.v2ovyxx.mongodb.net:27017,ac-pkdkyqy-shard-00-01.v2ovyxx.mongodb.net:27017,ac-pkdkyqy-shard-00-02.v2ovyxx.mongodb.net:27017/?ssl=true&replicaSet=atlas-bebbt8-shard-0&authSource=admin&retryWrites=true&w=majority";

async function testConnection() {
  try {
    console.log('Connecting to MongoDB with standard URI...');
    await mongoose.connect(uri);
    console.log('✅ Connected successfully!');
    await mongoose.disconnect();
  } catch (err) {
    console.error('❌ Connection failed:', err);
  }
}

testConnection();
