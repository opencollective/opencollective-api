import { expect } from 'chai';
import gqlV1 from 'fake-tag';
import { stub } from 'sinon';

import OrderStatuses from '../../../../server/constants/order-status';
import roles from '../../../../server/constants/roles';
import models from '../../../../server/models';
import paypalAdaptive from '../../../../server/paymentProviders/paypal/adaptiveGateway';
import paypalMock from '../../../mocks/paypal';
import {
  fakeCollective,
  fakeOrder,
  fakeOrganization,
  fakePaymentMethod,
  fakeTransaction,
  fakeUser,
} from '../../../test-helpers/fake-data';
import * as utils from '../../../utils';

let host, admin, user, collective, paypalPaymentMethod;

describe('server/graphql/v1/paymentMethods', () => {
  beforeEach(async () => {
    await utils.resetTestDB();
  });

  beforeEach(async () => {
    admin = await models.User.createUserWithCollective({
      name: 'Host Admin',
      email: 'admin@email.com',
    });
  });

  beforeEach(async () => {
    user = await models.User.createUserWithCollective({
      name: 'Xavier',
      currency: 'EUR',
      email: 'xxxx@email.com',
    });
  });

  beforeEach(async () => {
    host = await models.Collective.create({
      name: 'open source collective',
      type: 'ORGANIZATION',
      currency: 'USD',
    });
    await host.addUserWithRole(admin, roles.ADMIN);
    await host.becomeHost(admin);
  });

  beforeEach(() =>
    models.ConnectedAccount.create({
      CollectiveId: host.id,
      service: 'stripe',
    }),
  );

  beforeEach(async () => {
    collective = await models.Collective.create({
      name: 'tipbox',
      type: 'COLLECTIVE',
      isActive: true,
      approvedAt: new Date(),
      currency: 'EUR',
      hostFeePercent: 5,
      HostCollectiveId: host.id,
    });
  });

  beforeEach(() =>
    models.Member.create({
      CollectiveId: collective.id,
      MemberCollectiveId: host.id,
      role: roles.HOST,
      CreatedByUserId: admin.id,
    }),
  );

  beforeEach(() => collective.addUserWithRole(admin, roles.ADMIN));

  beforeEach('create a paypal paymentMethod', () =>
    models.PaymentMethod.create({
      service: 'paypal',
      type: 'adaptive',
      name: 'host@paypal.com',
      data: {
        redirect: 'http://localhost:3000/brusselstogether/collectives/expenses',
      },
      token: 'PA-5GM04696CF662222W',
      CollectiveId: host.id,
    }).then(pm => (paypalPaymentMethod = pm)),
  );

  beforeEach("adding transaction from host (USD) to reimburse user's expense in a European chapter (EUR)", () =>
    models.Transaction.createDoubleEntry({
      CreatedByUserId: admin.id,
      CollectiveId: host.id,
      HostCollectiveId: host.id,
      FromCollectiveId: user.CollectiveId,
      amount: -1000,
      currency: 'EUR',
      hostCurrency: 'USD',
      hostCurrencyFxRate: 1.15,
      amountInHostCurrency: -1150,
      paymentProcessorFeeInHostCurrency: -100,
      netAmountInCollectiveCurrency: -1250,
      PaymentMethodId: paypalPaymentMethod.id,
    }),
  );

  describe('removePaymentMethod', () => {
    const removePaymentMethodQuery = gqlV1`
      mutation RemovePaymentMethod($id: Int!) {
        removePaymentMethod(id: $id) {
          id
        }
      }
    `;

    it('removes payment method', async () => {
      const user = await fakeUser();
      const collective = await fakeCollective({ admin: user });
      const pm = await fakePaymentMethod({
        CollectiveId: collective.id,
      });

      await fakeOrder({
        PaymentMethodId: pm.id,
      });

      const res = await utils.graphqlQuery(
        removePaymentMethodQuery,
        {
          id: pm.id,
        },
        user,
      );

      expect(res.errors).to.not.exist;
      await pm.reload({
        paranoid: false,
      });
      expect(pm.isSoftDeleted()).to.be.true;
    });

    it('removes payment method from inactive subscription', async () => {
      const user = await fakeUser();
      const collective = await fakeCollective({ admin: user });
      const pm = await fakePaymentMethod({
        CollectiveId: collective.id,
      });

      const order = await fakeOrder(
        {
          PaymentMethodId: pm.id,
        },
        { withSubscription: true },
      );

      await order.Subscription.update({ isActive: false });

      const res = await utils.graphqlQuery(
        removePaymentMethodQuery,
        {
          id: pm.id,
        },
        user,
      );

      expect(res.errors).to.not.exist;
      await pm.reload({
        paranoid: false,
      });
      expect(pm.isSoftDeleted()).to.be.true;
    });

    it('cant remove if is an active subscription payment method', async () => {
      const user = await fakeUser();
      const collective = await fakeCollective({ admin: user });
      const pm = await fakePaymentMethod({
        CollectiveId: collective.id,
      });

      await fakeOrder(
        {
          PaymentMethodId: pm.id,
        },
        { withSubscription: true },
      );

      const res = await utils.graphqlQuery(
        removePaymentMethodQuery,
        {
          id: pm.id,
        },
        user,
      );

      expect(res.errors).to.exist;
      await pm.reload({
        paranoid: false,
      });
      expect(pm.isSoftDeleted()).to.be.false;
    });

    it('cant remove if is an active subscription payment method with order processing', async () => {
      const user = await fakeUser();
      const collective = await fakeCollective({ admin: user });
      const pm = await fakePaymentMethod({
        CollectiveId: collective.id,
      });

      await fakeOrder(
        {
          PaymentMethodId: pm.id,
          status: OrderStatuses.PROCESSING,
        },
        { withSubscription: true },
      );

      const res = await utils.graphqlQuery(
        removePaymentMethodQuery,
        {
          id: pm.id,
        },
        user,
      );

      expect(res.errors).to.exist;
      await pm.reload({
        paranoid: false,
      });
      expect(pm.isSoftDeleted()).to.be.false;
    });

    it('cant remove if is an payment method with order processing', async () => {
      const user = await fakeUser();
      const collective = await fakeCollective({ admin: user });
      const pm = await fakePaymentMethod({
        CollectiveId: collective.id,
      });

      await fakeOrder({
        PaymentMethodId: pm.id,
        status: OrderStatuses.PROCESSING,
      });

      const res = await utils.graphqlQuery(
        removePaymentMethodQuery,
        {
          id: pm.id,
        },
        user,
      );

      expect(res.errors).to.exist;
      await pm.reload({
        paranoid: false,
      });
      expect(pm.isSoftDeleted()).to.be.false;
    });
  });

  describe('oauth flow', () => {
    // not implemented
  });

  describe('add funds', () => {
    let hostPaymentMethod;

    beforeEach(async () => {
      hostPaymentMethod = await models.PaymentMethod.findOne({
        where: {
          service: 'opencollective',
          CollectiveId: host.id,
          type: 'host',
        },
      });
    });

    it('gets the list of fromCollectives for the opencollective payment method of the host', async () => {
      // We add funds to the tipbox collective on behalf of Google and Facebook
      const facebook = await fakeOrganization({ name: 'Facebook', currency: 'USD' });
      const google = await fakeOrganization({ name: 'Google', currency: 'USD' });
      const createAddedFunds = org => {
        return fakeTransaction(
          {
            type: 'CREDIT',
            kind: 'ADDED_FUNDS',
            FromCollectiveId: org.id,
            CollectiveId: collective.id,
            PaymentMethodId: hostPaymentMethod.id,
          },
          { createDoubleEntry: true },
        );
      };

      await createAddedFunds(facebook);
      await createAddedFunds(google);

      // We fetch all the fromCollectives using the host paymentMethod
      const paymentMethodQuery = gqlV1/* GraphQL */ `
        query PaymentMethod($id: Int!) {
          PaymentMethod(id: $id) {
            id
            service
            type
            fromCollectives {
              total
              collectives {
                id
                name
              }
            }
          }
        }
      `;
      const result = await utils.graphqlQuery(paymentMethodQuery, { id: hostPaymentMethod.id }, admin);
      result.errors && console.error(result.errors[0]);
      const { total, collectives } = result.data.PaymentMethod.fromCollectives;
      expect(total).to.equal(2);
      const names = collectives.map(c => c.name).sort();
      expect(names[0]).to.equal('Facebook');
      expect(names[1]).to.equal('Google');
    });
  });

  describe('get the balance', () => {
    let preapprovalDetailsStub = null;

    before(() => {
      preapprovalDetailsStub = stub(paypalAdaptive, 'preapprovalDetails').callsFake(() => {
        return Promise.resolve({
          ...paypalMock.adaptive.preapprovalDetails.completed,
          curPaymentsAmount: '12.50',
          maxTotalAmountOfAllPayments: '2000.00',
        });
      });
    });

    after(() => {
      preapprovalDetailsStub.restore();
    });

    it('returns the balance', async () => {
      const collectiveQuery = gqlV1/* GraphQL */ `
        query Collective($slug: String) {
          Collective(slug: $slug) {
            id
            paymentMethods {
              id
              service
              type
              balance
              currency
            }
          }
        }
      `;
      const result = await utils.graphqlQuery(collectiveQuery, { slug: host.slug }, admin);
      result.errors && console.error(result.errors[0]);

      // Ensure PayPal API is called
      expect(result.errors).to.not.exist;
      expect(preapprovalDetailsStub.callCount).to.equal(1);
      expect(preapprovalDetailsStub.firstCall.args).to.eql([paypalPaymentMethod.token]);

      // Ensure balance is returned
      const paymentMethod = result.data.Collective.paymentMethods.find(pm => pm.service.toUpperCase() === 'PAYPAL');
      expect(preapprovalDetailsStub.callCount).to.equal(1);
      expect(paymentMethod.balance).to.equal(198750); // $2000 - $12.50
    });
  });
});
