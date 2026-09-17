import { expect } from 'chai';
import gql from 'fake-tag';
import type Stripe from 'stripe';

import { roles } from '../../../../../../server/constants';
import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../../../../../../server/constants/paymentMethods';
import { TransactionKind } from '../../../../../../server/constants/transaction-kind';
import { idEncode, IDENTIFIER_TYPES } from '../../../../../../server/graphql/v2/identifiers';
import {
  fakeAccountingCategory,
  fakeActiveHost,
  fakeCollective,
  fakeHost,
  fakeIncognitoProfile,
  fakeManualPaymentProvider,
  fakeMember,
  fakeOrder,
  fakeOrganization,
  fakePaidExpense,
  fakePaymentMethod,
  fakePrivateHost,
  fakeTransaction,
  fakeUser,
  fakeUserToken,
} from '../../../../../test-helpers/fake-data';
import { graphqlQueryV2, oAuthGraphqlQueryV2, resetTestDB } from '../../../../../utils';

const transactionsQuery = gql`
  query Transactions(
    $fromAccount: AccountReferenceInput
    $host: AccountReferenceInput
    $includeIncognitoTransactions: Boolean
  ) {
    transactions(fromAccount: $fromAccount, host: $host, includeIncognitoTransactions: $includeIncognitoTransactions) {
      totalCount
      nodes {
        id
        fromAccount {
          id
          slug
          isIncognito
        }
      }
    }
  }
`;

const transactionsPrivateOrgQuery = gql`
  query TransactionsPrivateOrg(
    $fromAccount: AccountReferenceInput
    $account: [AccountReferenceInput!]
    $host: AccountReferenceInput
  ) {
    transactions(fromAccount: $fromAccount, account: $account, host: $host) {
      totalCount
      nodes {
        description
      }
    }
  }
`;

describe('TransactionsCollectionQuery - includeIncognitoTransactions', () => {
  let hostAdminUser, regularUser, host, collective, userCollective, incognitoProfile;

  before(async () => {
    await resetTestDB();

    hostAdminUser = await fakeUser();
    regularUser = await fakeUser();

    host = await fakeActiveHost({ admin: hostAdminUser.collective });
    collective = await fakeCollective({ HostCollectiveId: host.id });

    // Create a user whose collective will be the "fromAccount"
    const fromUser = await fakeUser();
    userCollective = fromUser.collective;

    // Create an incognito profile linked to the fromUser
    incognitoProfile = await fakeIncognitoProfile(fromUser);

    // Regular transaction from the user's collective
    await fakeTransaction({
      FromCollectiveId: userCollective.id,
      CollectiveId: collective.id,
      HostCollectiveId: host.id,
      kind: TransactionKind.CONTRIBUTION,
      amount: 1000,
    });

    // Incognito transaction from the incognito profile
    await fakeTransaction({
      FromCollectiveId: incognitoProfile.id,
      CollectiveId: collective.id,
      HostCollectiveId: host.id,
      kind: TransactionKind.CONTRIBUTION,
      amount: 500,
    });
  });

  it('host admin CAN see incognito transactions when includeIncognitoTransactions=true and host arg is provided', async () => {
    const result = await graphqlQueryV2(
      transactionsQuery,
      {
        fromAccount: { slug: userCollective.slug },
        host: { slug: host.slug },
        includeIncognitoTransactions: true,
      },
      hostAdminUser,
    );

    result.errors && console.error(result.errors);
    expect(result.errors).to.not.exist;

    const slugs = result.data.transactions.nodes.map(t => t.fromAccount.slug);
    expect(slugs).to.include(incognitoProfile.slug);
    expect(slugs).to.include(userCollective.slug);
  });

  it('host admin CANNOT see incognito transactions when includeIncognitoTransactions=false', async () => {
    const result = await graphqlQueryV2(
      transactionsQuery,
      {
        fromAccount: { slug: userCollective.slug },
        host: { slug: host.slug },
        includeIncognitoTransactions: false,
      },
      hostAdminUser,
    );

    result.errors && console.error(result.errors);
    expect(result.errors).to.not.exist;

    const slugs = result.data.transactions.nodes.map(t => t.fromAccount.slug);
    expect(slugs).to.not.include(incognitoProfile.slug);
  });

  it('host admin CANNOT see incognito transactions when host arg is NOT provided (even with flag true)', async () => {
    const result = await graphqlQueryV2(
      transactionsQuery,
      {
        fromAccount: { slug: userCollective.slug },
        includeIncognitoTransactions: true,
        // No host arg
      },
      hostAdminUser,
    );

    result.errors && console.error(result.errors);
    expect(result.errors).to.not.exist;

    const slugs = result.data.transactions.nodes.map(t => t.fromAccount.slug);
    expect(slugs).to.not.include(incognitoProfile.slug);
  });

  it('non-admin user cannot see incognito transactions even with includeIncognitoTransactions=true', async () => {
    const result = await graphqlQueryV2(
      transactionsQuery,
      {
        fromAccount: { slug: userCollective.slug },
        host: { slug: host.slug },
        includeIncognitoTransactions: true,
      },
      regularUser,
    );

    result.errors && console.error(result.errors);
    expect(result.errors).to.not.exist;

    const slugs = result.data.transactions.nodes.map(t => t.fromAccount.slug);
    expect(slugs).to.not.include(incognitoProfile.slug);
  });

  it('fromAccount owner (user with same CollectiveId) can still see incognito transactions without host arg', async () => {
    // The fromUser is the owner of the userCollective. For isAdminOfFromAccount to be true,
    // remoteUser.CollectiveId === fromAccount.id AND remoteUser.isAdminOfCollective(fromAccount).
    // We need a user whose UserCollectiveId matches the userCollective.
    // The fromUser was used above — we need to pass them as the remote user.
    // Re-create a fresh user whose collective is the fromAccount.
    const ownerUser = await fakeUser();
    const ownerCollective = ownerUser.collective;
    const ownerIncognito = await fakeIncognitoProfile(ownerUser);

    // Create a host+collective for this test so we have a clean slate
    const ownerHost = await fakeActiveHost({ admin: hostAdminUser.collective });
    const ownerCollectiveTarget = await fakeCollective({ HostCollectiveId: ownerHost.id });

    await fakeTransaction({
      FromCollectiveId: ownerIncognito.id,
      CollectiveId: ownerCollectiveTarget.id,
      HostCollectiveId: ownerHost.id,
      kind: TransactionKind.CONTRIBUTION,
      amount: 750,
    });

    const result = await graphqlQueryV2(
      transactionsQuery,
      {
        fromAccount: { slug: ownerCollective.slug },
        includeIncognitoTransactions: true,
        // No host arg — relies on isAdminOfFromAccount check
      },
      ownerUser,
    );

    result.errors && console.error(result.errors);
    expect(result.errors).to.not.exist;

    const slugs = result.data.transactions.nodes.map(t => t.fromAccount.slug);
    expect(slugs).to.include(ownerIncognito.slug);
  });

  describe('OAuth scope check', () => {
    it('host admin with incognito scope can see incognito transactions via OAuth token', async () => {
      const userToken = await fakeUserToken({ user: hostAdminUser, scope: ['incognito', 'transactions'] });

      const result = await oAuthGraphqlQueryV2(
        transactionsQuery,
        {
          fromAccount: { slug: userCollective.slug },
          host: { slug: host.slug },
          includeIncognitoTransactions: true,
        },
        userToken,
      );

      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;

      const slugs = result.data.transactions.nodes.map(t => t.fromAccount.slug);
      expect(slugs).to.include(incognitoProfile.slug);
    });

    it('host admin WITHOUT incognito scope cannot see incognito transactions via OAuth token', async () => {
      const userToken = await fakeUserToken({ user: hostAdminUser, scope: ['account', 'transactions'] });

      const result = await oAuthGraphqlQueryV2(
        transactionsQuery,
        {
          fromAccount: { slug: userCollective.slug },
          host: { slug: host.slug },
          includeIncognitoTransactions: true,
        },
        userToken,
      );

      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;

      const slugs = result.data.transactions.nodes.map(t => t.fromAccount.slug);
      expect(slugs).to.not.include(incognitoProfile.slug);
    });

    it('rejects transactions query when OAuth token only has email scope', async () => {
      const userToken = await fakeUserToken({ user: hostAdminUser, scope: ['email'] });

      const result = await oAuthGraphqlQueryV2(
        transactionsQuery,
        {
          fromAccount: { slug: userCollective.slug },
          host: { slug: host.slug },
        },
        userToken,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal(
        'The User Token is not allowed for operations in scope "transactions".',
      );
    });
  });
});

const transactionsCollectionQuery = gql`
  query Transactions(
    $slug: String!
    $type: TransactionType
    $minAmount: Int
    $maxAmount: Int
    $dateFrom: DateTime
    $searchTerm: String
    $paymentMethodType: [PaymentMethodType]
    $paymentMethodService: [PaymentMethodService]
    $manualPaymentProvider: [ManualPaymentProviderReferenceInput!]
    $merchantId: [String]
    $accountingCategory: [String]
    $group: [String]
    $excludeAccount: [AccountReferenceInput]
  ) {
    transactions(
      account: { slug: $slug }
      type: $type
      minAmount: $minAmount
      maxAmount: $maxAmount
      dateFrom: $dateFrom
      searchTerm: $searchTerm
      paymentMethodType: $paymentMethodType
      paymentMethodService: $paymentMethodService
      manualPaymentProvider: $manualPaymentProvider
      merchantId: $merchantId
      accountingCategory: $accountingCategory
      group: $group
      excludeAccount: $excludeAccount
    ) {
      totalCount
      offset
      limit
      kinds
      paymentMethodTypes
      nodes {
        id
        type
        merchantId
        group
        paymentMethod {
          id
          type
          service
        }
        order {
          id
          accountingCategory {
            id
            code
          }
        }
        account {
          id
          legalName
        }
        oppositeAccount {
          id
          legalName
        }
        fromAccount {
          id
          legalName
          location {
            address
            country
          }
        }
        toAccount {
          id
          legalName
        }
        taxInfo {
          idNumber
        }
      }
    }
  }
`;

describe('server/graphql/v2/collection/TransactionCollection', () => {
  let transactions, collective, collectiveAdmin, fromCollectiveAdmin, hostAdmin;

  before(async () => {
    collectiveAdmin = await fakeUser();
    fromCollectiveAdmin = await fakeUser({});
    hostAdmin = await fakeUser();

    const fromCollective = await fakeOrganization({ legalName: 'Secret Corp', admin: fromCollectiveAdmin.collective });
    const host = await fakeHost({ admin: hostAdmin.collective });
    collective = await fakeCollective({ admin: collectiveAdmin.collective, HostCollectiveId: host.id });
    const accountingCategory = await fakeAccountingCategory({ code: 'TEST-001', CollectiveId: host.id });
    const order = await fakeOrder({
      FromCollectiveId: fromCollective.id,
      CollectiveId: collective.id,
      AccountingCategoryId: accountingCategory.id,
    });

    // Create some payment methods
    const creditCardPm = await fakePaymentMethod({
      service: PAYMENT_METHOD_SERVICE.STRIPE,
      type: PAYMENT_METHOD_TYPE.CREDITCARD,
    });

    const PaypalPm = await fakePaymentMethod({
      service: PAYMENT_METHOD_SERVICE.PAYPAL,
      type: PAYMENT_METHOD_TYPE.SUBSCRIPTION,
    });

    // Create transactions
    const baseTransaction = {
      FromCollectiveId: fromCollective.id,
      CollectiveId: collective.id,
      HostCollectiveId: host.id,
    };
    transactions = await Promise.all([
      fakeTransaction({
        ...baseTransaction,
        kind: TransactionKind.ADDED_FUNDS,
        amount: 10000,
        PaymentMethodId: null,
      }),
      fakeTransaction({
        ...baseTransaction,
        kind: TransactionKind.CONTRIBUTION,
        amount: -15000,
        PaymentMethodId: creditCardPm.id,
        data: { charge: { id: 'ch_123' } as Stripe.Charge },
        OrderId: order.id,
      }),
      fakeTransaction({
        ...baseTransaction,
        kind: TransactionKind.CONTRIBUTION,
        amount: 10,
        description: 'this is a test',
        PaymentMethodId: PaypalPm.id,
        data: { capture: { id: 'paypov' } },
      }),
    ]);
  });

  describe('collection', () => {
    describe('kinds', () => {
      it('returns all available payment method kinds', async () => {
        const result = await graphqlQueryV2(transactionsCollectionQuery, { slug: collective.slug });
        expect(result.data.transactions.kinds).to.eqInAnyOrder([
          TransactionKind.ADDED_FUNDS,
          TransactionKind.CONTRIBUTION,
        ]);
      });

      it('is not affected by search params', async () => {
        const result = await graphqlQueryV2(transactionsCollectionQuery, {
          slug: collective.slug,
          kind: 'CONTRIBUTION',
        });
        expect(result.data.transactions.kinds).to.eqInAnyOrder([
          TransactionKind.ADDED_FUNDS,
          TransactionKind.CONTRIBUTION,
        ]);
      });
    });

    describe('paymentMethodTypes', () => {
      it('returns all available payment method types', async () => {
        const result = await graphqlQueryV2(transactionsCollectionQuery, { slug: collective.slug });
        expect(result.data.transactions.paymentMethodTypes).eqInAnyOrder(['CREDITCARD', 'SUBSCRIPTION', null]);
      });
    });
  });

  describe('filters', () => {
    it('none', async () => {
      const result = await graphqlQueryV2(transactionsCollectionQuery, { slug: collective.slug });
      expect(result.data.transactions.totalCount).to.eq(transactions.length);
    });

    it('by min amount', async () => {
      const result = await graphqlQueryV2(transactionsCollectionQuery, { slug: collective.slug, minAmount: 9000 });
      expect(result.data.transactions.totalCount).to.eq(2);
    });

    it('by max amount', async () => {
      const result = await graphqlQueryV2(transactionsCollectionQuery, { slug: collective.slug, maxAmount: 20 });
      expect(result.data.transactions.totalCount).to.eq(1);
    });

    it('by type', async () => {
      const result = await graphqlQueryV2(transactionsCollectionQuery, { slug: collective.slug, type: 'DEBIT' });
      expect(result.data.transactions.totalCount).to.eq(1);
    });

    it('by search term', async () => {
      const result = await graphqlQueryV2(transactionsCollectionQuery, { slug: collective.slug, searchTerm: 'this' });
      expect(result.data.transactions.totalCount).to.eq(1);
    });

    describe('by payment method type', () => {
      it('returns transactions without payment method', async () => {
        const result = await graphqlQueryV2(transactionsCollectionQuery, {
          slug: collective.slug,
          paymentMethodType: [null],
        });
        expect(result.data.transactions.totalCount).to.eq(1);
      });

      it('returns credit card', async () => {
        const result = await graphqlQueryV2(transactionsCollectionQuery, {
          slug: collective.slug,
          paymentMethodType: 'CREDITCARD',
        });
        expect(result.data.transactions.totalCount).to.eq(1);
        expect(result.data.transactions.nodes[0].paymentMethod.type).to.eq('CREDITCARD');
      });

      it('returns paypal', async () => {
        const result = await graphqlQueryV2(transactionsCollectionQuery, {
          slug: collective.slug,
          paymentMethodType: ['PAYMENT', 'subscription'],
        });
        expect(result.data.transactions.totalCount).to.eq(1);
        expect(result.data.transactions.nodes[0].paymentMethod.type).to.eq('SUBSCRIPTION');
      });

      it('returns paypal and credit card', async () => {
        const result = await graphqlQueryV2(transactionsCollectionQuery, {
          slug: collective.slug,
          paymentMethodType: ['PAYMENT', 'SUBSCRIPTION', 'CREDITCARD'],
        });
        expect(result.data.transactions.totalCount).to.eq(2);
        expect(result.data.transactions.nodes).to.containSubset([
          { paymentMethod: { type: 'CREDITCARD' } },
          { paymentMethod: { type: 'SUBSCRIPTION' } },
        ]);
      });
    });

    describe('by payment method service', () => {
      it('returns stripe', async () => {
        const result = await graphqlQueryV2(transactionsCollectionQuery, {
          slug: collective.slug,
          paymentMethodService: ['STRIPE'],
        });
        expect(result.data.transactions.totalCount).to.eq(1);
        expect(result.data.transactions.nodes[0].paymentMethod.service).to.eq('STRIPE');
      });

      it('returns paypal and stripe', async () => {
        const result = await graphqlQueryV2(transactionsCollectionQuery, {
          slug: collective.slug,
          paymentMethodService: ['PAYPAL', 'STRIPE'],
        });
        expect(result.data.transactions.totalCount).to.eq(2);
        expect(result.data.transactions.nodes).to.containSubset([
          { paymentMethod: { service: 'PAYPAL' } },
          { paymentMethod: { service: 'STRIPE' } },
        ]);
      });
    });

    describe('by manualPaymentProvider', () => {
      let hostWithProvider, collectiveWithProvider, provider, orderWithProvider, hostAdminUser;

      before(async () => {
        hostAdminUser = await fakeUser();
        hostWithProvider = await fakeHost({ admin: hostAdminUser.collective });
        collectiveWithProvider = await fakeCollective({
          HostCollectiveId: hostWithProvider.id,
        });
        provider = await fakeManualPaymentProvider({
          CollectiveId: hostWithProvider.id,
          name: 'Bank Transfer Test',
        });
        orderWithProvider = await fakeOrder({
          FromCollectiveId: (await fakeUser()).CollectiveId,
          CollectiveId: collectiveWithProvider.id,
          ManualPaymentProviderId: provider.id,
          PaymentMethodId: null,
        });
        await fakeTransaction({
          kind: TransactionKind.CONTRIBUTION,
          type: 'CREDIT',
          amount: 5000,
          FromCollectiveId: orderWithProvider.FromCollectiveId,
          CollectiveId: collectiveWithProvider.id,
          HostCollectiveId: hostWithProvider.id,
          OrderId: orderWithProvider.id,
          PaymentMethodId: null,
        });
      });

      it('returns transactions for contributions that used the given manual payment provider', async () => {
        const result = await graphqlQueryV2(
          transactionsCollectionQuery,
          {
            slug: collectiveWithProvider.slug,
            manualPaymentProvider: { id: idEncode(provider.id, IDENTIFIER_TYPES.MANUAL_PAYMENT_PROVIDER) },
          },
          hostAdminUser,
        );
        expect(result.errors).to.not.exist;
        expect(result.data.transactions.totalCount).to.eq(1);
        expect(result.data.transactions.nodes[0].order.id).to.eq(
          idEncode(orderWithProvider.id, IDENTIFIER_TYPES.ORDER),
        );
      });

      it('returns 403 when non-admin filters by manual payment provider', async () => {
        const randomUser = await fakeUser();
        const result = await graphqlQueryV2(
          transactionsCollectionQuery,
          {
            slug: collectiveWithProvider.slug,
            manualPaymentProvider: { id: idEncode(provider.id, IDENTIFIER_TYPES.MANUAL_PAYMENT_PROVIDER) },
          },
          randomUser,
        );
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.include('admin of the host');
      });
    });

    describe('by payment method OPENCOLLECTIVE + MANUAL (includes manual payment provider orders)', () => {
      let hostMpp, collectiveMpp, providerMpp, orderMpp;

      before(async () => {
        hostMpp = await fakeHost();
        collectiveMpp = await fakeCollective({ HostCollectiveId: hostMpp.id });
        providerMpp = await fakeManualPaymentProvider({
          CollectiveId: hostMpp.id,
          name: 'Custom Bank',
        });
        orderMpp = await fakeOrder({
          FromCollectiveId: (await fakeUser()).CollectiveId,
          CollectiveId: collectiveMpp.id,
          ManualPaymentProviderId: providerMpp.id,
          PaymentMethodId: null,
        });
        await fakeTransaction({
          kind: TransactionKind.CONTRIBUTION,
          type: 'CREDIT',
          amount: 3000,
          FromCollectiveId: orderMpp.FromCollectiveId,
          CollectiveId: collectiveMpp.id,
          HostCollectiveId: hostMpp.id,
          OrderId: orderMpp.id,
          PaymentMethodId: null,
        });
      });

      it('includes transactions whose order has ManualPaymentProviderId when filtering OPENCOLLECTIVE + MANUAL', async () => {
        const result = await graphqlQueryV2(transactionsCollectionQuery, {
          slug: collectiveMpp.slug,
          paymentMethodService: ['OPENCOLLECTIVE'],
          paymentMethodType: ['MANUAL'],
        });
        expect(result.errors).to.not.exist;
        expect(result.data).to.exist;
        expect(result.data.transactions.totalCount).to.eq(1);
        expect(result.data.transactions.nodes[0].order.id).to.eq(idEncode(orderMpp.id, IDENTIFIER_TYPES.ORDER));
      });
    });

    it('by merchantId', async () => {
      const result = await graphqlQueryV2(
        transactionsCollectionQuery,
        {
          slug: collective.slug,
          merchantId: ['ch_123', 'paypov'],
        },
        hostAdmin,
      );
      expect(result.data.transactions.totalCount).to.eq(2);
      expect(result.data.transactions.nodes).to.containSubset([{ merchantId: 'ch_123' }, { merchantId: 'paypov' }]);
    });

    it('by Accounting Category', async () => {
      const result = await graphqlQueryV2(transactionsCollectionQuery, {
        slug: collective.slug,
        accountingCategory: 'TEST-001',
      });
      expect(result.data.transactions.totalCount).to.eq(1);
      expect(result.data.transactions.nodes).to.containSubset([
        { order: { accountingCategory: { code: 'TEST-001' } } },
      ]);
    });

    it('by excludeAccount', async () => {
      const result = await graphqlQueryV2(transactionsCollectionQuery, {
        slug: collective.slug,
        excludeAccount: [{ slug: collective.slug }],
      });
      expect(result.data.transactions.totalCount).to.eq(0);
    });
  });

  it('by group', async () => {
    const group = transactions[0].TransactionGroup;
    const result = await graphqlQueryV2(transactionsCollectionQuery, {
      slug: collective.slug,
      group: group,
    });
    result.data.transactions.nodes.forEach(transaction => {
      expect(transaction).to.have.property('group', group);
    });
  });

  describe('permissions', () => {
    it('can see legalName if owner or host admin', async () => {
      const randomUser = await fakeUser();
      const queryArgs = { slug: collective.slug };

      const resultUnauthenticated = await graphqlQueryV2(transactionsCollectionQuery, queryArgs);
      resultUnauthenticated.data.transactions.nodes.forEach(transaction => {
        expect(transaction.fromAccount.legalName).to.be.null;
        expect(transaction.oppositeAccount.legalName).to.be.null;
        expect(transaction.account.legalName).to.be.null;
        expect(transaction.toAccount.legalName).to.be.null;
      });

      const resultRandomUser = await graphqlQueryV2(transactionsCollectionQuery, queryArgs, randomUser);
      resultRandomUser.data.transactions.nodes.forEach(transaction => {
        expect(transaction.fromAccount.legalName).to.be.null;
        expect(transaction.oppositeAccount.legalName).to.be.null;
        expect(transaction.account.legalName).to.be.null;
        expect(transaction.toAccount.legalName).to.be.null;
      });

      const resultCollectiveAdmin = await graphqlQueryV2(transactionsCollectionQuery, queryArgs, collectiveAdmin);
      resultCollectiveAdmin.data.transactions.nodes.forEach(transaction => {
        expect(transaction.fromAccount.legalName).to.be.null;
        expect(transaction.oppositeAccount.legalName).to.be.null;
        expect(transaction.account.legalName).to.be.null;
        expect(transaction.toAccount.legalName).to.be.null;
      });

      const resultFromCollectiveAdmin = await graphqlQueryV2(
        transactionsCollectionQuery,
        queryArgs,
        fromCollectiveAdmin,
      );
      resultFromCollectiveAdmin.data.transactions.nodes.forEach(transaction => {
        if (transaction.type === 'CREDIT') {
          expect(transaction.fromAccount.legalName).to.eq('Secret Corp');
          expect(transaction.oppositeAccount.legalName).to.eq('Secret Corp');
          expect(transaction.account.legalName).to.be.null;
        } else {
          expect(transaction.oppositeAccount.legalName).to.eq('Secret Corp');
          expect(transaction.toAccount.legalName).to.eq('Secret Corp');
          expect(transaction.account.legalName).to.be.null;
        }
      });

      const resultHostCollectiveAdmin = await graphqlQueryV2(transactionsCollectionQuery, queryArgs, hostAdmin);
      resultHostCollectiveAdmin.data.transactions.nodes.forEach(transaction => {
        if (transaction.type === 'CREDIT') {
          expect(transaction.fromAccount.legalName).to.eq('Secret Corp');
          expect(transaction.oppositeAccount.legalName).to.eq('Secret Corp');
          expect(transaction.account.legalName).to.be.null;
        } else {
          expect(transaction.oppositeAccount.legalName).to.eq('Secret Corp');
          expect(transaction.toAccount.legalName).to.eq('Secret Corp');
          expect(transaction.account.legalName).to.be.null;
        }
      });
    });

    it('can see fromAccount.location.address if host admin', async () => {
      const randomUser = await fakeUser();
      const testHostAdmin = await fakeUser();
      const testFromCollectiveAdmin = await fakeUser();
      const testHost = await fakeHost({ admin: testHostAdmin.collective });
      const testFromCollective = await fakeOrganization({
        legalName: 'Test Corp',
        location: { address: '123 Secret Street' },
        admin: testFromCollectiveAdmin.collective,
      });
      const testCollective = await fakeCollective({ HostCollectiveId: testHost.id });
      const testOrder = await fakeOrder({
        FromCollectiveId: testFromCollective.id,
        CollectiveId: testCollective.id,
      });
      await fakeTransaction({
        FromCollectiveId: testFromCollective.id,
        CollectiveId: testCollective.id,
        HostCollectiveId: testHost.id,
        OrderId: testOrder.id,
        kind: TransactionKind.CONTRIBUTION,
        amount: 1000,
      });

      const queryArgs = { slug: testCollective.slug };

      // Unauthenticated user should not see location address
      const resultUnauthenticated = await graphqlQueryV2(transactionsCollectionQuery, queryArgs);
      resultUnauthenticated.data.transactions.nodes.forEach(transaction => {
        expect(transaction.fromAccount?.location?.address).to.be.null;
      });

      // Random user should not see location address
      const resultRandomUser = await graphqlQueryV2(transactionsCollectionQuery, queryArgs, randomUser);
      resultRandomUser.data.transactions.nodes.forEach(transaction => {
        expect(transaction.fromAccount?.location?.address).to.be.null;
      });

      // FromCollective admin should see their own location address
      const resultFromCollectiveAdmin = await graphqlQueryV2(
        transactionsCollectionQuery,
        queryArgs,
        testFromCollectiveAdmin,
      );
      resultFromCollectiveAdmin.data.transactions.nodes.forEach(transaction => {
        expect(transaction.fromAccount?.location?.address).to.eq('123 Secret Street');
      });

      // Host admin should see the location address
      const resultHostAdmin = await graphqlQueryV2(transactionsCollectionQuery, queryArgs, testHostAdmin);
      resultHostAdmin.data.transactions.nodes.forEach(transaction => {
        expect(transaction.fromAccount?.location?.address).to.eq('123 Secret Street');
      });
    });

    it('can only see taxInfo.idNumber if host admin/accountant', async () => {
      const SECRET_TAX_ID = 'FRXX999999997';
      const randomUser = await fakeUser();
      const testHostAdmin = await fakeUser();
      const testHostAccountant = await fakeUser();
      const testFromCollectiveAdmin = await fakeUser();
      const testFromCollectiveAccountant = await fakeUser();
      const testCollectiveAdmin = await fakeUser();
      const testHost = await fakeHost({ admin: testHostAdmin.collective });
      await fakeMember({
        CollectiveId: testHost.id,
        MemberCollectiveId: testHostAccountant.CollectiveId,
        role: roles.ACCOUNTANT,
      });
      const testFromCollective = await fakeOrganization({
        admin: testFromCollectiveAdmin.collective,
      });
      await fakeMember({
        CollectiveId: testFromCollective.id,
        MemberCollectiveId: testFromCollectiveAccountant.CollectiveId,
        role: roles.ACCOUNTANT,
      });
      const testCollective = await fakeCollective({
        admin: testCollectiveAdmin.collective,
        HostCollectiveId: testHost.id,
      });
      await fakeTransaction({
        type: 'CREDIT',
        FromCollectiveId: testFromCollective.id,
        CollectiveId: testCollective.id,
        HostCollectiveId: testHost.id,
        kind: TransactionKind.CONTRIBUTION,
        amount: 1000,
        data: {
          tax: {
            id: 'VAT',
            idNumber: SECRET_TAX_ID,
            percentage: 20,
            rate: 0.2,
          },
        },
      });

      const queryArgs = { slug: testCollective.slug };
      const expectTaxIdToBeNull = result => {
        result.data.transactions.nodes.forEach(transaction => {
          expect(transaction.taxInfo?.idNumber ?? null).to.be.null;
        });
      };
      const expectTaxIdToBeVisible = result => {
        const transactionsWithTax = result.data.transactions.nodes.filter(t => t.taxInfo);
        expect(transactionsWithTax.length).to.be.above(0);
        transactionsWithTax.forEach(transaction => {
          expect(transaction.taxInfo.idNumber).to.equal(SECRET_TAX_ID);
        });
      };

      expectTaxIdToBeNull(await graphqlQueryV2(transactionsCollectionQuery, queryArgs));
      expectTaxIdToBeNull(await graphqlQueryV2(transactionsCollectionQuery, queryArgs, randomUser));
      expectTaxIdToBeNull(await graphqlQueryV2(transactionsCollectionQuery, queryArgs, testCollectiveAdmin));
      expectTaxIdToBeVisible(await graphqlQueryV2(transactionsCollectionQuery, queryArgs, testHostAdmin));
      expectTaxIdToBeVisible(await graphqlQueryV2(transactionsCollectionQuery, queryArgs, testHostAccountant));
      expectTaxIdToBeNull(await graphqlQueryV2(transactionsCollectionQuery, queryArgs, testFromCollectiveAdmin)); // Not yet, but we'll ultimately allow this
      expectTaxIdToBeNull(await graphqlQueryV2(transactionsCollectionQuery, queryArgs, testFromCollectiveAccountant)); // Not yet, but we'll ultimately allow this
    });
  });
});

describe('Transaction collection visibility for private organizations', () => {
  before(resetTestDB);

  const DESC_TX_PRIVATE_1 = 'Transaction to private collective 1';
  const DESC_TX_PRIVATE_2 = 'Transaction to private collective 2';
  const DESC_TX_PUBLIC = 'Transaction to public collective';

  let privateHost;
  let privateCollective;
  let privateCollective2;
  let publicCollective;
  let contributorUser;
  let privateHostAdminUser;
  let privateCollectiveAdminUser;
  let privateCollective2AdminUser;
  let randomUser;

  before(async () => {
    privateHostAdminUser = await fakeUser();
    privateHost = await fakePrivateHost({ admin: privateHostAdminUser.collective });
    privateCollectiveAdminUser = await fakeUser();
    privateCollective = await fakeCollective({
      HostCollectiveId: privateHost.id,
      isPrivate: true,
      approvedAt: new Date(),
      admin: privateCollectiveAdminUser.collective,
    });
    privateCollective2AdminUser = await fakeUser();
    privateCollective2 = await fakeCollective({
      HostCollectiveId: privateHost.id,
      isPrivate: true,
      approvedAt: new Date(),
      admin: privateCollective2AdminUser.collective,
    });
    const publicHost = await fakeActiveHost();
    publicCollective = await fakeCollective({ HostCollectiveId: publicHost.id, approvedAt: new Date() });
    contributorUser = await fakeUser();
    randomUser = await fakeUser();

    await fakeTransaction({
      FromCollectiveId: contributorUser.CollectiveId,
      CollectiveId: privateCollective.id,
      HostCollectiveId: privateHost.id,
      CreatedByUserId: contributorUser.id,
      kind: TransactionKind.CONTRIBUTION,
      amount: 1000,
      description: DESC_TX_PRIVATE_1,
    });
    await fakeTransaction({
      FromCollectiveId: contributorUser.CollectiveId,
      CollectiveId: privateCollective2.id,
      HostCollectiveId: privateHost.id,
      CreatedByUserId: contributorUser.id,
      kind: TransactionKind.CONTRIBUTION,
      amount: 1000,
      description: DESC_TX_PRIVATE_2,
    });
    await fakeTransaction({
      FromCollectiveId: contributorUser.CollectiveId,
      CollectiveId: publicCollective.id,
      HostCollectiveId: publicHost.id,
      CreatedByUserId: contributorUser.id,
      kind: TransactionKind.CONTRIBUTION,
      amount: 1000,
      description: DESC_TX_PUBLIC,
    });
  });

  describe('when listing transactions from an individual (fromAccount)', () => {
    const queryFromContributorProfile = () => ({
      fromAccount: { legacyId: contributorUser.CollectiveId },
    });

    it('user can see own transactions involving private organizations', async () => {
      const result = await graphqlQueryV2(transactionsPrivateOrgQuery, queryFromContributorProfile(), contributorUser);
      expect(result.errors).to.not.exist;
      const descriptions = result.data.transactions.nodes.map(n => n.description);
      expect(descriptions).to.include.members([DESC_TX_PRIVATE_1, DESC_TX_PRIVATE_2, DESC_TX_PUBLIC]);
    });

    it('host admins can see transactions involving private organizations', async () => {
      const result = await graphqlQueryV2(
        transactionsPrivateOrgQuery,
        queryFromContributorProfile(),
        privateHostAdminUser,
      );
      expect(result.errors).to.not.exist;
      const descriptions = result.data.transactions.nodes.map(n => n.description);
      expect(descriptions).to.include.members([DESC_TX_PRIVATE_1, DESC_TX_PRIVATE_2, DESC_TX_PUBLIC]);
    });

    it('collective admins can see transactions involving their private collective', async () => {
      const result = await graphqlQueryV2(
        transactionsPrivateOrgQuery,
        queryFromContributorProfile(),
        privateCollectiveAdminUser,
      );
      expect(result.errors).to.not.exist;
      const descriptions = result.data.transactions.nodes.map(n => n.description);
      expect(descriptions).to.include.members([DESC_TX_PRIVATE_1, DESC_TX_PUBLIC]);
      expect(descriptions).to.not.include(DESC_TX_PRIVATE_2);
    });

    it("random user can't see transactions involving private organizations", async () => {
      const result = await graphqlQueryV2(transactionsPrivateOrgQuery, queryFromContributorProfile(), randomUser);
      expect(result.errors).to.not.exist;
      const descriptions = result.data.transactions.nodes.map(n => n.description);
      expect(descriptions).to.eql([DESC_TX_PUBLIC]);
    });

    it("admin of other collective under same host can't see transactions to private collective 2", async () => {
      const result = await graphqlQueryV2(
        transactionsPrivateOrgQuery,
        queryFromContributorProfile(),
        privateCollectiveAdminUser,
      );
      expect(result.errors).to.not.exist;
      expect(result.data.transactions.nodes.map(n => n.description)).to.not.include(DESC_TX_PRIVATE_2);
    });

    it("unauthenticated can't see transactions involving private organizations", async () => {
      const result = await graphqlQueryV2(transactionsPrivateOrgQuery, queryFromContributorProfile(), null);
      expect(result.errors).to.not.exist;
      const descriptions = result.data.transactions.nodes.map(n => n.description);
      expect(descriptions).to.eql([DESC_TX_PUBLIC]);
    });
  });

  describe('Transactions from a public account to a private account', () => {
    /**
     * These cases only exercise list filtering for the contributor profile (a USER collective, never private).
     * The query always references that public individual via `fromAccount` or `account`; the API must not fail
     * here - unauthorized viewers simply get a shorter list without rows involving private counterparties.
     */
    const listDescriptionsForPublicIndividual = async (
      individualCollectiveLegacyId: number,
      listing: 'fromAccount' | 'account',
      remoteUser: Awaited<ReturnType<typeof fakeUser>> | null,
    ) => {
      const variables =
        listing === 'fromAccount'
          ? { fromAccount: { legacyId: individualCollectiveLegacyId } }
          : { account: [{ legacyId: individualCollectiveLegacyId }] };

      const result = await graphqlQueryV2(transactionsPrivateOrgQuery, variables, remoteUser);
      expect(result.data?.transactions?.nodes, 'expected filtered transaction list payload').to.exist;
      return result.data.transactions.nodes.map(n => n.description);
    };

    const expectFilteredOutgoingToPrivate = async ({
      individualCollectiveLegacyId,
      listing,
      descPublic,
      descPrivate,
      individualUser,
      authorizedViewers: authorizedViewersOverride,
      unauthorizedViewers: unauthorizedViewersOverride,
    }: {
      individualCollectiveLegacyId: number;
      listing: 'fromAccount' | 'account';
      descPublic: string;
      descPrivate: string;
      individualUser: Awaited<ReturnType<typeof fakeUser>>;
      authorizedViewers?: (Awaited<ReturnType<typeof fakeUser>> | null)[];
      unauthorizedViewers?: (Awaited<ReturnType<typeof fakeUser>> | null)[];
    }) => {
      const authorizedViewers = authorizedViewersOverride ?? [
        individualUser,
        privateHostAdminUser,
        privateCollectiveAdminUser,
      ];
      for (const viewer of authorizedViewers) {
        const descriptions = await listDescriptionsForPublicIndividual(individualCollectiveLegacyId, listing, viewer);
        expect(descriptions).to.include(descPublic);
        expect(descriptions).to.include(descPrivate);
      }

      const unauthorizedViewers = unauthorizedViewersOverride ?? [privateCollective2AdminUser, randomUser, null];
      for (const viewer of unauthorizedViewers) {
        const descriptions = await listDescriptionsForPublicIndividual(individualCollectiveLegacyId, listing, viewer);
        expect(descriptions).to.include(descPublic);
        expect(descriptions).to.not.include(descPrivate);
      }
    };

    describe('for an expense', () => {
      const DESC_PUBLIC = 'Expense to public collective';
      const DESC_PRIVATE = 'Expense to private collective';
      let individualUser: Awaited<ReturnType<typeof fakeUser>>;

      before(async () => {
        individualUser = await fakeUser();

        // Transaction from individual to a public collective - always visible
        await fakeTransaction(
          {
            FromCollectiveId: individualUser.CollectiveId,
            CollectiveId: publicCollective.id,
            HostCollectiveId: publicCollective.HostCollectiveId,
            CreatedByUserId: individualUser.id,
            kind: TransactionKind.CONTRIBUTION,
            amount: 1100,
            description: DESC_PUBLIC,
          },
          { createDoubleEntry: true },
        );

        // Transaction from individual to a private collective
        await fakePaidExpense({
          CollectiveId: privateCollective.id,
          FromCollectiveId: individualUser.CollectiveId,
          UserId: individualUser.id,
          description: DESC_PRIVATE,
        });
      });

      it('using the fromAccount parameter', async () => {
        await expectFilteredOutgoingToPrivate({
          individualCollectiveLegacyId: individualUser.CollectiveId,
          listing: 'fromAccount',
          descPublic: DESC_PUBLIC,
          descPrivate: DESC_PRIVATE,
          individualUser,
        });
      });

      it('using the account parameter', async () => {
        // When filtering by `account`, the query matches the opposite DEBIT row (CollectiveId=individual,
        // HostCollectiveId=null). The host admin's directAccess relies on HostCollectiveId to match, so
        // they cannot see the private transaction through this path.
        await expectFilteredOutgoingToPrivate({
          individualCollectiveLegacyId: individualUser.CollectiveId,
          listing: 'account',
          descPublic: DESC_PUBLIC,
          descPrivate: DESC_PRIVATE,
          individualUser,
          authorizedViewers: [individualUser, privateCollectiveAdminUser],
          unauthorizedViewers: [privateHostAdminUser, privateCollective2AdminUser, randomUser, null],
        });
      });
    });

    describe('for a contribution', () => {
      const DESC_PUBLIC = 'Contribution to public collective';
      const DESC_PRIVATE = 'Contribution to private collective';
      let individualUser: Awaited<ReturnType<typeof fakeUser>>;

      before(async () => {
        individualUser = await fakeUser();

        await fakeTransaction(
          {
            FromCollectiveId: individualUser.CollectiveId,
            CollectiveId: publicCollective.id,
            HostCollectiveId: publicCollective.HostCollectiveId,
            CreatedByUserId: individualUser.id,
            kind: TransactionKind.CONTRIBUTION,
            amount: 1200,
            description: DESC_PUBLIC,
          },
          { createDoubleEntry: true },
        );

        await fakeTransaction(
          {
            FromCollectiveId: individualUser.CollectiveId,
            CollectiveId: privateCollective.id,
            HostCollectiveId: privateHost.id,
            CreatedByUserId: individualUser.id,
            kind: TransactionKind.CONTRIBUTION,
            amount: 1200,
            description: DESC_PRIVATE,
          },
          { createDoubleEntry: true },
        );
      });

      it('using the fromAccount parameter', async () => {
        await expectFilteredOutgoingToPrivate({
          individualCollectiveLegacyId: individualUser.CollectiveId,
          listing: 'fromAccount',
          descPublic: DESC_PUBLIC,
          descPrivate: DESC_PRIVATE,
          individualUser,
        });
      });

      it('using the account parameter', async () => {
        // When filtering by `account`, the query matches the opposite DEBIT row (CollectiveId=individual,
        // HostCollectiveId=null). The host admin's directAccess relies on HostCollectiveId to match, so
        // they cannot see the private transaction through this path.
        await expectFilteredOutgoingToPrivate({
          individualCollectiveLegacyId: individualUser.CollectiveId,
          listing: 'account',
          descPublic: DESC_PUBLIC,
          descPrivate: DESC_PRIVATE,
          individualUser,
          authorizedViewers: [individualUser, privateCollectiveAdminUser],
          unauthorizedViewers: [privateHostAdminUser, privateCollective2AdminUser, randomUser, null],
        });
      });
    });
  });

  describe('private organizations', () => {
    const privateTransactionForbiddenMessage =
      'One or more of the accounts are private. You must be a member to view them.';

    it("can't be queried by random user (account, host, fromAccount)", async () => {
      for (const variables of [
        { account: [{ legacyId: privateCollective.id }] },
        { host: { legacyId: privateHost.id } },
        { fromAccount: { legacyId: privateCollective.id } },
      ]) {
        const result = await graphqlQueryV2(transactionsPrivateOrgQuery, variables, randomUser);
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.eq(privateTransactionForbiddenMessage);
      }
    });

    it("can't be queried by unauthenticated (account, host, fromAccount)", async () => {
      for (const variables of [
        { account: [{ legacyId: privateCollective.id }] },
        { host: { legacyId: privateHost.id } },
        { fromAccount: { legacyId: privateCollective.id } },
      ]) {
        const result = await graphqlQueryV2(transactionsPrivateOrgQuery, variables, null);
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.eq(privateTransactionForbiddenMessage);
      }
    });

    it("can't be queried by other collective admin under same host", async () => {
      const result = await graphqlQueryV2(
        transactionsPrivateOrgQuery,
        { account: [{ legacyId: privateCollective2.id }] },
        privateCollectiveAdminUser,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.eq(privateTransactionForbiddenMessage);
    });

    it('can be queried by collective admin', async () => {
      const result = await graphqlQueryV2(
        transactionsPrivateOrgQuery,
        { account: [{ legacyId: privateCollective.id }] },
        privateCollectiveAdminUser,
      );
      expect(result.errors).to.not.exist;
      expect(result.data.transactions.nodes.map(n => n.description)).to.include(DESC_TX_PRIVATE_1);
    });

    it('can be queried by host admin', async () => {
      const result = await graphqlQueryV2(
        transactionsPrivateOrgQuery,
        { host: { legacyId: privateHost.id } },
        privateHostAdminUser,
      );
      expect(result.errors).to.not.exist;
      expect(result.data.transactions.nodes.map(n => n.description)).to.include.members([
        DESC_TX_PRIVATE_1,
        DESC_TX_PRIVATE_2,
      ]);
    });
  });
});
