function normalize(name) {
    return name ? name.toLowerCase().trim().replace(/[^a-z0-9 ]/g, '') : '';
}

function matches(nameA, nameB) {
    const nA = normalize(nameA);
    const nB = normalize(nameB);
    
    if (nA === nB) return true;
    
    // Check if one contains the other
    if (nA.includes(nB) || nB.includes(nA)) return true;
    
    // Check first word (often the main city/team name)
    const firstWordA = nA.split(' ')[0];
    const firstWordB = nB.split(' ')[0];
    if (firstWordA.length > 3 && firstWordA === firstWordB) return true;
    
    // Common aliases
    const aliases = {
        'bengaluru': 'bangalore',
        'bangalore': 'bengaluru',
        'lucknow': 'lucknow super giants',
        'rcb': 'royal challengers bangalore'
    };
    
    if (aliases[nA] === nB || aliases[nB] === nA) return true;
    
    return false;
}

const testCases = [
    ['Lucknow Super Giants', 'Lucknow Super Giants', true],
    ['Royal Challengers Bengaluru', 'Royal Challengers Bangalore', true],
    ['Malta', 'Malta', true],
    ['India', 'Ind', true],
    ['Australia', 'Aus', false], // Might be too aggressive, let's see
    ['Kolkata Knight Riders', 'KKR', false], // Need alias
];

console.log('Testing Matching Logic:');
testCases.forEach(([a, b, expected]) => {
    const result = matches(a, b);
    console.log(`${a} vs ${b} -> ${result} (Expected: ${expected}) ${result === expected ? '✅' : '❌'}`);
});
