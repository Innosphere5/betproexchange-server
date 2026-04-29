const mongoose = require('mongoose');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const { distributeProfitLoss, distributeCasinoPL } = require('../services/hierarchyService');

async function runTest() {
    try {
        await mongoose.connect('mongodb://localhost:27017/betproexchange');
        console.log("Connected to DB");

        // Setup Test Hierarchy
        // SuperAdmin -> Shagufta (Master, 25%) -> Bettor
        
        await User.deleteMany({ username: { $in: ['test_superadmin', 'shagufta', 'test_bettor'] } });
        await Transaction.deleteMany({ userId: { $in: ['test_superadmin', 'shagufta', 'test_bettor'] } });

        const superadmin = await User.create({
            username: 'test_superadmin',
            password: 'pw',
            role: 'superadmin',
            walletBalance: 0,
            share: 100
        });

        const shagufta = await User.create({
            username: 'shagufta',
            password: 'pw',
            role: 'master',
            walletBalance: 0,
            share: 25,
            parentId: superadmin._id
        });

        const bettor = await User.create({
            username: 'test_bettor',
            password: 'pw',
            role: 'user',
            walletBalance: 1000,
            parentId: shagufta._id
        });

        console.log("\n--- TEST 1: Casino Profit (House wins 1000) ---");
        // House Profit = 1000 (Bettor lost)
        // Expected: 
        // 5% Comm = 50 (to Superadmin as platform comm?)
        // Shagufta (25%) = 250
        // Superadmin (Remainder) = 700
        await distributeCasinoPL('test_bettor', 1000);

        let s_bal = await User.findOne({ username: 'shagufta' });
        let sa_bal = await User.findOne({ username: 'test_superadmin' });
        console.log(`Shagufta Balance: ${s_bal.walletBalance} (Expected 250)`);
        console.log(`SuperAdmin Balance: ${sa_bal.walletBalance} (Expected 750 total: 700 share + 50 comm)`);

        console.log("\n--- TEST 2: Casino Loss (House loses 1000) ---");
        // Reset balances
        await User.updateMany({}, { walletBalance: 0 });
        
        // House Loss = -1000 (Bettor won)
        // Expected:
        // Shagufta (25%) = -250
        // Superadmin (Remainder) = -750
        await distributeCasinoPL('test_bettor', -1000);

        s_bal = await User.findOne({ username: 'shagufta' });
        sa_bal = await User.findOne({ username: 'test_superadmin' });
        console.log(`Shagufta Balance: ${s_bal.walletBalance} (Expected -250)`);
        console.log(`SuperAdmin Balance: ${sa_bal.walletBalance} (Expected -750)`);

        console.log("\n--- TEST 3: Cricket Profit (House wins 1000) ---");
        // Reset balances
        await User.updateMany({}, { walletBalance: 0 });
        
        // House Profit = 1000 (Bettor lost)
        // Expected:
        // Shagufta (25%) = 250
        // Superadmin (Remainder) = 750
        await distributeProfitLoss('test_bettor', 1000);

        s_bal = await User.findOne({ username: 'shagufta' });
        sa_bal = await User.findOne({ username: 'test_superadmin' });
        console.log(`Shagufta Balance: ${s_bal.walletBalance} (Expected 250)`);
        console.log(`SuperAdmin Balance: ${sa_bal.walletBalance} (Expected 750)`);

        console.log("\nTest Completed");
        process.exit();
    } catch (err) {
        console.error("Test Failed", err);
        process.exit(1);
    }
}

runTest();
