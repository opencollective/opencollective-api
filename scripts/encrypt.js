#!/usr/bin/env ./node_modules/.bin/ts-node

import '../server/env.js';

import { crypto } from '../server/lib/encryption.js';

if (process.argv.length < 2) {
  console.error('Usage: npm run script ./scripts/encrypt.js [+d] CONTENT');
  process.exit(1);
}

const run = () => {
  const decrypt = process.argv[2] === '+d';
  const string = decrypt ? process.argv.slice(3).join(' ') : process.argv.slice(2).join(' ');

  console.log(decrypt ? crypto.decrypt(string) : crypto.encrypt(string));
};

import { pathToFileURL } from 'url';

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run();
}
