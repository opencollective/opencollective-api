import DataLoader from 'dataloader';
import { groupBy } from 'lodash';

import models from '../../models';
import PaymentIntent from '../../models/PaymentIntent';
import Transaction from '../../models/Transaction';

import { sortResultsSimple } from './helpers';

export const generatePaymentIntentTransactionsLoader = (): DataLoader<number, Transaction[]> =>
  new DataLoader(async (paymentIntentIds: number[]) => {
    const transactions = await models.Transaction.findAll({
      where: { PaymentIntentId: paymentIntentIds },
      order: [['id', 'ASC']],
    });

    const transactionsByPaymentIntentId = groupBy(transactions, 'PaymentIntentId');
    return paymentIntentIds.map(id => transactionsByPaymentIntentId[id] || []);
  });

export const generatePaymentIntentByIdLoader = (): DataLoader<number, PaymentIntent> =>
  new DataLoader(async (ids: number[]) => {
    const paymentIntents = await PaymentIntent.findAll({ where: { id: ids } });
    return sortResultsSimple(ids, paymentIntents);
  });
