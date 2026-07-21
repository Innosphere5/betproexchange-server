const { getHandRank } = require('../services/teenPattiManager');

console.log("==========================================");
console.log("🃏 RUNNING REFACTORED TEEN PATTI ENGINE TEST 🃏");
console.log("==========================================");

function makeCards(cardStrings) {
  const suitsMap = { h: '♥', d: '♦', c: '♣', s: '♠' };
  const valuesMap = {
    '2': 0, '3': 1, '4': 2, '5': 3, '6': 4, '7': 5, '8': 6, '9': 7, '10': 8,
    'J': 9, 'Q': 10, 'K': 11, 'A': 12
  };
  return cardStrings.map(str => {
    const val = str.slice(0, -1);
    const suitChar = str.slice(-1);
    return {
      value: val,
      suit: suitsMap[suitChar],
      rank: valuesMap[val]
    };
  });
}

const tests = [
  {
    name: "Trail comparison: AAA > KKK",
    handA: makeCards(["Ah", "Ad", "Ac"]),
    handB: makeCards(["Kh", "Kd", "Kc"]),
    expectedWinner: 'A'
  },
  {
    name: "Pure Sequence: A-2-3 (lowest) < 2-3-4",
    handA: makeCards(["Ah", "2h", "3h"]),
    handB: makeCards(["2d", "3d", "4d"]),
    expectedWinner: 'B'
  },
  {
    name: "Sequence vs Color: 4-5-6 Run > Flush Ah-Jh-5h",
    handA: makeCards(["4h", "5d", "6c"]),
    handB: makeCards(["Ah", "Jh", "5h"]),
    expectedWinner: 'A' // Sequence category 3000 > Color category 2000
  },
  {
    name: "Pair vs High Card: Pair of Kings > Ace High",
    handA: makeCards(["Kh", "Kd", "2c"]),
    handB: makeCards(["Ah", "Qd", "Jc"]),
    expectedWinner: 'A'
  },
  {
    name: "Pair comparison (same pair, kicker kicker): KK-A > KK-Q",
    handA: makeCards(["Kh", "Kd", "Ac"]),
    handB: makeCards(["Ks", "Kc", "Qd"]),
    expectedWinner: 'A'
  }
];

let failed = 0;
for (const test of tests) {
  const rankA = getHandRank(test.handA);
  const rankB = getHandRank(test.handB);
  
  const winner = rankA.score > rankB.score ? 'A' : rankA.score < rankB.score ? 'B' : 'TIE';
  const passed = winner === test.expectedWinner;
  
  console.log(`${passed ? '✅' : '❌'} Test: ${test.name}`);
  console.log(`   - Player A (${rankA.type}): ${test.handA.map(c=>c.value+c.suit).join(' ')} (Score: ${rankA.score})`);
  console.log(`   - Player B (${rankB.type}): ${test.handB.map(c=>c.value+c.suit).join(' ')} (Score: ${rankB.score})`);
  console.log(`   - Result: ${winner} wins`);

  if (!passed) {
    failed++;
  }
}

if (failed === 0) {
  console.log("\n🎉 ALL LOGIC TESTS PASSED SUCCESSFULLY! 🎉");
  process.exit(0);
} else {
  console.log(`\n❌ VERIFICATION FAILED: ${failed} logic errors found. ❌`);
  process.exit(1);
}
