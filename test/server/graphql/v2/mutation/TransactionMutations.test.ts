import { expect } from 'chai';
import gqlV2 from 'fake-tag';
import { createSandbox } from 'sinon';

import * as orders from '../../../../../server/graphql/v1/mutations/orders';
import emailLib from '../../../../../server/lib/email';
import * as payments from '../../../../../server/lib/payments';
import stripe from '../../../../../server/lib/stripe';
import models from '../../../../../server/models';
import stripeMocks from '../../../../mocks/stripe';
import { fakeCollective, fakeOrder, fakeUser } from '../../../../test-helpers/fake-data';
import { graphqlQueryV2 } from '../../../../utils';
import * as utils from '../../../../utils';

const STRIPE_TOKEN = 'tok_123456781234567812345678';

describe('server/graphql/v2/mutation/TransactionMutations', () => {
  let sandbox,
    collectiveAdminUser,
    hostAdminUser,
    randomUser,
    collective,
    order1,
    order2,
    transaction1,
    transaction2,
    sendEmailSpy,
    refundTransactionSpy;

  before(async () => {
    await utils.resetTestDB();
  });

  before(() => {
    sandbox = createSandbox();
    sandbox.stub(stripe.customers, 'create').callsFake(() => Promise.resolve({ id: 'cus_BM7mGwp1Ea8RtL' }));
    sandbox.stub(stripe.customers, 'retrieve').callsFake(() => Promise.resolve({ id: 'cus_BM7mGwp1Ea8RtL' }));
    sandbox.stub(stripe.tokens, 'create').callsFake(() => Promise.resolve({ id: 'tok_1AzPXGD8MNtzsDcgwaltZuvp' }));
    sandbox.stub(stripe.paymentIntents, 'create').callsFake(() =>
      Promise.resolve({
        id: 'pi_1F82vtBYycQg1OMfS2Rctiau',
        status: 'requires_confirmation',
      }),
    );
    sandbox.stub(stripe.paymentIntents, 'confirm').callsFake(() =>
      Promise.resolve({
        charges: { data: [{ id: 'ch_1AzPXHD8MNtzsDcgXpUhv4pm' }] },
        status: 'succeeded',
      }),
    );
    sandbox.stub(stripe.balanceTransactions, 'retrieve').callsFake(() => Promise.resolve(stripeMocks.balance));
    sandbox.stub(stripe.refunds, 'create').callsFake(() => Promise.resolve('foo'));
    sandbox.stub(stripe.charges, 'retrieve').callsFake(() => Promise.resolve('foo'));
    sendEmailSpy = sandbox.spy(emailLib, 'send');
    refundTransactionSpy = sandbox.spy(orders, 'refundTransaction');
  });

  after(() => sandbox.restore());

  before(async () => {
    collectiveAdminUser = await fakeUser();
    hostAdminUser = await fakeUser();
    randomUser = await fakeUser();
    collective = await fakeCollective();
    await collective.addUserWithRole(collectiveAdminUser, 'ADMIN');
    await collective.host.addUserWithRole(hostAdminUser, 'ADMIN');
    await collectiveAdminUser.populateRoles();
    await hostAdminUser.populateRoles();
    order1 = await fakeOrder({
      CollectiveId: collective.id,
    });
    order1 = await order1.setPaymentMethod({ token: STRIPE_TOKEN });
    order2 = await fakeOrder({
      CollectiveId: collective.id,
    });
    order2 = await order2.setPaymentMethod({ token: STRIPE_TOKEN });
    await models.ConnectedAccount.create({
      service: 'stripe',
      token: 'abc',
      CollectiveId: collective.host.id,
    });
    await payments.executeOrder(randomUser, order1);
    transaction1 = await models.Transaction.findOne({
      where: {
        OrderId: order1.id,
        type: 'CREDIT',
      },
    });
    await payments.executeOrder(randomUser, order2);
    transaction2 = await models.Transaction.findOne({
      where: {
        OrderId: order2.id,
        type: 'CREDIT',
      },
    });
    await models.Member.create({
      CollectiveId: collective.id,
      MemberCollectiveId: randomUser.id,
      role: 'BACKER',
      CreatedByUserId: randomUser.id,
    });
  });

  afterEach(() => {
    refundTransactionSpy.resetHistory();
  });

  describe('refundTransaction', () => {
    const refundTransactionMutation = gqlV2/* GraphQL */ `
      mutation RefundTransaction($transaction: TransactionReferenceInput!) {
        refundTransaction(transaction: $transaction) {
          id
        }
      }
    `;

    it('refunds the transaction', async () => {
      const result = await graphqlQueryV2(
        refundTransactionMutation,
        {
          transaction: { legacyId: transaction1.id },
        },
        hostAdminUser,
      );

      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.refundTransaction.id).to.exist;
    });
  });

  describe('rejectTransaction', () => {
    const rejectTransactionMutation = gqlV2/* GraphQL */ `
      mutation RejectTransaction($transaction: TransactionReferenceInput!, $message: String) {
        rejectTransaction(transaction: $transaction, message: $message) {
          id
        }
      }
    `;

    it('should not refund the transaction if it has already been refunded but not rejected', async () => {
      await graphqlQueryV2(
        rejectTransactionMutation,
        {
          transaction: { legacyId: transaction1.id },
        },
        collectiveAdminUser,
      );

      expect(refundTransactionSpy.notCalled).to.be.true;
    });

    it('does not allow random user to reject', async () => {
      const result = await graphqlQueryV2(
        rejectTransactionMutation,
        {
          transaction: { legacyId: transaction2.id },
        },
        randomUser,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.match(/Cannot reject this transaction/);
    });

    it('rejects the transaction', async () => {
      const message = 'We do not want your contribution';
      const result = await graphqlQueryV2(
        rejectTransactionMutation,
        {
          transaction: { legacyId: transaction2.id },
          message,
        },
        hostAdminUser,
      );

      const updatedOrder = await models.Order.findOne({
        where: { id: order2.id },
      });

      const memberships = await models.Member.findOne({
        where: {
          MemberCollectiveId: transaction2.FromCollectiveId,
          CollectiveId: transaction2.CollectiveId,
          role: 'BACKER',
        },
      });

      expect(result.errors).to.not.exist;
      expect(result.data.rejectTransaction.id).to.exist;
      expect(sendEmailSpy.calledWith('contribution.rejected')).to.be.true;
      expect(updatedOrder.status).to.eq('REJECTED');
      expect(memberships).to.be.null;
    });
  });
});
