import { expect } from 'chai';

// @ts-expect-error - migration uses module.exports interop
import migration from '../../migrations/20260625120000-backfill-stripe-payment-intent-data-and-indexes'; // eslint-disable-line import/default
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

describe('migrations/20260625120000-backfill-stripe-payment-intent-data-and-indexes', () => {
  beforeEach(async () => {
    await resetTestDB();
  });

  describe('up', () => {
    it('backfills stripePaymentIntent from paymentIntent on Orders', async () => {
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

      // @ts-expect-error - paymentIntent is not a valid key on Order.data anymore
      expect(order.data.paymentIntent).to.deep.equal(paymentIntent);
      expect(order.data.stripePaymentIntent).to.deep.equal(paymentIntent);
    });

    it('backfills previousStripePaymentIntents from previousPaymentIntents on Orders', async () => {
      const user = await fakeUser();
      const collective = await fakeCollective();
      const order = await fakeOrder({
        FromCollectiveId: user.CollectiveId,
        CollectiveId: collective.id,
        // @ts-expect-error - previousPaymentIntents is not a valid key on Order.data anymore
        data: { previousPaymentIntents },
      });

      await migration.up(sequelize.getQueryInterface());
      await order.reload();

      // @ts-expect-error - previousPaymentIntents is not a valid key on Order.data anymore
      expect(order.data.previousPaymentIntents).to.deep.equal(previousPaymentIntents);
      expect(order.data.previousStripePaymentIntents).to.deep.equal(previousPaymentIntents);
    });

    it('backfills both payment intent fields on Orders when both are present', async () => {
      const user = await fakeUser();
      const collective = await fakeCollective();
      const order = await fakeOrder({
        FromCollectiveId: user.CollectiveId,
        CollectiveId: collective.id,
        // @ts-expect-error - paymentIntent/previousPaymentIntents are not valid keys on Order.data anymore
        data: { paymentIntent, previousPaymentIntents },
      });

      await migration.up(sequelize.getQueryInterface());
      await order.reload();

      expect(order.data.stripePaymentIntent).to.deep.equal(paymentIntent);
      expect(order.data.previousStripePaymentIntents).to.deep.equal(previousPaymentIntents);
    });

    it('backfills stripePaymentIntent from paymentIntent on Expenses', async () => {
      const expense = await fakeExpense({
        data: { paymentIntent },
      });

      await migration.up(sequelize.getQueryInterface());
      await expense.reload();

      expect(expense.data.paymentIntent).to.deep.equal(paymentIntent);
      expect(expense.data.stripePaymentIntent).to.deep.equal(paymentIntent);
    });

    it('backfills previousStripePaymentIntents from previousPaymentIntents on Expenses', async () => {
      const expense = await fakeExpense({
        data: { previousPaymentIntents },
      });

      await migration.up(sequelize.getQueryInterface());
      await expense.reload();

      expect(expense.data.previousPaymentIntents).to.deep.equal(previousPaymentIntents);
      expect(expense.data.previousStripePaymentIntents).to.deep.equal(previousPaymentIntents);
    });

    it('does not update Orders without payment intent data', async () => {
      const user = await fakeUser();
      const collective = await fakeCollective();
      const order = await fakeOrder({
        FromCollectiveId: user.CollectiveId,
        CollectiveId: collective.id,
        data: { needsConfirmation: true },
      });

      await migration.up(sequelize.getQueryInterface());
      await order.reload();

      expect(order.data.stripePaymentIntent).to.be.undefined;
      expect(order.data.previousStripePaymentIntents).to.be.undefined;
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

      expect(order.data.stripePaymentIntent).to.be.undefined;
    });

    it('does not update soft-deleted Expenses', async () => {
      const expense = await fakeExpense({
        data: { paymentIntent },
      });
      await expense.destroy();

      await migration.up(sequelize.getQueryInterface());
      await expense.reload({ paranoid: false });

      expect(expense.data.stripePaymentIntent).to.be.undefined;
    });

    it('creates stripe payment intent indexes', async () => {
      await migration.up(sequelize.getQueryInterface());

      const [indexes] = (await sequelize.query(`
        SELECT indexname
        FROM pg_indexes
        WHERE tablename IN ('Orders', 'Expenses')
          AND indexname IN (
            'orders__data__stripe_payment_intent_id',
            'expenses__data__stripe_payment_intent_id'
          )
      `)) as [{ indexname: string }[], unknown];

      expect(indexes.map(({ indexname }) => indexname).sort()).to.deep.equal([
        'expenses__data__stripe_payment_intent_id',
        'orders__data__stripe_payment_intent_id',
      ]);
    });
  });

  describe('down', () => {
    it('removes stripe payment intent backfill fields while keeping legacy keys on Orders', async () => {
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
      expect(order.data.stripePaymentIntent).to.be.undefined;
      expect(order.data.previousStripePaymentIntents).to.be.undefined;
    });

    it('removes stripe payment intent backfill fields while keeping legacy keys on Expenses', async () => {
      const expense = await fakeExpense({
        data: { paymentIntent, previousPaymentIntents },
      });

      const queryInterface = sequelize.getQueryInterface();
      await migration.up(queryInterface);
      await migration.down(queryInterface);
      await expense.reload();

      expect(expense.data.paymentIntent).to.deep.equal(paymentIntent);
      expect(expense.data.previousPaymentIntents).to.deep.equal(previousPaymentIntents);
      expect(expense.data.stripePaymentIntent).to.be.undefined;
      expect(expense.data.previousStripePaymentIntents).to.be.undefined;
    });

    it('drops stripe payment intent indexes', async () => {
      const queryInterface = sequelize.getQueryInterface();
      await migration.up(queryInterface);
      await migration.down(queryInterface);

      const [indexes] = (await sequelize.query(`
        SELECT indexname
        FROM pg_indexes
        WHERE tablename IN ('Orders', 'Expenses')
          AND indexname IN (
            'orders__data__stripe_payment_intent_id',
            'expenses__data__stripe_payment_intent_id'
          )
      `)) as [{ indexname: string }[], unknown];

      expect(indexes).to.be.empty;
    });
  });
});
