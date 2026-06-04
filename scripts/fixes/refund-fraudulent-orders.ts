import '../../server/env';

import { Command } from 'commander';
import { QueryTypes } from 'sequelize';

import { refundTransaction } from '../../server/lib/payments';
import models, { sequelize } from '../../server/models';

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
    type: QueryTypes.SELECT,
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

function parseCommandLineArguments() {
  const program = new Command()
    .description('Refund Fraudulent Orders based on parameters')
    .option('--mask <mask>', 'The request mask to look for')
    .option('--guest <guest>', 'Pass "true" to limit to guest contributions')
    .option('--amount <amount>', 'The request totalAmount to look for')
    .option('--fromCollectiveId <id>', 'The fromCollectiveId to look for')
    .option('--run', 'Perform the changes.', false)
    .parse(process.argv);

  const opts = program.opts();
  return {
    dryRun: !opts.run,
    reqMask: opts.mask,
    isGuest: opts.guest,
    totalAmount: opts.amount,
    fromCollectiveId: opts.fromCollectiveId,
  };
}

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
