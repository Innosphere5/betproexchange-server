const { distributeProfitLoss, distributeCasinoPL } = require('../services/hierarchyService');

// Mocking User and Transaction models
const mockUsers = {
    'test_bettor': { _id: 'b1', username: 'test_bettor', parentId: 'shagufta', share: 0, role: 'user' },
    'shagufta': { _id: 's1', username: 'shagufta', parentId: 'test_superadmin', share: 25, role: 'master', walletBalance: 0 },
    'test_superadmin': { _id: 'sa1', username: 'test_superadmin', parentId: null, share: 100, role: 'superadmin', walletBalance: 0 }
};

const User = require('../models/User');
const Transaction = require('../models/Transaction');

// Monkey patch Mongoose models for testing
User.findOne = async ({ username }) => mockUsers[username] || null;
User.findById = async (id) => Object.values(mockUsers).find(u => u._id === id.toString() || u.username === id) || null;
User.findByIdAndUpdate = async (id, update) => {
    const user = Object.values(mockUsers).find(u => u._id === id.toString());
    if (user && update.$inc) {
        user.walletBalance = (user.walletBalance || 0) + update.$inc.walletBalance;
    }
    return user;
};
Transaction.create = async (data) => {
    console.log(`[MOCK TX] User: ${data.userId} | Amount: ${data.amount} | Type: ${data.type} | Desc: ${data.description}`);
    return data;
};

async function test() {
    console.log("\n--- TEST: Casino Profit (House wins 1000) ---");
    // Bettor (test_bettor) -> Master (shagufta) -> Superadmin (test_superadmin)
    // Expected for Shagufta: "Share from test_bettor (25%)"
    // Expected for Superadmin: "Share from shagufta (75%)"
    await distributeCasinoPL('test_bettor', 1000);
}

test().catch(console.error);
