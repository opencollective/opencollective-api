import { expect } from 'chai';

import models from '../../../../server/models';
import collectivePaymentProvider from '../../../../server/paymentProviders/opencollective/collective';
import testPaymentProvider from '../../../../server/paymentProviders/opencollective/test';
import * as store from '../../../stores';
import * as utils from '../../../utils';

describe('server/paymentProviders/opencollective/collective', () => {
  before(async () => {
    await utils.resetTestDB();
  });

  describe('Refunds', () => {
    let user, fromCollective, toCollective, host;

    /** Create an order from `collective1` to `collective2` */
    const createOrder = async (fromCollective, toCollective, amount = 5000) => {
      const paymentMethod = await models.PaymentMethod.findOne({
        where: { type: 'collective', service: 'opencollective', CollectiveId: fromCollective.id },
      });

      const order = await models.Order.create({
        CreatedByUserId: fromCollective.CreatedByUserId,
        FromCollectiveId: fromCollective.id,
        CollectiveId: toCollective.id,
        totalAmount: amount,
        currency: 'USD',
        status: 'PENDING',
        PaymentMethodId: paymentMethod.id,
      });

      // Bind some required properties
      order.collective = toCollective;
      order.fromCollective = fromCollective;
      order.createByUser = user;
      order.paymentMethod = paymentMethod;
      return order;
    };

    const checkBalances = async (expectedFrom, expectedTo) => {
      expect(await fromCollective.getBalance()).to.eq(expectedFrom);
      expect(await toCollective.getBalance()).to.eq(expectedTo);
    };

    before('Create initial data', async () => {
      host = await models.Collective.create({ name: 'Host', currency: 'USD', isActive: true });
      user = await models.User.createUserWithCollective({ email: store.randEmail(), name: 'User 1' });
      const collectiveParams = {
        currency: 'USD',
        HostCollectiveId: host.id,
        isActive: true,
        approvedAt: new Date(),
        type: 'COLLECTIVE',
        CreatedByUserId: user.id,
      };
      fromCollective = await models.Collective.create({ name: 'collective1', ...collectiveParams });
      toCollective = await models.Collective.create({ name: 'collective2', ...collectiveParams });
    });

    it('Creates the opposite transactions', async () => {
      await checkBalances(0, 0);
      const orderData = await createOrder(fromCollective, toCollective);
      const transaction = await testPaymentProvider.processOrder(orderData);
      await checkBalances(-5000, 5000);

      const refund = await collectivePaymentProvider.refundTransaction(transaction, user);
      await checkBalances(0, 0);

      expect(refund.amount).to.eq(transaction.amount);
      expect(refund.currency).to.eq(transaction.currency);
      expect(refund.platformFeeInHostCurrency).to.eq(0);
      expect(refund.hostFeeInHostCurrency).to.eq(0);
      expect(refund.paymentProcessorFeeInHostCurrency).to.eq(0);
      expect(refund.kind).to.eq(transaction.kind);
    });

    it('Cannot reimburse money if it exceeds the Collective balance', async () => {
      await checkBalances(0, 0);
      const orderData = await createOrder(fromCollective, toCollective);
      const transaction = await testPaymentProvider.processOrder(orderData);
      await checkBalances(-5000, 5000);
      const orderData2 = await createOrder(toCollective, fromCollective, 2500);
      await testPaymentProvider.processOrder(orderData2);
      await checkBalances(-2500, 2500);
      await expect(collectivePaymentProvider.refundTransaction(transaction, user)).to.be.rejectedWith(
        'Not enough funds available ($25.00 left) to process this refund ($50.00)',
      );
    }); /** END OF "Cannot reimburse money that exceeds Collective balance" */
  });
}); /** END OF "payments.collectiveToCollective.test" */
