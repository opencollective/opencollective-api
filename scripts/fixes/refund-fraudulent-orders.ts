#!/usr/bin/env ./node_modules/.bin/babel-node
import '../../server/env';

import moment from 'moment';

import { refundTransaction } from '../../server/lib/payments';
import models, { sequelize } from '../../server/models';

const IS_DRY = !!process.env.DRY;
const START_DATE = process.env.START_DATE && moment.utc(process.env.START_DATE).toISOString();
const AFTER_ORDER_ID = process.env.AFTER_ORDER_ID;

const refundOrder = async order => {
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
    if (!IS_DRY) {
      mainTransaction.PaymentMethod = await models.PaymentMethod.findByPk(mainTransaction.PaymentMethodId);
      await refundTransaction(mainTransaction, null, 'Fraudulent transaction');
    }
    console.log('Done.');
  }
};

const main = async () => {
  if (IS_DRY) {
    console.info('RUNNING IN DRY MODE!');
  }

  const query = `
    SELECT *
    FROM "Orders"
    WHERE
      ("status" ILIKE '%PAID%')
      AND ("totalAmount" = '50')
      AND  "data"->>'isGuest' = 'true'
      ${START_DATE ? `AND "createdAt" >= '${START_DATE}'` : ''}
      ${AFTER_ORDER_ID ? `AND "id" > ${AFTER_ORDER_ID}` : ''}
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
    await refundOrder(order);
  }
};

main()
  .then(() => process.exit())
  .catch(e => {
    console.error(e);
    process.exit(1);
  });
