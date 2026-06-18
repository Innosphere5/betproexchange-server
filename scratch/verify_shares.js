/**
 * Verification Script: Share Distribution Math
 * 
 * Tests the new 85/15 direct share model:
 *   SuperAdmin → Admin(30%) → Master(20%) → Bettor
 *   Bettor loses 1000
 *
 * Expected:
 *   Master:     20% × 1000 = 200
 *   Admin:      30% × 1000 = 300
 *   SuperAdmin: (85 - 30 - 20)% × 1000 = 350
 *   Book:       15% × 1000 = 150
 *   Total: 200 + 300 + 350 + 150 = 1000 ✓
 */

const BOOK_SHARE_PERCENT = 15;
const SUPERADMIN_TOTAL_PERCENT = 85;

function simulateDistribution(amount, adminShare, masterShare) {
    console.log(`\n=== Simulating distribution of ${amount} ===`);
    console.log(`Admin Share: ${adminShare}%, Master Share: ${masterShare}%`);
    console.log('---');

    // Book
    const bookAmount = (BOOK_SHARE_PERCENT / 100) * amount;
    console.log(`Book (${BOOK_SHARE_PERCENT}%): ${bookAmount}`);

    // Master
    const masterAmount = (masterShare / 100) * amount;
    console.log(`Master (${masterShare}%): ${masterAmount}`);

    // Admin
    const adminAmount = (adminShare / 100) * amount;
    console.log(`Admin (${adminShare}%): ${adminAmount}`);

    // SuperAdmin
    const superAdminPercent = SUPERADMIN_TOTAL_PERCENT - adminShare - masterShare;
    const superAdminAmount = (superAdminPercent / 100) * amount;
    console.log(`SuperAdmin (${superAdminPercent}%): ${superAdminAmount}`);

    const total = bookAmount + masterAmount + adminAmount + superAdminAmount;
    console.log(`---`);
    console.log(`Total: ${total} (expected: ${amount})`);
    console.log(`Match: ${total === amount ? '✅ PASS' : '❌ FAIL'}`);

    return total === amount;
}

// Test cases
let allPass = true;
allPass &= simulateDistribution(1000, 30, 20);   // User's example
allPass &= simulateDistribution(500, 40, 10);     // Different shares
allPass &= simulateDistribution(-750, 30, 20);    // Negative (bettor won)
allPass &= simulateDistribution(10000, 50, 25);   // Larger amounts
allPass &= simulateDistribution(1000, 0, 0);      // No child shares (all goes to SA + Book)

console.log(`\n${'='.repeat(40)}`);
console.log(`Overall: ${allPass ? '✅ ALL TESTS PASSED' : '❌ SOME TESTS FAILED'}`);
