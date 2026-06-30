import { expect } from 'chai';

import { runRemoveLegacyJsonKeys } from '../../../scripts/payment-intents/remove-legacy-json-keys';
import { sequelize } from '../../../server/models';
import { fakeCollective, fakeExpense, fakeOrder, fakeUser, randStr } from '../../test-helpers/fake-data';
import { resetTestDB } from '../../utils';

const paymentIntent = {
  id: randStr('pi_test'),
  paymentIntentClientSecret: randStr('pi_test_secret'),
  stripeAccount: randStr('acct_test'),
  stripeAccountPublishableSecret: randStr('pk_test'),
};

const previousPaymentIntents = [{ id: randStr('pi_prev_1') }, { id: randStr('pi_prev_2') }];

describe('scripts/payment-intents/remove-legacy-json-keys', () => {
  beforeEach(async () => {
    await resetTestDB();
  });

  it('removes legacy paymentIntent key while keeping stripePaymentIntent on Orders', async () => {
    const user = await fakeUser();
    const collective = await fakeCollective();
    const order = await fakeOrder({
      FromCollectiveId: user.CollectiveId,
      CollectiveId: collective.id,
      // @ts-expect-error - paymentIntent is not a valid key on Order.data anymore
      data: { paymentIntent, stripePaymentIntent: paymentIntent },
    });

    await runRemoveLegacyJsonKeys(sequelize, 'all');
    await order.reload();

    expect(order.data.stripePaymentIntent).to.deep.equal(paymentIntent);
    // @ts-expect-error - paymentIntent is not a valid key on Order.data anymore
    expect(order.data.paymentIntent).to.be.undefined;
  });

  it('removes legacy previousPaymentIntents key while keeping previousStripePaymentIntents on Orders', async () => {
    const user = await fakeUser();
    const collective = await fakeCollective();
    const order = await fakeOrder({
      FromCollectiveId: user.CollectiveId,
      CollectiveId: collective.id,
      // @ts-expect-error - previousPaymentIntents is not a valid key on Order.data anymore
      data: { previousPaymentIntents, previousStripePaymentIntents: previousPaymentIntents },
    });

    await runRemoveLegacyJsonKeys(sequelize, 'all');
    await order.reload();

    expect(order.data.previousStripePaymentIntents).to.deep.equal(previousPaymentIntents);
    // @ts-expect-error - previousPaymentIntents is not a valid key on Order.data anymore
    expect(order.data.previousPaymentIntents).to.be.undefined;
  });

  it('backfills stripePaymentIntent from paymentIntent before removing legacy keys', async () => {
    const user = await fakeUser();
    const collective = await fakeCollective();
    const order = await fakeOrder({
      FromCollectiveId: user.CollectiveId,
      CollectiveId: collective.id,
      // @ts-expect-error - paymentIntent is not a valid key on Order.data anymore
      data: { paymentIntent },
    });

    await runRemoveLegacyJsonKeys(sequelize, 'all');
    await order.reload();

    expect(order.data.stripePaymentIntent).to.deep.equal(paymentIntent);
    // @ts-expect-error - paymentIntent is not a valid key on Order.data anymore
    expect(order.data.paymentIntent).to.be.undefined;
  });

  it('removes legacy keys on Expenses', async () => {
    const expense = await fakeExpense({
      data: {
        paymentIntent,
        previousPaymentIntents,
        stripePaymentIntent: paymentIntent,
        previousStripePaymentIntents: previousPaymentIntents,
      },
    });

    await runRemoveLegacyJsonKeys(sequelize, 'all');
    await expense.reload();

    expect(expense.data.stripePaymentIntent).to.deep.equal(paymentIntent);
    expect(expense.data.previousStripePaymentIntents).to.deep.equal(previousPaymentIntents);
    expect(expense.data.paymentIntent).to.be.undefined;
    expect(expense.data.previousPaymentIntents).to.be.undefined;
  });

  it('does not update soft-deleted Orders', async () => {
    const user = await fakeUser();
    const collective = await fakeCollective();
    const order = await fakeOrder({
      FromCollectiveId: user.CollectiveId,
      CollectiveId: collective.id,
      // @ts-expect-error - paymentIntent is not a valid key on Order.data anymore
      data: { paymentIntent },
    });
    await order.destroy();

    await runRemoveLegacyJsonKeys(sequelize, 'all');
    await order.reload({ paranoid: false });

    // @ts-expect-error - paymentIntent is not a valid key on Order.data anymore
    expect(order.data.paymentIntent).to.deep.equal(paymentIntent);
    expect(order.data.stripePaymentIntent).to.be.undefined;
  });

  it('drops legacy payment intent indexes', async () => {
    await sequelize.query(`
      CREATE INDEX IF NOT EXISTS "orders__data__payment_intent_id"
      ON "Orders" USING HASH ((data#>>'{paymentIntent,id}'))
      WHERE data#>>'{paymentIntent,id}' IS NOT NULL and "deletedAt" IS NULL;
    `);
    await sequelize.query(`
      CREATE INDEX IF NOT EXISTS "expenses__data__payment_intent_id"
      ON "Expenses" USING HASH ((data#>>'{paymentIntent,id}'))
      WHERE data#>>'{paymentIntent,id}' IS NOT NULL and "deletedAt" IS NULL;
    `);

    await runRemoveLegacyJsonKeys(sequelize, 'all');

    const [indexes] = (await sequelize.query(`
      SELECT indexname
      FROM pg_indexes
      WHERE tablename IN ('Orders', 'Expenses')
        AND indexname IN (
          'orders__data__payment_intent_id',
          'expenses__data__payment_intent_id'
        )
    `)) as [{ indexname: string }[], unknown];

    expect(indexes).to.be.empty;
  });
});
