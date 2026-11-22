#!/usr/bin/env node
/**
 * Application-profile oracle checks against NEWSLETTER_BASE_URL.
 * Exit 0 on pass. Does not print stored addresses.
 */
import { randomBytes } from 'node:crypto';

const base = (process.env.NEWSLETTER_BASE_URL || 'http://127.0.0.1:3100').replace(/\/$/, '');
const check = process.argv[2];

async function main() {
  switch (check) {
    case 'health':
      await assertHealth();
      break;
    case 'reject-empty':
      await assertRejectEmpty();
      break;
    case 'accept-valid':
      await assertAcceptValid();
      break;
    case 'store-not-public':
      await assertStoreNotPublic();
      break;
    default:
      console.error(`Unknown check: ${check ?? '(missing)'}`);
      process.exit(2);
  }
}

async function assertHealth() {
  const res = await fetch(`${base}/api/health`);
  if (res.status !== 200) {
    console.error(`health expected 200, got ${res.status}`);
    process.exit(1);
  }
  console.log('health 200');
}

async function assertRejectEmpty() {
  const res = await fetch(`${base}/api/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: '' }),
  });
  if (res.status < 400) {
    console.error(`empty email expected 4xx, got ${res.status}`);
    process.exit(1);
  }
  console.log(`empty email rejected ${res.status}`);
}

async function assertAcceptValid() {
  const token = randomBytes(6).toString('hex');
  const email = `demo-${token}@example.com`;
  const res = await fetch(`${base}/api/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  if (res.status < 200 || res.status >= 300) {
    console.error(`valid email expected 2xx, got ${res.status}`);
    process.exit(1);
  }
  console.log(`valid email accepted ${res.status}`);
}

async function assertStoreNotPublic() {
  const paths = [
    '/data/signups.json',
    '/signups.json',
    '/api/signups',
    '/.data/signups.json',
  ];
  for (const path of paths) {
    const res = await fetch(`${base}${path}`);
    if (res.status === 200) {
      console.error(`stored file must not be public: ${path} returned 200`);
      process.exit(1);
    }
  }
  console.log('stored file not public');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
