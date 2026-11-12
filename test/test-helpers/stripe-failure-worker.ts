import { QueryTypes } from 'sequelize';
import sinon from 'sinon';
import type Stripe from 'stripe';

import * as payments from '../../server/lib/payments';
import * as redis from '../../server/lib/redis';
import models, { sequelize } from '../../server/models';
import * as common from '../../server/paymentProviders/stripe/common';
import { stripePaymentIntentFailed, stripePaymentIntentSucceeded } from '../../server/paymentProviders/stripe/webhook';

// An IPC-controlled integration-test worker. No Redis or outbound email is used.
const release = Promise.withResolvers<void>();
sinon.stub(payments, 'sendOrderFailedEmail').resolves();
sinon.stub(payments, 'sendEmailNotifications').resolves();
sinon.stub(redis, 'createRedisClient').resolves(null);

type Command = { type: 'run'; event: Stripe.Event; pause: boolean; success?: boolean } | { type: 'release' };

models.Order.addHook('beforeFind', async options => {
  if (options.transaction) {
    const [backend] = await sequelize.query<{ pid: number }>('SELECT pg_backend_pid() AS pid', {
      transaction: options.transaction,
      type: QueryTypes.SELECT,
    });
    process.send({ type: 'backend', pid: backend.pid });
  }
});

process.on('message', async (command: Command) => {
  if (command.type === 'release') {
    release.resolve();
    return;
  }
  try {
    if (command.success) {
      sinon.stub(common, 'createChargeTransactions').callsFake(async (charge, { order, sqlTransaction }) => {
        if (command.pause) {
          process.send({ type: 'paused' });
          await release.promise;
        }
        return models.Transaction.createFromContributionPayload(
          {
            OrderId: order.id,
            CreatedByUserId: order.CreatedByUserId,
            CollectiveId: order.CollectiveId,
            FromCollectiveId: order.FromCollectiveId,
            amount: order.totalAmount,
            currency: order.currency,
            amountInHostCurrency: order.totalAmount,
            hostCurrency: order.currency,
            hostCurrencyFxRate: 1,
            data: { charge },
          },
          { sequelizeTransaction: sqlTransaction },
        );
      });
    } else if (command.pause) {
      models.Subscription.addHook('afterUpdate', async () => {
        process.send({ type: 'paused' });
        await release.promise;
      });
    }
    await (command.success ? stripePaymentIntentSucceeded(command.event) : stripePaymentIntentFailed(command.event));
    process.send({ type: 'done' });
  } catch (error) {
    process.send({ type: 'error', error: error.stack || error.message });
  } finally {
    await sequelize.close();
    process.disconnect();
  }
});

process.send({ type: 'ready' });
