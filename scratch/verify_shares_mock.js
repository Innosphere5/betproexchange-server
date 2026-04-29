const { distributeProfitLoss, distributeCasinoPL } = require('../services/hierarchyService');

// Mocking User and Transaction models
const mockUsers = {
    'test_bettor': { _id: 'b1', username: 'test_bettor', parentId: 's1', share: 0, role: 'user' },
    'shagufta': { _id: 's1', username: 'shagufta', parentId: 'sa1', share: 25, role: 'master', walletBalance: 0 },
    'test_superadmin': { _id: 'sa1', username: 'test_superadmin', parentId: null, share: 100, role: 'superadmin', walletBalance: 0 }
};

const User = require('../models/User');
const Transaction = require('../models/Transaction');

// Monkey patch Mongoose models for testing
User.findOne = async ({ username }) => mockUsers[username] || null;
User.findById = async (id) => Object.values(mockUsers).find(u => u._id === id.toString()) || null;
User.findByIdAndUpdate = async (id, update) => {
    const user = Object.values(mockUsers).find(u => u._id === id.toString());
    if (user && update.$inc) {
        user.walletBalance = (user.walletBalance || 0) + update.$inc.walletBalance;
    }
    return user;
};
Transaction.create = async (data) => {
    console.log(`[MOCK TX] User: ${data.userId} | Amount: ${data.amount} | Type: ${data.type}`);
    return data;
};

async function test() {
    console.log("\n--- TEST 1: Casino Profit (House wins 1000) ---");
    mockUsers['shagufta'].walletBalance = 0;
    mockUsers['test_superadmin'].walletBalance = 0;
    await distributeCasinoPL('test_bettor', 1000);
    console.log(`Shagufta: ${mockUsers['shagufta'].walletBalance} (Expected 250)`);
    console.log(`SuperAdmin: ${mockUsers['test_superadmin'].walletBalance} (Expected 750)`);

    console.log("\n--- TEST 2: Casino Loss (House loses 1000) ---");
    mockUsers['shagufta'].walletBalance = 0;
    mockUsers['test_superadmin'].walletBalance = 0;
    await distributeCasinoPL('test_bettor', -1000);
    console.log(`Shagufta: ${mockUsers['shagufta'].walletBalance} (Expected -250)`);
    console.log(`SuperAdmin: ${mockUsers['test_superadmin'].walletBalance} (Expected -750)`);

    console.log("\n--- TEST 3: Cricket Profit (House wins 1000) ---");
    mockUsers['shagufta'].walletBalance = 0;
    mockUsers['test_superadmin'].walletBalance = 0;
    await distributeProfitLoss('test_bettor', 1000);
    console.log(`Shagufta: ${mockUsers['shagufta'].walletBalance} (Expected 250)`);
    console.log(`SuperAdmin: ${mockUsers['test_superadmin'].walletBalance} (Expected 750)`);
}

test().catch(console.error);
