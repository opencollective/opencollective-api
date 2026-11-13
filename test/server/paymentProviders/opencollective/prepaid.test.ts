import { expect } from 'chai';
import sinon from 'sinon';
import { v4 as uuid } from 'uuid';

import { CollectiveType } from '../../../../server/constants/collectives';
import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../../../../server/constants/paymentMethods';
import * as LibCurrency from '../../../../server/lib/currency';
import { executeOrder } from '../../../../server/lib/payments';
import type { Transaction } from '../../../../server/models';
import models from '../../../../server/models';
import prepaid from '../../../../server/paymentProviders/opencollective/prepaid';
import * as store from '../../../stores';
import { randEmail } from '../../../stores';
import * as utils from '../../../utils';

/** These providers always return the created transaction; the shared signature also allows `void`. */
const processOrder = async (provider, order): Promise<Transaction> =>
  (await provider.processOrder(order)) as Transaction;

describe('server/paymentProviders/opencollective/prepaid', () => {
  const PREPAID_INITIAL_BALANCE = 5000;
  const CURRENCY = 'USD';
  let user = null;
  let hostCollective = null;
  let targetCollective = null;
  let prepaidPm = null;
  let hostAdmin = null;

  before(async () => {
    hostAdmin = await models.User.createUserWithCollective({ name: '___', email: randEmail() });
    hostCollective = await models.Collective.create({
      type: CollectiveType.ORGANIZATION,
      name: 'Test HOST',
      currency: CURRENCY,
      isActive: true,
      CreatedByUserId: hostAdmin.id,
    });
  });

  before(async () => {
    user = await models.User.createUserWithCollective({
      name: 'Test Prepaid Donator',
      email: randEmail('prepaid-donator@opencollective.com'),
    });
  });

  before(async () => {
    targetCollective = await models.Collective.create({
      name: 'Test Collective',
      currency: CURRENCY,
      isActive: true,
    }).then(c => (targetCollective = c));
    await targetCollective.addHost(hostCollective, user, { shouldAutomaticallyApprove: true });
  });

  before(async () => {
    prepaidPm = await models.PaymentMethod.create({
      name: 'Host funds',
      initialBalance: PREPAID_INITIAL_BALANCE,
      monthlyLimitPerMember: null,
      currency: CURRENCY,
      CollectiveId: user.collective.id,
      customerId: user.id,
      uuid: uuid(),
      data: { HostCollectiveId: hostCollective.id },
      service: PAYMENT_METHOD_SERVICE.OPENCOLLECTIVE,
      type: PAYMENT_METHOD_TYPE.PREPAID,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  it('get initial balance', async () => {
    const balance = await prepaid.getBalance(prepaidPm);
    expect(balance.amount).to.be.equal(PREPAID_INITIAL_BALANCE);
    expect(balance.currency).to.be.equal(CURRENCY);
  });

  it('create order', async () => {
    const orderData = {
      createdByUser: user,
      fromCollective: user.collective,
      FromCollectiveId: user.collective.id,
      collective: targetCollective,
      CollectiveId: targetCollective.id,
      paymentMethod: prepaidPm,
      totalAmount: 1000,
      currency: 'USD',
    };

    const transactions = await processOrder(prepaid, orderData);
    expect(transactions).to.exist;

    // Check balance decreased
    const balance = await prepaid.getBalance(prepaidPm);
    expect(balance.amount).to.be.equal(PREPAID_INITIAL_BALANCE - 1000);
  });

  it("can't spend more than balance", async () => {
    const balance = await prepaid.getBalance(prepaidPm);
    const orderData = {
      createdByUser: user,
      fromCollective: user.collective,
      FromCollectiveId: user.collective.id,
      collective: targetCollective,
      CollectiveId: targetCollective.id,
      paymentMethod: prepaidPm,
      totalAmount: balance.amount + 1,
      currency: 'USD',
    };

    return expect(processOrder(prepaid, orderData)).to.be.rejectedWith(
      Error,
      "This payment method doesn't have enough funds to complete this order",
    );
  });

  it('refund', async () => {
    const initialBalance = await prepaid.getBalance(prepaidPm);
    const orderData = {
      createdByUser: user,
      fromCollective: user.collective,
      FromCollectiveId: user.collective.id,
      collective: targetCollective,
      CollectiveId: targetCollective.id,
      paymentMethod: prepaidPm,
      totalAmount: 1000,
      currency: 'USD',
    };

    const transaction = await processOrder(prepaid, orderData);
    expect(transaction).to.exist;

    // Check balance decreased
    const balanceAfterOrder = await prepaid.getBalance(prepaidPm);
    expect(balanceAfterOrder.amount).to.be.equal(initialBalance.amount - 1000);

    // Make refund
    await prepaid.refundTransaction(transaction, user);
    const balanceAfterRefund = await prepaid.getBalance(prepaidPm);
    expect(balanceAfterRefund.amount).to.be.equal(initialBalance.amount);
  });
});

describe('server/paymentProviders/opencollective/prepaid (cross-currency)', () => {
  let sandbox, user, hostCollective, targetCollective, prepaidPm;

  before(async () => {
    sandbox = sinon.createSandbox();
    sandbox.stub(LibCurrency, 'getFxRate').callsFake((fromCurrency, toCurrency) => {
      if (fromCurrency === toCurrency) {
        return Promise.resolve(1);
      } else if (fromCurrency === 'USD' && toCurrency === 'JPY') {
        return Promise.resolve(150);
      } else if (fromCurrency === 'JPY' && toCurrency === 'USD') {
        return Promise.resolve(1 / 150);
      }
      throw new Error(`Unexpected getFxRate call: ${fromCurrency} -> ${toCurrency}`);
    });

    const hostAdmin = await models.User.createUserWithCollective({ name: 'Host admin', email: randEmail() });
    hostCollective = await models.Collective.create({
      type: CollectiveType.ORGANIZATION,
      name: 'USD Host',
      currency: 'USD',
      isActive: true,
      CreatedByUserId: hostAdmin.id,
    });
    user = await models.User.createUserWithCollective({ name: 'Prepaid user', email: randEmail() });
    targetCollective = await models.Collective.create({ name: 'USD Collective', currency: 'USD', isActive: true });
    await targetCollective.addHost(hostCollective, user, { shouldAutomaticallyApprove: true });

    // ¥10,000 card
    prepaidPm = await models.PaymentMethod.create({
      name: 'JPY prepaid',
      initialBalance: 1000000,
      currency: 'JPY',
      CollectiveId: user.collective.id,
      uuid: uuid(),
      data: { HostCollectiveId: hostCollective.id },
      service: PAYMENT_METHOD_SERVICE.OPENCOLLECTIVE,
      type: PAYMENT_METHOD_TYPE.PREPAID,
    });
  });

  after(() => {
    sandbox.restore();
  });

  const makeUsdOrder = (totalAmount: number) => ({
    createdByUser: user,
    fromCollective: user.collective,
    FromCollectiveId: user.collective.id,
    collective: targetCollective,
    CollectiveId: targetCollective.id,
    paymentMethod: prepaidPm,
    totalAmount,
    currency: 'USD',
  });

  it('converts the order amount to the card currency before checking the balance', async () => {
    // $50 ~= ¥7,500, fits in the ¥10,000 balance
    await processOrder(prepaid, makeUsdOrder(5000));
    const balance = await prepaid.getBalance(prepaidPm);
    expect(balance).to.deep.equal({ amount: 250000, currency: 'JPY' }); // ¥2,500 left

    // Another $50 ~= ¥7,500 must be rejected, even though 5000 < 250000
    await expect(processOrder(prepaid, makeUsdOrder(5000))).to.be.rejectedWith(
      "This payment method doesn't have enough funds to complete this order",
    );
    expect(await prepaid.getBalance(prepaidPm)).to.deep.equal({ amount: 250000, currency: 'JPY' });
  });
});

// Some legacy tests that were moved from `server/graphql/v1/createOrder.opencollective`
describe('server/paymentProviders/opencollective/prepaid (2)', () => {
  describe('prepaid', () => {
    describe('#getBalance', () => {
      before(utils.resetTestDB);

      it('should error if payment method is not a prepaid', async () => {
        expect(
          prepaid.getBalance({
            service: PAYMENT_METHOD_SERVICE.OPENCOLLECTIVE,
            type: PAYMENT_METHOD_TYPE.GIFTCARD,
          } as Parameters<typeof prepaid.getBalance>[0]),
        ).to.be.eventually.rejectedWith(Error, 'Expected opencollective.prepaid but got opencollective.giftcard');
      });

      it('should return initial balance of payment method if nothing was spend on the card', async () => {
        const paymentMethod = await models.PaymentMethod.create({
          service: PAYMENT_METHOD_SERVICE.OPENCOLLECTIVE,
          type: PAYMENT_METHOD_TYPE.PREPAID,
          initialBalance: 10000,
          currency: 'USD',
        });
        expect(await prepaid.getBalance(paymentMethod)).to.deep.equal({
          amount: 10000,
          currency: 'USD',
        });
      }); /* End of "should return initial balance of payment method if nothing was spend on the card" */

      it('should return initial balance of payment method minus credit already spent', async () => {
        // Given a user & collective
        const { user, userCollective } = await store.newUser('new user');
        const { hostCollective, collective } = await store.newCollectiveWithHost('test', 'USD', 'USD', 0);

        // And given the following order with a payment method
        const { order } = await store.newOrder({
          from: userCollective,
          to: collective,
          amount: 2000,
          currency: 'USD',
          paymentMethodData: {
            customerId: 'new-user',
            service: PAYMENT_METHOD_SERVICE.OPENCOLLECTIVE,
            type: PAYMENT_METHOD_TYPE.PREPAID,
            initialBalance: 10000,
            currency: 'USD',
            data: { HostCollectiveId: hostCollective.id },
          },
        });

        // When the above order is executed
        await executeOrder(user, order);

        // Then the payment method should have the initial balance
        // minus what was already spent.
        expect(await prepaid.getBalance(order.paymentMethod)).to.deep.equal({
          amount: 8000,
          currency: 'USD',
        });
      }); /* End of "should return initial balance of payment method minus credit already spent" */
    }); /* End of "#getBalance" */

    describe('#processOrder', () => {
      let user, user2, userCollective, hostCollective, collective;

      beforeEach(async () => {
        await utils.resetTestDB();
        ({ user, userCollective } = await store.newUser('new user'));
        // for some obscure reason, it doesn't work to copy paste previous line for user2
        user2 = await models.User.createUserWithCollective({ email: store.randEmail(), name: 'new user 2' });
        ({ hostCollective, collective } = await store.newCollectiveWithHost('test', 'USD', 'USD', 10));
      }); /* End of "beforeEach" */

      it('should fail if payment method does not have a host id', async () => {
        // Given the following order with a payment method
        const { order } = await store.newOrder({
          from: userCollective,
          to: collective,
          amount: 2000,
          currency: 'USD',
          paymentMethodData: {
            customerId: 'new-user',
            service: PAYMENT_METHOD_SERVICE.OPENCOLLECTIVE,
            type: PAYMENT_METHOD_TYPE.PREPAID,
            initialBalance: 10000,
            currency: 'USD',
          },
        });

        // When the above order is executed; Then the transaction
        // should be unsuccessful.
        await expect(executeOrder(user, order)).to.be.eventually.rejectedWith(
          Error,
          'Prepaid payment method must have a value for `data.HostCollectiveId`',
        );
      }); /* End of "should fail if payment method does not have a host id" */

      it('should fail if payment method from someone else is used', async () => {
        const pmData: Parameters<typeof models.PaymentMethod.create>[0] = {
          CollectiveId: user2.CollectiveId,
          CreatedByUserId: user2.id,
          service: PAYMENT_METHOD_SERVICE.OPENCOLLECTIVE,
          type: PAYMENT_METHOD_TYPE.PREPAID,
          data: { HostCollectiveId: hostCollective.id },
          currency: 'USD',
          initialBalance: 10000,
        };
        const pm = await models.PaymentMethod.create(pmData);
        // store.newOrder uses Order.setPaymentMethod which should fail if the user cannot use the pm
        try {
          await store.newOrder({
            from: userCollective,
            to: collective,
            amount: 2000,
            currency: 'USD',
            paymentMethodData: {
              uuid: pm.uuid,
            },
          });
        } catch (e) {
          expect(e).to.exist;
          expect(e.message).to.equal(
            "You don't have enough permissions to use this payment method (you need to be an admin of the collective that owns this payment method)",
          );
        }
      }); /* End of "should fail if payment method from someone else is used" */

      it('should fail if from collective and collective are from different hosts ', async () => {
        // Given the following order with a payment method
        const { order } = await store.newOrder({
          from: userCollective,
          to: collective,
          amount: 2000,
          currency: 'USD',
          paymentMethodData: {
            customerId: 'new-user',
            service: PAYMENT_METHOD_SERVICE.OPENCOLLECTIVE,
            type: PAYMENT_METHOD_TYPE.PREPAID,
            initialBalance: 10000,
            currency: 'USD',
            data: { HostCollectiveId: 2000 },
          },
        });

        // When the above order is executed; Then the transaction
        // should be unsuccessful.
        await expect(executeOrder(user, order)).to.be.eventually.rejectedWith(
          Error,
          'Prepaid method can only be used in collectives from the same host',
        );
      }); /* End of "should fail if from collective and collective are from different hosts" */

      it('should fail to place an order if there is not enough balance', () => {
        // not implemented
      }); /* End of "should fail to place an order if there is not enough balance" */
    }); /* End of "#processOrder" */
  }); /* End of "prepaid" */
});
