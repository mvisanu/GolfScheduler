/**
 * get-cert.js — Obtain a trusted Let's Encrypt certificate via DuckDNS DNS challenge.
 * Run once: node get-cert.js
 * Re-run every ~60 days to renew before the 90-day expiry.
 */

require('dotenv').config();
const acme    = require('acme-client');
const https   = require('https');
const fs      = require('fs');
const path    = require('path');

const DOMAIN        = `${process.env.DUCKDNS_DOMAIN}.duckdns.org`;
const TOKEN         = process.env.DUCKDNS_TOKEN;
const SUBDOMAIN     = process.env.DUCKDNS_DOMAIN;
const EMAIL         = process.env.GOLF_EMAIL;
const CERT_DIR      = path.join(__dirname, 'data/certs');
const ACCOUNT_KEY   = path.join(CERT_DIR, 'account-key.pem');

if (!TOKEN || !SUBDOMAIN || !EMAIL) {
  console.error('Missing required .env values: DUCKDNS_TOKEN, DUCKDNS_DOMAIN, GOLF_EMAIL');
  process.exit(1);
}

function duckdnsUpdate(txtValue, clear = false) {
  return new Promise((resolve, reject) => {
    const qs = clear
      ? `domains=${SUBDOMAIN}&token=${TOKEN}&txt=cleared&clear=true`
      : `domains=${SUBDOMAIN}&token=${TOKEN}&txt=${encodeURIComponent(txtValue)}&verbose=true`;
    https.get(`https://www.duckdns.org/update?${qs}`, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        console.log(`  DuckDNS response: ${data.split('\n')[0]}`);
        if (clear || data.startsWith('OK')) resolve();
        else reject(new Error('DuckDNS update failed: ' + data));
      });
    }).on('error', reject);
  });
}

const dns = require('dns').promises;

function wait(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function waitForTxt(name, expected, timeoutMs = 180000) {
  // Use Google DNS (8.8.8.8) — same resolvers Let's Encrypt tends to use
  const resolver = new (require('dns').Resolver)();
  resolver.setServers(['8.8.8.8', '8.8.4.4']);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const records = await resolver.resolveTxt(name);
      const flat = records.flat();
      if (flat.includes(expected)) {
        console.log('  DNS TXT confirmed on Google DNS — waiting 15s buffer...');
        await wait(15000);
        return;
      }
    } catch {}
    process.stdout.write('  Still waiting for DNS propagation...\r');
    await wait(10000);
  }
  console.log('  DNS not confirmed but proceeding anyway...');
}

async function main() {
  fs.mkdirSync(CERT_DIR, { recursive: true });

  // Reuse or create account key
  let accountKey;
  if (fs.existsSync(ACCOUNT_KEY)) {
    console.log('Using existing account key...');
    accountKey = fs.readFileSync(ACCOUNT_KEY);
  } else {
    console.log('Generating new account key...');
    accountKey = await acme.crypto.createPrivateKey();
    fs.writeFileSync(ACCOUNT_KEY, accountKey);
  }

  const client = new acme.Client({
    directoryUrl: acme.directory.letsencrypt.production,
    accountKey,
  });

  console.log(`Requesting certificate for: ${DOMAIN}`);
  const [key, csr] = await acme.crypto.createCsr({ commonName: DOMAIN });

  const cert = await client.auto({
    csr,
    email: EMAIL,
    termsOfServiceAgreed: true,
    challengePriority: ['dns-01'],

    challengeCreateFn: async (authz, challenge, keyAuthorization) => {
      console.log(`\nSetting DNS TXT record: _acme-challenge.${SUBDOMAIN}`);
      console.log(`  Value: ${keyAuthorization}`);
      await duckdnsUpdate(keyAuthorization);
      await waitForTxt(`_acme-challenge.${SUBDOMAIN}.duckdns.org`, keyAuthorization);
    },

    challengeRemoveFn: async () => {
      console.log('\nCleaning up DNS TXT record...');
      await duckdnsUpdate('', true);
    },
  });

  fs.writeFileSync(path.join(CERT_DIR, 'key.pem'), key.toString());
  fs.writeFileSync(path.join(CERT_DIR, 'cert.pem'), cert);

  console.log('\n✓ Certificate saved to data/certs/');
  console.log('  Restart the web server: npm run web');
  console.log('  Certificate expires in ~90 days — re-run node get-cert.js to renew.');
}

main().catch(err => {
  console.error('\nFailed:', err.message);
  process.exit(1);
});
