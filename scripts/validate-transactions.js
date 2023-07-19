import '../server/env.js';

import models, { Op, sequelize } from '../server/models/index.js';

async function run() {
  let page = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    console.log(`Page ${page}`);
    const transactions = await models.Transaction.findAll({
      where: {
        [Op.and]: [
          // { createdAt: { [Op.gte]: '2019-12-31' } },
          // { createdAt: { [Op.lte]: '2020-06-01' } },
        ],
      },
      order: [['createdAt', 'DESC']],
      limit: 1000,
      offset: page * 1000,
    });

    if (transactions.length === 0) {
      break;
    }

    console.log('Batch info', transactions.length, transactions[0]?.id, transactions[0]?.createdAt);

    for (const transaction of transactions) {
      try {
        await models.Transaction.validate(transaction, { validateOppositeTransaction: true });
      } catch (err) {
        console.log(transaction.id, transaction.TransactionGroup);
        console.log(err.message);
      }
    }

    page++;
  }

  await sequelize.close();
}

run();
