import { expect } from 'chai';
import gqlV1 from 'fake-tag';

import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../../../../server/constants/paymentMethods';
import roles from '../../../../server/constants/roles';
import models from '../../../../server/models';
import {
  fakeActiveHost,
  fakeCollective,
  fakeOrder,
  fakePaymentMethod,
  fakeUser,
} from '../../../test-helpers/fake-data';
import * as utils from '../../../utils';

const paymentMethodFromTransactionsQuery = gqlV1 /* GraphQL */ `
  query AllTransactions($collectiveId: Int!) {
    allTransactions(CollectiveId: $collectiveId, type: "CREDIT") {
      id
      ... on Order {
        paymentMethod {
          id
          type
          balance
          initialBalance
          monthlyLimitPerMember
          orders {
            id
            totalAmount
            status
            fromCollective {
              id
              slug
            }
            collective {
              id
              slug
            }
            interval
          }
        }
      }
    }
  }
`;

let host, admin, collective;

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
    host = await fakeActiveHost({
      admin,
      name: 'open source collective',
      type: 'ORGANIZATION',
      currency: 'USD',
    });

    await host.activateMoneyManagement({ remoteUser: admin });
  });

  beforeEach(() =>
    models.ConnectedAccount.create({
      CollectiveId: host.id,
      service: 'stripe',
      username: 'stripeAccount',
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

  describe('oauth flow', () => {
    // not implemented
  });
});

describe('server/graphql/v1/paymentMethods privacy', () => {
  let owner, stranger, destA, destB, paymentMethod, orderA, orderB;

  beforeEach(async () => {
    await utils.resetTestDB();
    owner = await fakeUser();
    stranger = await fakeUser();
    destA = await fakeCollective();
    destB = await fakeCollective();
    paymentMethod = await fakePaymentMethod({
      CollectiveId: owner.CollectiveId,
      service: PAYMENT_METHOD_SERVICE.OPENCOLLECTIVE,
      type: PAYMENT_METHOD_TYPE.PREPAID,
      initialBalance: 50000,
      monthlyLimitPerMember: 10000,
      currency: 'USD',
    });
    orderA = await fakeOrder(
      {
        FromCollectiveId: owner.CollectiveId,
        CollectiveId: destA.id,
        PaymentMethodId: paymentMethod.id,
        CreatedByUserId: owner.id,
        totalAmount: 1000,
        currency: 'USD',
      },
      { withTransactions: true },
    );
    orderB = await fakeOrder(
      {
        FromCollectiveId: owner.CollectiveId,
        CollectiveId: destB.id,
        PaymentMethodId: paymentMethod.id,
        CreatedByUserId: owner.id,
        totalAmount: 2000,
        currency: 'USD',
      },
      { withTransactions: true },
    );
  });

  const queryDestA = remoteUser =>
    utils.graphqlQuery(paymentMethodFromTransactionsQuery, { collectiveId: destA.id }, remoteUser);

  const creditPaymentMethod = result => {
    expect(result.errors).to.not.exist;
    const credit = result.data.allTransactions.find(transaction => transaction.paymentMethod);
    return credit?.paymentMethod || result.data.allTransactions[0]?.paymentMethod;
  };

  it('returns Transaction.paymentMethod type publicly without orders or balances', async () => {
    const result = await queryDestA();
    const pm = creditPaymentMethod(result);
    expect(pm).to.exist;
    expect(pm.id).to.equal(paymentMethod.id);
    expect(pm.type).to.equal('PREPAID');
    expect(pm.balance).to.equal(null);
    expect(pm.initialBalance).to.equal(null);
    expect(pm.monthlyLimitPerMember).to.equal(null);
    expect(pm.orders).to.equal(null);
  });

  it('hides orders, balance, initialBalance, and monthlyLimitPerMember from non-admins', async () => {
    const result = await queryDestA(stranger);
    const pm = creditPaymentMethod(result);
    expect(pm).to.exist;
    expect(pm.id).to.equal(paymentMethod.id);
    expect(pm.type).to.equal('PREPAID');
    expect(pm.balance).to.equal(null);
    expect(pm.initialBalance).to.equal(null);
    expect(pm.monthlyLimitPerMember).to.equal(null);
    expect(pm.orders).to.equal(null);
  });

  it('returns orders and balances only to an admin of the payment method collective', async () => {
    const result = await queryDestA(owner);
    const pm = creditPaymentMethod(result);
    expect(pm).to.exist;
    expect(pm.id).to.equal(paymentMethod.id);
    expect(pm.type).to.equal('PREPAID');
    expect(pm.initialBalance).to.equal(50000);
    expect(pm.monthlyLimitPerMember).to.equal(10000);
    expect(pm.balance).to.be.a('number');
    expect(pm.orders.map(order => order.id)).to.have.members([orderA.id, orderB.id]);
    const destinations = pm.orders.map(order => order.collective.slug);
    expect(destinations).to.have.members([destA.slug, destB.slug]);
  });

  it('returns orders and balances to an admin of the source payment method collective', async () => {
    const emitter = await fakeUser();
    const claimant = await fakeUser();
    const sourcePaymentMethod = await fakePaymentMethod({
      CollectiveId: emitter.CollectiveId,
      service: PAYMENT_METHOD_SERVICE.OPENCOLLECTIVE,
      type: PAYMENT_METHOD_TYPE.PREPAID,
      initialBalance: 80000,
      currency: 'USD',
    });
    const giftCard = await fakePaymentMethod({
      CollectiveId: claimant.CollectiveId,
      SourcePaymentMethodId: sourcePaymentMethod.id,
      service: PAYMENT_METHOD_SERVICE.OPENCOLLECTIVE,
      type: PAYMENT_METHOD_TYPE.GIFTCARD,
      initialBalance: 25000,
      monthlyLimitPerMember: 5000,
      confirmedAt: new Date(),
      currency: 'USD',
    });
    const giftCardOrder = await fakeOrder(
      {
        FromCollectiveId: claimant.CollectiveId,
        CollectiveId: destA.id,
        PaymentMethodId: giftCard.id,
        CreatedByUserId: claimant.id,
        totalAmount: 1500,
        currency: 'USD',
      },
      { withTransactions: true },
    );

    const result = await queryDestA(emitter);
    expect(result.errors).to.not.exist;
    const pm = result.data.allTransactions
      .map(transaction => transaction.paymentMethod)
      .find(method => method?.id === giftCard.id);
    expect(pm).to.exist;
    expect(pm.type).to.equal('GIFTCARD');
    expect(pm.initialBalance).to.equal(25000);
    expect(pm.monthlyLimitPerMember).to.equal(5000);
    expect(pm.balance).to.be.a('number');
    expect(pm.orders.map(order => order.id)).to.include(giftCardOrder.id);

    const strangerResult = await queryDestA(stranger);
    const strangerPm = strangerResult.data.allTransactions
      .map(transaction => transaction.paymentMethod)
      .find(method => method?.id === giftCard.id);
    expect(strangerPm).to.exist;
    expect(strangerPm.balance).to.equal(null);
    expect(strangerPm.initialBalance).to.equal(null);
    expect(strangerPm.monthlyLimitPerMember).to.equal(null);
    expect(strangerPm.orders).to.equal(null);
  });
});
