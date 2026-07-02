import { expect } from 'chai';
import gql from 'fake-tag';

import OrderStatus from '../../../../../../server/constants/order-status';
import PaymentIntentStatus from '../../../../../../server/constants/payment-intent-status';
import PaymentIntentType from '../../../../../../server/constants/payment-intent-type';
import {
  backfillPaymentIntentForOrderLedger,
  backfillPaymentIntentForPendingOrder,
} from '../../../../../../server/lib/payment-intents/backfill';
import models from '../../../../../../server/models';
import {
  fakeActiveHost,
  fakeApplication,
  fakeCollective,
  fakeOrder,
  fakeProject,
  fakeUser,
  fakeUserToken,
} from '../../../../../test-helpers/fake-data';
import { graphqlQueryV2, oAuthGraphqlQueryV2, resetTestDB } from '../../../../../utils';

const paymentIntentsQuery = gql`
  query PaymentIntents(
    $account: AccountReferenceInput
    $host: AccountReferenceInput
    $direction: PaymentIntentDirection
    $includeChildrenPaymentIntents: Boolean
    $counterparty: AccountReferenceInput
  ) {
    paymentIntents(
      account: $account
      host: $host
      direction: $direction
      includeChildrenPaymentIntents: $includeChildrenPaymentIntents
      counterparty: $counterparty
    ) {
      totalCount
      nodes {
        id
        status
        type
        amountPledged {
          value
          currency
        }
        amountSent(net: false) {
          value
          currency
        }
        amountReceived(net: false) {
          value
          currency
        }
        amountSentNet: amountSent(net: true) {
          value
        }
        amountReceivedNet: amountReceived(net: true) {
          value
        }
        payer {
          id
          slug
        }
        payee {
          id
          slug
        }
      }
    }
  }
`;

const accountPaymentIntentsQuery = gql`
  query AccountPaymentIntents(
    $slug: String!
    $direction: PaymentIntentDirection
    $includeChildrenPaymentIntents: Boolean
  ) {
    account(slug: $slug) {
      paymentIntents(direction: $direction, includeChildrenPaymentIntents: $includeChildrenPaymentIntents) {
        totalCount
        nodes {
          id
          status
          type
        }
      }
    }
  }
`;

const clearPaymentIntentForOrder = async (orderId: number): Promise<void> => {
  await models.PaymentIntent.destroy({ where: { OrderId: orderId }, force: true });
  await models.Transaction.update({ PaymentIntentId: null }, { where: { OrderId: orderId } });
};

describe('server/graphql/v2/query/collection/PaymentIntentCollectionQuery', () => {
  let host;
  let collective;
  let parentCollective;
  let childProject;
  let contributorUser;
  let contributor;

  before(async () => {
    await resetTestDB();

    host = await fakeActiveHost();
    collective = await fakeCollective({ HostCollectiveId: host.id });
    parentCollective = await fakeCollective({ HostCollectiveId: host.id });
    childProject = await fakeProject({ ParentCollectiveId: parentCollective.id, HostCollectiveId: host.id });
    contributorUser = await fakeUser();
    contributor = contributorUser.collective;

    const incomingOrder = await fakeOrder(
      {
        status: OrderStatus.PAID,
        CollectiveId: collective.id,
        FromCollectiveId: contributor.id,
        CreatedByUserId: contributorUser.id,
        totalAmount: 5000,
      },
      { withTransactions: true },
    );
    await clearPaymentIntentForOrder(incomingOrder.id);
    await backfillPaymentIntentForOrderLedger(incomingOrder.id);

    const outgoingOrder = await fakeOrder(
      {
        status: OrderStatus.PAID,
        CollectiveId: host.id,
        FromCollectiveId: contributor.id,
        CreatedByUserId: contributorUser.id,
        totalAmount: 3000,
      },
      { withTransactions: true },
    );
    await clearPaymentIntentForOrder(outgoingOrder.id);
    await backfillPaymentIntentForOrderLedger(outgoingOrder.id);

    const hostOnlyOrder = await fakeOrder({
      status: OrderStatus.NEW,
      CollectiveId: collective.id,
      FromCollectiveId: contributor.id,
      CreatedByUserId: contributorUser.id,
    });
    await backfillPaymentIntentForPendingOrder(hostOnlyOrder.id);

    const parentOrder = await fakeOrder(
      {
        status: OrderStatus.PAID,
        CollectiveId: parentCollective.id,
        FromCollectiveId: contributor.id,
        CreatedByUserId: contributorUser.id,
      },
      { withTransactions: true },
    );
    await clearPaymentIntentForOrder(parentOrder.id);
    await backfillPaymentIntentForOrderLedger(parentOrder.id);

    const childOrder = await fakeOrder(
      {
        status: OrderStatus.PAID,
        CollectiveId: childProject.id,
        FromCollectiveId: contributor.id,
        CreatedByUserId: contributorUser.id,
      },
      { withTransactions: true },
    );
    await clearPaymentIntentForOrder(childOrder.id);
    await backfillPaymentIntentForOrderLedger(childOrder.id);
  });

  it('returns payment intents filtered by account', async () => {
    const result = await graphqlQueryV2(paymentIntentsQuery, { account: { slug: collective.slug } }, contributorUser);

    expect(result.errors).to.not.exist;
    expect(result.data.paymentIntents.totalCount).to.be.greaterThan(0);
    expect(
      result.data.paymentIntents.nodes.every(
        node => node.status === PaymentIntentStatus.PAID || node.status === PaymentIntentStatus.PENDING,
      ),
    ).to.be.true;
  });

  it('returns payment intents filtered by host only', async () => {
    const result = await graphqlQueryV2(paymentIntentsQuery, { host: { slug: host.slug } }, contributorUser);

    expect(result.errors).to.not.exist;
    expect(result.data.paymentIntents.totalCount).to.be.greaterThan(0);
  });

  it('narrows results when both account and host are provided', async () => {
    const accountOnly = await graphqlQueryV2(
      paymentIntentsQuery,
      { account: { slug: collective.slug } },
      contributorUser,
    );
    const accountAndHost = await graphqlQueryV2(
      paymentIntentsQuery,
      { account: { slug: collective.slug }, host: { slug: host.slug } },
      contributorUser,
    );

    expect(accountOnly.errors).to.not.exist;
    expect(accountAndHost.errors).to.not.exist;
    expect(accountAndHost.data.paymentIntents.totalCount).to.be.at.most(accountOnly.data.paymentIntents.totalCount);
  });

  it('errors when neither account nor host is provided', async () => {
    const result = await graphqlQueryV2(paymentIntentsQuery, {}, contributorUser);

    expect(result.errors).to.exist;
    expect(result.errors[0].message).to.include('Either account or host must be provided');
  });

  it('filters by INCOMING direction', async () => {
    const result = await graphqlQueryV2(
      paymentIntentsQuery,
      { account: { slug: collective.slug }, direction: 'INCOMING' },
      contributorUser,
    );

    expect(result.errors).to.not.exist;
    expect(result.data.paymentIntents.nodes.every(node => node.payee.slug === collective.slug)).to.be.true;
  });

  it('filters by OUTGOING direction', async () => {
    const result = await graphqlQueryV2(
      paymentIntentsQuery,
      { account: { slug: contributor.slug }, direction: 'OUTGOING' },
      contributorUser,
    );

    expect(result.errors).to.not.exist;
    expect(result.data.paymentIntents.nodes.every(node => node.payer.slug === contributor.slug)).to.be.true;
  });

  it('filters by counterparty', async () => {
    const result = await graphqlQueryV2(
      paymentIntentsQuery,
      {
        account: { slug: contributor.slug },
        counterparty: { slug: collective.slug },
      },
      contributorUser,
    );

    expect(result.errors).to.not.exist;
    expect(result.data.paymentIntents.totalCount).to.be.greaterThan(0);
    expect(
      result.data.paymentIntents.nodes.every(
        node =>
          (node.payer.slug === contributor.slug && node.payee.slug === collective.slug) ||
          (node.payee.slug === contributor.slug && node.payer.slug === collective.slug),
      ),
    ).to.be.true;
  });

  it('returns computed amount fields for a paid payment intent', async () => {
    const result = await graphqlQueryV2(
      paymentIntentsQuery,
      { account: { slug: collective.slug }, direction: 'INCOMING' },
      contributorUser,
    );

    expect(result.errors).to.not.exist;
    const paidNode = result.data.paymentIntents.nodes.find(node => node.status === PaymentIntentStatus.PAID);
    expect(paidNode).to.exist;
    expect(paidNode.type).to.eq(PaymentIntentType.Contribution);
    expect(paidNode.amountPledged.value).to.eq(50);
    expect(paidNode.amountPledged.currency).to.eq('USD');
    expect(paidNode.amountSent.value).to.eq(50);
    expect(paidNode.amountReceived.value).to.eq(50);
    expect(paidNode.amountSentNet.value).to.eq(50);
    expect(paidNode.amountReceivedNet.value).to.eq(50);
  });

  it('rejects OAuth tokens without the transactions scope', async () => {
    const application = await fakeApplication({ type: 'oAuth' });
    const userToken = await fakeUserToken({
      type: 'OAUTH',
      ApplicationId: application.id,
      UserId: contributorUser.id,
      scope: ['account'],
    });

    const result = await oAuthGraphqlQueryV2(paymentIntentsQuery, { account: { slug: collective.slug } }, userToken);

    expect(result.errors).to.exist;
    expect(result.errors[0].message).to.include('transactions');
  });

  describe('Account.paymentIntents', () => {
    it('returns payment intents for the account', async () => {
      const result = await graphqlQueryV2(
        accountPaymentIntentsQuery,
        { slug: parentCollective.slug, direction: 'INCOMING' },
        contributorUser,
      );

      expect(result.errors).to.not.exist;
      expect(result.data.account.paymentIntents.totalCount).to.eq(1);
    });

    it('includes children payment intents when requested', async () => {
      const withoutChildren = await graphqlQueryV2(
        accountPaymentIntentsQuery,
        { slug: parentCollective.slug, direction: 'INCOMING', includeChildrenPaymentIntents: false },
        contributorUser,
      );
      const withChildren = await graphqlQueryV2(
        accountPaymentIntentsQuery,
        { slug: parentCollective.slug, direction: 'INCOMING', includeChildrenPaymentIntents: true },
        contributorUser,
      );

      expect(withoutChildren.errors).to.not.exist;
      expect(withChildren.errors).to.not.exist;
      expect(withoutChildren.data.account.paymentIntents.totalCount).to.eq(1);
      expect(withChildren.data.account.paymentIntents.totalCount).to.eq(2);
    });

    it('blocks access to private accounts the viewer cannot see', async () => {
      const privateHost = await fakeActiveHost();
      const privateCollective = await fakeCollective({
        HostCollectiveId: privateHost.id,
        isPrivate: true,
        approvedAt: new Date(),
      });
      const randomUser = await fakeUser();

      const result = await graphqlQueryV2(
        paymentIntentsQuery,
        { account: { slug: privateCollective.slug } },
        randomUser,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].extensions.code).to.eq('Forbidden');
    });
  });
});
