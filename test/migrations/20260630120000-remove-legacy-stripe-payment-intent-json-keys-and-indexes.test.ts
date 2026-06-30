import { expect } from 'chai';

// @ts-expect-error - migration uses module.exports interop
import migration from '../../migrations/20260630120000-remove-legacy-stripe-payment-intent-json-keys-and-indexes'; // eslint-disable-line import/default
import { sequelize } from '../../server/models';
import { fakeCollective, fakeExpense, fakeOrder, fakeUser, randStr } from '../test-helpers/fake-data';
import { resetTestDB } from '../utils';

const paymentIntent = {
  id: randStr('pi_test'),
  paymentIntentClientSecret: randStr('pi_test_secret'),
  stripeAccount: randStr('acct_test'),
  stripeAccountPublishableSecret: randStr('pk_test'),
};

const previousPaymentIntents = [{ id: randStr('pi_prev_1') }, { id: randStr('pi_prev_2') }];

describe('migrations/20260630120000-remove-legacy-stripe-payment-intent-json-keys-and-indexes', () => {
  beforeEach(async () => {
    await resetTestDB();
  });

  describe('up', () => {
    it('removes legacy paymentIntent key while keeping stripePaymentIntent on Orders', async () => {
      const user = await fakeUser();
      const collective = await fakeCollective();
      const order = await fakeOrder({
        FromCollectiveId: user.CollectiveId,
        CollectiveId: collective.id,
        // @ts-expect-error - paymentIntent is not a valid key on Order.data anymore
        data: { paymentIntent, stripePaymentIntent: paymentIntent },
      });

      await migration.up(sequelize.getQueryInterface());
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

      await migration.up(sequelize.getQueryInterface());
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

      await migration.up(sequelize.getQueryInterface());
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

      await migration.up(sequelize.getQueryInterface());
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

      await migration.up(sequelize.getQueryInterface());
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

      await migration.up(sequelize.getQueryInterface());

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

  describe('down', () => {
    it('restores legacy keys from stripe keys on Orders', async () => {
      const user = await fakeUser();
      const collective = await fakeCollective();
      const order = await fakeOrder({
        FromCollectiveId: user.CollectiveId,
        CollectiveId: collective.id,
        // @ts-expect-error - paymentIntent/previousPaymentIntents are not valid keys on Order.data anymore
        data: { paymentIntent, previousPaymentIntents },
      });

      const queryInterface = sequelize.getQueryInterface();
      await migration.up(queryInterface);
      await migration.down(queryInterface);
      await order.reload();

      // @ts-expect-error - paymentIntent is not a valid key on Order.data anymore
      expect(order.data.paymentIntent).to.deep.equal(paymentIntent);
      // @ts-expect-error - previousPaymentIntents is not a valid key on Order.data anymore
      expect(order.data.previousPaymentIntents).to.deep.equal(previousPaymentIntents);
      expect(order.data.stripePaymentIntent).to.deep.equal(paymentIntent);
      expect(order.data.previousStripePaymentIntents).to.deep.equal(previousPaymentIntents);
    });

    it('recreates legacy payment intent indexes', async () => {
      const queryInterface = sequelize.getQueryInterface();
      await migration.up(queryInterface);
      await migration.down(queryInterface);

      const [indexes] = (await sequelize.query(`
        SELECT indexname
        FROM pg_indexes
        WHERE tablename IN ('Orders', 'Expenses')
          AND indexname IN (
            'orders__data__payment_intent_id',
            'expenses__data__payment_intent_id'
          )
      `)) as [{ indexname: string }[], unknown];

      expect(indexes.map(({ indexname }) => indexname).sort()).to.deep.equal([
        'expenses__data__payment_intent_id',
        'orders__data__payment_intent_id',
      ]);
    });
  });
});
