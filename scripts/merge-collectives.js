#!/usr/bin/env ./node_modules/.bin/babel-node
import '../server/env.js';

import { mergeAccounts, simulateMergeAccounts } from '../server/lib/merge-accounts.js';
import { parseToBoolean } from '../server/lib/utils.js';
import models from '../server/models/index.js';

import { confirm } from './common/helpers.js';

const printMergeSummary = async (fromCollective, intoCollective) => {
  console.log('==============================================================');
  console.log(
    `You are about to merge ${fromCollective.slug} (#${fromCollective.id}) into ${intoCollective.slug} (#${intoCollective.id})`,
  );
  console.log('==============================================================');

  const summary = await simulateMergeAccounts(fromCollective, intoCollective);
  console.log(summary);
};

function sleep(ms) {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

async function main() {
  const fromCollective = await models.Collective.findOne({ where: { slug: process.argv[2] } });
  const intoCollective = await models.Collective.findOne({ where: { slug: process.argv[3] } });

  if (!fromCollective) {
    throw new Error(`Collective ${process.argv[2]} does not exist`);
  } else if (!intoCollective) {
    throw new Error(`Collective ${process.argv[3]} does not exist`);
  } else if (fromCollective.id === intoCollective.id) {
    throw new Error('Cannot merge a collective into itself');
  }

  await printMergeSummary(fromCollective, intoCollective);
  console.log('---------------------------------------------------------------');

  let isConfirmed = parseToBoolean(process.env.CONFIRM);
  if (!isConfirmed) {
    isConfirmed = await confirm('This action is irreversible. Are you sure you want to continue? (Yes/No)');
  }
  if (isConfirmed) {
    console.log(
      `\nMerging ${fromCollective.slug} (#${fromCollective.id}) into ${intoCollective.slug} (#${intoCollective.id})...`,
    );
    await sleep(3000); // Wait some time so user can CTRL+C if there's a mistake
    await mergeAccounts(fromCollective, intoCollective);
  } else {
    console.log('Aborting, nothing changed.');
  }
}

if (process.argv.length < 3) {
  console.log(process.argv);
  console.error(`Usage: npm run script ${process.argv[0]} FROM_ACCOUNT_SLUG INTO_ACCOUNT_SLUG`);
  process.exit(1);
}

main()
  .then(() => process.exit())
  .catch(e => {
    console.error(e);
    process.exit(1);
  });
