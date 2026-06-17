const mongoose = require('mongoose');
mongoose.connect('mongodb://127.0.0.1:27017/betproexchange').then(async () => {
  const User = require('./models/User');
  const Transaction = require('./models/Transaction');
  const { distributeProfitLoss } = require('./services/hierarchyService');
  
  await User.deleteMany({ username: { $in: ['testsa', 'testa', 'testm', 'testb'] } });
  
  const sa = await User.create({ username: 'testsa', password: '123', role: 'superadmin', walletBalance: 0 });
  const a = await User.create({ username: 'testa', password: '123', role: 'admin', share: 30, parentId: sa._id, walletBalance: 0 });
  const m = await User.create({ username: 'testm', password: '123', role: 'master', share: 20, parentId: a._id, walletBalance: 0 });
  const b = await User.create({ username: 'testb', password: '123', role: 'user', parentId: m._id, walletBalance: 0 });
  
  console.log("Distributing 950 profit (which means amount is 950 or -950 depending on house perspective)");
  await distributeProfitLoss('testb', 950, { matchName: 'Test Match' });
  
  const sa_u = await User.findOne({ username: 'testsa' });
  const a_u = await User.findOne({ username: 'testa' });
  const m_u = await User.findOne({ username: 'testm' });
  
  console.log('Superadmin:', sa_u.walletBalance);
  console.log('Admin:', a_u.walletBalance);
  console.log('Master:', m_u.walletBalance);
  
  mongoose.disconnect();
});
