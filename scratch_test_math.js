const accountSummary = {
  'master1': { baseGreen: 100, baseRed: 0 },
  'master2': { baseGreen: 0, baseRed: 100 },
  'admin1': { baseGreen: 700, baseRed: 0 }, // For Superadmin
};

const currentUser = { role: 'admin', share: 30 };
const childShares = { 'master1': 20, 'master2': 20, 'admin1': 30 };

const pShare = currentUser.role === 'superadmin' ? 100 : (currentUser.share || 0);

for (const name in accountSummary) {
  const s = accountSummary[name];
  const childShare = childShares[name] || 0;
  
  let green = 0;
  let red = 0;

  if (pShare > childShare) {
    green = s.baseGreen * (100 - childShare) / (pShare - childShare);
    red = s.baseRed * (100 - childShare) / (pShare - childShare);
  } else if (pShare === 100) {
     green = s.baseGreen;
     red = s.baseRed;
  }

  console.log(`${name} -> Settlement Green: ${green}, Red: ${red}`);
}
