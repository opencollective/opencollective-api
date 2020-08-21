#!/usr/bin/env ./node_modules/.bin/babel-node

import '../server/env';

import { crypto } from '../server/lib/encryption';

if (process.argv.length < 2) {
  console.error('Usage: npm run script ./scripts/encrypt.js CONTENT');
  process.exit(1);
}

const result = crypto.encrypt(process.argv[2]);
console.log(result);
