#!/usr/bin/env ./node_modules/.bin/ts-node
import '../../server/env.js';

import { ArgumentParser } from 'argparse';

import { refundTransaction } from '../../server/lib/payments.js';
import models, { sequelize } from '../../server/models/index.js';

const refundOrder = async (order, { dryRun }) => {
  const transactions = await order.getTransactions();
  const alreadyRefunded = transactions.some(t => t.isRefund === true);
  if (alreadyRefunded) {
    console.log('Order already refunded, skipping...');
    return;
  } else {
    const mainTransaction = transactions.find(
      t => t.isRefund === false && t.kind === 'CONTRIBUTION' && t.type === 'CREDIT',
    );
    console.log(`Refunding transaction #${mainTransaction.id}...`);
    if (!dryRun) {
      mainTransaction.PaymentMethod = await models.PaymentMethod.findByPk(mainTransaction.PaymentMethodId);
      await refundTransaction(mainTransaction, null, 'Fraudulent transaction');
    }
    console.log('Done.');
  }
};

async function main({ dryRun, totalAmount, reqMask, isGuest, fromCollectiveId }) {
  if (dryRun) {
    console.info('RUNNING IN DRY MODE!');
  }
  if (!reqMask && !totalAmount && !isGuest && !fromCollectiveId) {
    throw new Error('Not enough parameters');
  } else if (totalAmount && !isGuest && !reqMask && !fromCollectiveId) {
    throw new Error(
      'Not enough parameters: totalAmount should be used together with isGuest, reqMask or fromCollectiveId',
    );
  } else if (isGuest && !totalAmount && !reqMask) {
    throw new Error('Not enough parameters: isGuest should be used together with totalAmount or reqMask');
  }

  const query = `
    SELECT o.*
    FROM "Orders" as o
    INNER JOIN "Transactions" t ON t."OrderId" = o."id"
    WHERE
      o."deletedAt" IS NULL
      AND o."status" = 'PAID'
      AND o."totalAmount" > 0
      AND t."kind" = 'CONTRIBUTION'
      AND t."type" = 'CREDIT'
      AND t."RefundTransactionId" IS NULL
      ${fromCollectiveId ? `AND o."FromCollectiveId" = ${fromCollectiveId}` : ''}
      ${totalAmount ? `AND o."totalAmount" = '${totalAmount}'` : ''}
      ${reqMask ? `AND o."data"->>'reqMask' = '${reqMask}'` : ''}
      ${isGuest ? `AND (o."data"->>'isGuest')::boolean IS TRUE` : ''}
    GROUP BY o."id"
    ORDER BY o."createdAt"
    ;
  `;
  console.log('Searching for fraudulent orders with:');
  console.log(query);
  const orders = await sequelize.query(query, {
    type: sequelize.QueryTypes.SELECT,
    model: models.Order,
    mapToModel: true,
  });

  for (const order of orders) {
    console.log(`\nProcessing order #${order.id}...`);
    try {
      await refundOrder(order, { dryRun });
    } catch (e) {
      console.log(e);
    }
  }
}

/* eslint-disable camelcase */
function parseCommandLineArguments() {
  const parser = new ArgumentParser({
    add_help: true,
    description: 'Refund Fraudulent Orders based on parameters',
  });

  parser.add_argument('--mask', {
    help: 'The request mask to look for',
  });

  parser.add_argument('--guest', {
    help: 'Pass "true" to limit to guest contributions',
  });

  parser.add_argument('--amount', {
    help: 'The request totalAmount to look for',
  });

  parser.add_argument('--fromCollectiveId', {
    help: 'The fromCollectiveId to look for',
  });

  parser.add_argument('--run', {
    help: 'Perform the changes.',
    default: false,
    action: 'store_const',
    const: true,
  });

  const args = parser.parse_args();
  return {
    dryRun: !args.run,
    reqMask: args.mask,
    isGuest: args.guest,
    totalAmount: args.amount,
    fromCollectiveId: args.fromCollectiveId,
  };
}
/* eslint-enable camelcase */

if (require.main === module) {
  main(parseCommandLineArguments())
    .then(() => {
      process.exit(0);
    })
    .catch(e => {
      console.error(e);
      process.exit(1);
    });
}
