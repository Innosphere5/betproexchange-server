const dns = require('dns').promises;

dns.setServers(['8.8.8.8', '8.8.4.4']);

async function testDns() {
  try {
    console.log('Resolving SRV for _mongodb._tcp.betpro.v2ovyxx.mongodb.net...');
    const srv = await dns.resolveSrv('_mongodb._tcp.betpro.v2ovyxx.mongodb.net');
    console.log('SRV Records:', JSON.stringify(srv, null, 2));
    
    console.log('\nResolving TXT for betpro.v2ovyxx.mongodb.net...');
    const txt = await dns.resolveTxt('betpro.v2ovyxx.mongodb.net');
    console.log('TXT Records:', JSON.stringify(txt, null, 2));
  } catch (err) {
    console.error('DNS Error:', err);
  }
}

testDns();

