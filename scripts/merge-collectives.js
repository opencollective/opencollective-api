#!/usr/bin/env ./node_modules/.bin/babel-node
import '../server/env';

import readline from 'readline';

import { some } from 'lodash';

import { mergeCollectives } from '../server/lib/collectivelib';
import models, { Op } from '../server/models';

/**
 * Get a summary of all items handled by the `mergeCollectives` function
 */
const getMovedItemsCounts = async fromCollective => {
  return {
    members: await models.Member.aggregate('id', 'COUNT', {
      where: { [Op.or]: [{ MemberCollectiveId: fromCollective.id }, { CollectiveId: fromCollective.id }] },
    }),
    memberInvitations: await models.MemberInvitation.aggregate('id', 'COUNT', {
      where: { [Op.or]: [{ MemberCollectiveId: fromCollective.id }, { CollectiveId: fromCollective.id }] },
    }),
    orders: await models.Order.aggregate('id', 'COUNT', {
      where: { [Op.or]: [{ FromCollectiveId: fromCollective.id }, { CollectiveId: fromCollective.id }] },
    }),
    transactions: await models.Transaction.aggregate('id', 'COUNT', {
      where: { [Op.or]: [{ FromCollectiveId: fromCollective.id }, { CollectiveId: fromCollective.id }] },
    }),
    activities: await models.Update.aggregate('id', 'COUNT', {
      where: { CollectiveId: fromCollective.id },
    }),
    paymentMethods: await models.PaymentMethod.aggregate('id', 'COUNT', {
      where: { CollectiveId: fromCollective.id },
    }),
  };
};

/**
 * Get a summary of all items **not** handled by the `mergeCollectives` function
 */
const getNotMovedItemsCounts = async fromCollective => {
  return {
    applications: await models.Application.aggregate('id', 'COUNT', {
      where: { CollectiveId: fromCollective.id },
    }),
    comments: await models.Comment.aggregate('id', 'COUNT', {
      where: { [Op.or]: [{ FromCollectiveId: fromCollective.id }, { CollectiveId: fromCollective.id }] },
    }),
    commentReactions: await models.CommentReaction.aggregate('id', 'COUNT', {
      where: { FromCollectiveId: fromCollective.id },
    }),
    connectedAccounts: await models.ConnectedAccount.aggregate('id', 'COUNT', {
      where: { CollectiveId: fromCollective.id },
    }),
    conversations: await models.Conversation.aggregate('id', 'COUNT', {
      where: { [Op.or]: [{ FromCollectiveId: fromCollective.id }, { CollectiveId: fromCollective.id }] },
    }),
    expenses: await models.Expense.aggregate('id', 'COUNT', {
      where: { [Op.or]: [{ FromCollectiveId: fromCollective.id }, { CollectiveId: fromCollective.id }] },
    }),
    legalDocuments: await models.LegalDocument.aggregate('id', 'COUNT', {
      where: { CollectiveId: fromCollective.id },
    }),
    notifications: await models.Notification.aggregate('id', 'COUNT', {
      where: { CollectiveId: fromCollective.id },
    }),
    payoutMethods: await models.PayoutMethod.aggregate('id', 'COUNT', {
      where: { CollectiveId: fromCollective.id },
    }),
    requiredLegalDocuments: await models.RequiredLegalDocument.aggregate('id', 'COUNT', {
      where: { HostCollectiveId: fromCollective.id },
    }),
    tiers: await models.Tier.aggregate('id', 'COUNT', {
      where: { CollectiveId: fromCollective.id },
    }),
    updates: await models.Update.aggregate('id', 'COUNT', {
      where: { CollectiveId: fromCollective.id },
    }),
    users: await models.User.aggregate('id', 'COUNT', {
      where: { CollectiveId: fromCollective.id },
    }),
  };
};

const confirmAction = question => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  return new Promise(resolve => {
    rl.question(`${question}\n> `, input => {
      if (input.toLowerCase() === 'yes') {
        resolve(true);
      } else {
        rl.close();
        resolve(false);
      }
    });
  });
};

const printMergeSummary = async (fromCollective, intoCollective) => {
  const movedItemsCounts = await getMovedItemsCounts(fromCollective);
  const notMovedItemsCounts = await getNotMovedItemsCounts(fromCollective);

  console.log('==============================================================');
  console.log(
    `You are about to merge ${fromCollective.slug} (#${fromCollective.id}) into ${intoCollective.slug} (#${intoCollective.id})`,
  );
  console.log('==============================================================');

  const printCounts = counts => {
    Object.entries(counts).forEach(([key, count]) => {
      if (count > 0) {
        console.log(`  - ${key}: ${count}`);
      }
    });
  };

  if (some(movedItemsCounts, count => count > 0)) {
    console.log('The following items will be moved:');
    printCounts(movedItemsCounts);
  }

  if (some(notMovedItemsCounts, count => count > 0)) {
    console.log('The following items will **not** be moved (you need to do that manually):');
    printCounts(notMovedItemsCounts);
  }
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

  const isConfirmed = await confirmAction('This action is irreversible. Are you sure you want to continue? (Yes/No)');
  if (isConfirmed) {
    console.log(
      `\nMerging ${fromCollective.slug} (#${fromCollective.id}) into ${intoCollective.slug} (#${intoCollective.id})...`,
    );
    await sleep(3000); // Wait some time so user can CTRL+C if there's a mistake
    await mergeCollectives(fromCollective, intoCollective);
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
