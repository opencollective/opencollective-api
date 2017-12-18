/*
 * This script tells us which Stripe subscriptions are inactive
 */

import models from '../server/models';

const done = (err) => {
  if (err) console.log('err', err);
  console.log('done!');
  process.exit();
}

const createTransaction = (order) => {
    const collective = order.collective;
    const { hostFeePercent } = collective;

    // Now we record a new transaction
    const newTransaction = {
      OrderId: order.id,
      amount: order.totalAmount,
      currency: order.currency,
      hostCurrency: balanceTransaction.currency,
      amountInHostCurrency: balanceTransaction.amount,
      hostCurrencyFxRate: order.totalAmount/balanceTransaction.amount,
      hostFeeInHostCurrency: parseInt(balanceTransaction.amount*hostFeePercent/100, 10),
      platformFeeInHostCurrency: fees.applicationFee,
      paymentProcessorFeeInHostCurrency: fees.stripeFee,
      description: `${order.Subscription.interval}ly recurring subscription`,
    };

    debug("stripeSubscription", stripeSubscription);
    debug("balanceTransaction", balanceTransaction);
    debug("newTransaction", newTransaction);

    models.Transaction.createFromPayload({
      CreatedByUserId: order.CreatedByUserId,
      FromCollectiveId: order.FromCollectiveId,
      CollectiveId: order.CollectiveId,
      transaction: newTransaction,
      PaymentMethodId: order.PaymentMethodId
    })
    .then(t => cb(null, t))
    .catch(cb);
}

function run() {
  const subscriptionsProcessed = 0;
  return models.Order.findAll({
    where: { 
      SubscriptionId: {
        $ne: null
      }
    },
    include: [
      { model: models.Subscription,
        where: { 
          isActive: true,
          data: {
            $ne: null
          }
        }
      },
      { model: models.Collective, as: 'collective'},
    ],
    order: ['id']
  })
  .filter(o => o.Subscription.data.manual)
  .then(orders => {
    console.log('>>> orders found ', orders.length)
    return orders
  })
  .each(order => {
    console.log('order id: ', order.id, '| subscription id', order.Subscription.id, ' | slug', order.collective.slug, ' | amount', order.currency, order.totalAmount, 'cents');


    return Promise.resolve();
  })
  .then(() => console.log("Orders updated: ", subscriptionsProcessed))
  .then(() => done())
  .catch(done)
}

run();