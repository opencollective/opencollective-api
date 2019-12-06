#!/usr/bin/env node
import '../../server/env';

import logger from '../../server/lib/logger';
import models, { Ops } from '../../server/models';
import * as libPayments from '../../server/lib/payments';

// Only run on the first of the month
const today = new Date();
//const date = today.getDate();
//const month = today.getMonth();
const year = today.getFullYear();

const date = 1;
const month = 12;

// if (process.env.NODE_ENV === 'production' && today.getDate() !== 1) {
//   console.log('NODE_ENV is production and today is not the first of month, script aborted!');
//   process.exit();
// }

process.env.PORT = 3066;

const fetchExpiringCreditCards = async () => {
  const expiringCards = await models.PaymentMethod.findAll({
    where: {
      CollectiveId: 10901,
      type: 'creditcard',
      data: {
        expMonth: 12,
        expYear: 2019,
      },
    },
    order: [['id', 'DESC']],
  });

  return expiringCards;
};

const run = async () => {
  console.log('runnin');

  const cards = await fetchExpiringCreditCards();

  // cards.forEach(card => {
  //   console.log(card.id, card.data, card.CollectiveId)
  // })

  cards.forEach(async card => {
    try {
      await libPayments.sendExpiringCreditCardUpdateEmail(card);
    } catch (e) {
      console.log(e);
    }
  });

  logger.info('Done sending credit card update emails.');
  process.exit();
};

run();
