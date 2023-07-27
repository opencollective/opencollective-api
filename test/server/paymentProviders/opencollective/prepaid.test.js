import { expect } from 'chai';
import { v4 as uuid } from 'uuid';

import * as libpayments from '../../../../server/lib/payments';
import models from '../../../../server/models';
import prepaid from '../../../../server/paymentProviders/opencollective/prepaid';
import * as store from '../../../stores';
import { randEmail } from '../../../stores';
import * as utils from '../../../utils';

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
      type: 'ORGANIZATION',
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
      service: 'opencollective',
      type: 'prepaid',
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

    const transactions = await prepaid.processOrder(orderData);
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

    return expect(prepaid.processOrder(orderData)).to.be.rejectedWith(
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

    const transaction = await prepaid.processOrder(orderData);
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

// Some legacy tests that were moved from `server/graphql/v1/createOrder.opencollective`
describe('server/paymentProviders/opencollective/prepaid (2)', () => {
  describe('prepaid', () => {
    describe('#getBalance', () => {
      before(utils.resetTestDB);

      it('should error if payment method is not a prepaid', async () => {
        expect(prepaid.getBalance({ service: 'opencollective', type: 'giftcard' })).to.be.eventually.rejectedWith(
          Error,
          'Expected opencollective.prepaid but got opencollective.giftcard',
        );
      });

      it('should return initial balance of payment method if nothing was spend on the card', async () => {
        const paymentMethod = await models.PaymentMethod.create({
          service: 'opencollective',
          type: 'prepaid',
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
            service: 'opencollective',
            type: 'prepaid',
            initialBalance: 10000,
            currency: 'USD',
            data: { HostCollectiveId: hostCollective.id },
          },
        });

        // When the above order is executed
        await libpayments.executeOrder(user, order);

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
            service: 'opencollective',
            type: 'prepaid',
            initialBalance: 10000,
            currency: 'USD',
          },
        });

        // When the above order is executed; Then the transaction
        // should be unsuccessful.
        await expect(libpayments.executeOrder(user, order)).to.be.eventually.rejectedWith(
          Error,
          'Prepaid payment method must have a value for `data.HostCollectiveId`',
        );
      }); /* End of "should fail if payment method does not have a host id" */

      it('should fail if payment method from someone else is used', async () => {
        const pmData = {
          CollectiveId: user2.CollectiveId,
          CreatedByUserId: user2.id,
          service: 'opencollective',
          type: 'prepaid',
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
            service: 'opencollective',
            type: 'prepaid',
            initialBalance: 10000,
            currency: 'USD',
            data: { HostCollectiveId: 2000 },
          },
        });

        // When the above order is executed; Then the transaction
        // should be unsuccessful.
        await expect(libpayments.executeOrder(user, order)).to.be.eventually.rejectedWith(
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
