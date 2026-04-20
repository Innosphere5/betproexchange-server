const mongoose = require('mongoose');
require('dotenv').config();
const { settleMatch } = require('../services/settlementService');
const Bet = require('../models/Bet');
const User = require('../models/User');

async function test() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('Connected to DB');

        const testMatchId = "test_match_123";
        const testUserId = "testuser";

        // 1. Create a dummy user if not exists
        let user = await User.findOne({ username: testUserId });
        if (!user) {
            user = new User({ username: testUserId, walletBalance: 10000, password: 'password', role: 'user' });
            await user.save();
        } else {
            // Reset balance for clean test
            user.walletBalance = 10000;
            await user.save();
        }
        console.log('Initial Balance:', user.walletBalance);

        // 2. Create a dummy matched bet
        const bet = new Bet({
            userId: testUserId,
            matchId: testMatchId,
            matchName: "Test Team A v Test Team B",
            runner: "Test Team A",
            stake: 1000,
            odds: 2.5,
            type: 'back',
            status: 'MATCHED'
        });
        await bet.save();
        console.log('Dummy Bet Saved');

        // 3. Trigger settlement for WIN
        console.log('Settling as WIN...');
        // We pass a mock io object to avoid errors but it will log to console
        await settleMatch(testMatchId, "Test Team A", { emit: (event, data) => console.log(`[Socket Mock] ${event}:`, data) });

        const updatedUser = await User.findOne({ username: testUserId });
        const updatedBet = await Bet.findById(bet._id);

        console.log('Final Balance (Expected 12500):', updatedUser.walletBalance);
        console.log('Bet Status (Expected WIN):', updatedBet.status);

        // 4. Test REFUND
        console.log('\nTesting REFUND logic...');
        const refundBet = new Bet({
            userId: testUserId,
            matchId: "refund_match",
            matchName: "Refund v Test",
            runner: "Refund",
            stake: 500,
            odds: 2.0,
            type: 'back',
            status: 'MATCHED'
        });
        await refundBet.save();
        
        const balanceBeforeRefund = updatedUser.walletBalance;
        await settleMatch("refund_match", "REFUND", { emit: (event, data) => {} });
        
        const userAfterRefund = await User.findOne({ username: testUserId });
        console.log('Balance After Refund (Expected ' + (balanceBeforeRefund + 500) + '):', userAfterRefund.walletBalance);

        // Clean up
        await Bet.deleteMany({ userId: testUserId });
        // await User.deleteOne({ username: testUserId }); // Keep user for future tests if needed
        console.log('Test Complete. Cleaned up bets.');
        
        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}

test();
