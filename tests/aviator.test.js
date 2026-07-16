const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { 
  getMultiplierAt, 
  getMsForMultiplier, 
  generateProvablyFairRound 
} = require('../services/aviatorManager');

test('Aviator Growth Curve Math', async (t) => {
  await t.test('getMultiplierAt starts at 1.00', () => {
    assert.equal(getMultiplierAt(0), 1.00);
  });

  await t.test('getMultiplierAt grows exponentially (1.06^t)', () => {
    // 1.06^10 = ~1.79
    const multAt10s = getMultiplierAt(10000);
    assert.ok(multAt10s >= 1.78 && multAt10s <= 1.80, `Expected ~1.79, got ${multAt10s}`);
  });

  await t.test('getMsForMultiplier solves the correct takeoff duration', () => {
    const targetMult = 2.50;
    const msNeeded = getMsForMultiplier(targetMult);
    const calculatedMult = getMultiplierAt(msNeeded);
    
    // Allow minor rounding tolerance (+-0.02) due to float precision
    const diff = Math.abs(calculatedMult - targetMult);
    assert.ok(diff <= 0.02, `Expected close to ${targetMult}, got ${calculatedMult} (diff: ${diff})`);
  });
});

test('Provably Fair Algorithm Integrity', async (t) => {
  await t.test('generateProvablyFairRound outputs correct hashes and valid crashPoint', () => {
    const roundData = generateProvablyFairRound(1);
    
    assert.equal(typeof roundData.serverSeed, 'string');
    assert.equal(roundData.serverSeed.length, 64); // 32 bytes hex
    
    assert.equal(typeof roundData.serverSeedHash, 'string');
    assert.equal(roundData.serverSeedHash.length, 64); // SHA-256 hash length
    
    // Hash check
    const hash = crypto.createHash('sha256').update(roundData.serverSeed).digest('hex');
    assert.equal(roundData.serverSeedHash, hash);
    
    assert.equal(typeof roundData.crashPoint, 'number');
    assert.ok(roundData.crashPoint >= 1.00);
  });

  await t.test('recomputing crashPoint independently from seeds gives identical results', () => {
    const roundData = generateProvablyFairRound(42);
    
    // Recompute manually
    const hash = crypto.createHmac('sha256', roundData.serverSeed)
                       .update(`${roundData.clientSeed}-42`)
                       .digest('hex');
                       
    const h = parseInt(hash.substring(0, 13), 16);
    const e = Math.pow(2, 52);
    
    let crashPoint;
    if (h % 33 === 0) {
      crashPoint = 1.00;
    } else {
      crashPoint = Math.floor((100 * e - h) / (e - h)) / 100;
    }
    crashPoint = Math.max(1.00, parseFloat(crashPoint.toFixed(2)));
    
    assert.equal(roundData.crashPoint, crashPoint);
  });
});
