import { expect } from 'chai';
import gql from 'fake-tag';
import type Stripe from 'stripe';

import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../../../../../server/constants/paymentMethods';
import { TransactionKind } from '../../../../../server/constants/transaction-kind';
import { idEncode, IDENTIFIER_TYPES } from '../../../../../server/graphql/v2/identifiers';
import {
  fakeAccountingCategory,
  fakeCollective,
  fakeHost,
  fakeLocation,
  fakeManualPaymentProvider,
  fakeMember,
  fakeOrder,
  fakeOrganization,
  fakePaymentMethod,
  fakeTransaction,
  fakeUser,
} from '../../../../test-helpers/fake-data';
import { graphqlQueryV2 } from '../../../../utils';

const transactionsQuery = gql`
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
        }
        toAccount {
          id
          legalName
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
        const result = await graphqlQueryV2(transactionsQuery, { slug: collective.slug });
        expect(result.data.transactions.kinds).to.eqInAnyOrder([
          TransactionKind.ADDED_FUNDS,
          TransactionKind.CONTRIBUTION,
        ]);
      });

      it('is not affected by search params', async () => {
        const result = await graphqlQueryV2(transactionsQuery, { slug: collective.slug, kind: 'CONTRIBUTION' });
        expect(result.data.transactions.kinds).to.eqInAnyOrder([
          TransactionKind.ADDED_FUNDS,
          TransactionKind.CONTRIBUTION,
        ]);
      });
    });

    describe('paymentMethodTypes', () => {
      it('returns all available payment method types', async () => {
        const result = await graphqlQueryV2(transactionsQuery, { slug: collective.slug });
        expect(result.data.transactions.paymentMethodTypes).eqInAnyOrder(['CREDITCARD', 'SUBSCRIPTION', null]);
      });
    });
  });

  describe('filters', () => {
    it('none', async () => {
      const result = await graphqlQueryV2(transactionsQuery, { slug: collective.slug });
      expect(result.data.transactions.totalCount).to.eq(transactions.length);
    });

    it('by min amount', async () => {
      const result = await graphqlQueryV2(transactionsQuery, { slug: collective.slug, minAmount: 9000 });
      expect(result.data.transactions.totalCount).to.eq(2);
    });

    it('by max amount', async () => {
      const result = await graphqlQueryV2(transactionsQuery, { slug: collective.slug, maxAmount: 20 });
      expect(result.data.transactions.totalCount).to.eq(1);
    });

    it('by type', async () => {
      const result = await graphqlQueryV2(transactionsQuery, { slug: collective.slug, type: 'DEBIT' });
      expect(result.data.transactions.totalCount).to.eq(1);
    });

    it('by search term', async () => {
      const result = await graphqlQueryV2(transactionsQuery, { slug: collective.slug, searchTerm: 'this' });
      expect(result.data.transactions.totalCount).to.eq(1);
    });

    describe('by payment method type', () => {
      it('returns transactions without payment method', async () => {
        const result = await graphqlQueryV2(transactionsQuery, { slug: collective.slug, paymentMethodType: [null] });
        expect(result.data.transactions.totalCount).to.eq(1);
      });

      it('returns credit card', async () => {
        const result = await graphqlQueryV2(transactionsQuery, {
          slug: collective.slug,
          paymentMethodType: 'CREDITCARD',
        });
        expect(result.data.transactions.totalCount).to.eq(1);
        expect(result.data.transactions.nodes[0].paymentMethod.type).to.eq('CREDITCARD');
      });

      it('returns paypal', async () => {
        const result = await graphqlQueryV2(transactionsQuery, {
          slug: collective.slug,
          paymentMethodType: ['PAYMENT', 'subscription'],
        });
        expect(result.data.transactions.totalCount).to.eq(1);
        expect(result.data.transactions.nodes[0].paymentMethod.type).to.eq('SUBSCRIPTION');
      });

      it('returns paypal and credit card', async () => {
        const result = await graphqlQueryV2(transactionsQuery, {
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
        const result = await graphqlQueryV2(transactionsQuery, {
          slug: collective.slug,
          paymentMethodService: ['STRIPE'],
        });
        expect(result.data.transactions.totalCount).to.eq(1);
        expect(result.data.transactions.nodes[0].paymentMethod.service).to.eq('STRIPE');
      });

      it('returns paypal and stripe', async () => {
        const result = await graphqlQueryV2(transactionsQuery, {
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
          transactionsQuery,
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
          transactionsQuery,
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
        const result = await graphqlQueryV2(transactionsQuery, {
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
        transactionsQuery,
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
      const result = await graphqlQueryV2(transactionsQuery, {
        slug: collective.slug,
        accountingCategory: 'TEST-001',
      });
      expect(result.data.transactions.totalCount).to.eq(1);
      expect(result.data.transactions.nodes).to.containSubset([
        { order: { accountingCategory: { code: 'TEST-001' } } },
      ]);
    });

    it('by excludeAccount', async () => {
      const result = await graphqlQueryV2(transactionsQuery, {
        slug: collective.slug,
        excludeAccount: [{ slug: collective.slug }],
      });
      expect(result.data.transactions.totalCount).to.eq(0);
    });
  });

  it('by group', async () => {
    const group = transactions[0].TransactionGroup;
    const result = await graphqlQueryV2(transactionsQuery, {
      slug: collective.slug,
      group: group,
    });
    result.data.transactions.nodes.forEach(transaction => {
      expect(transaction).to.have.property('group', group);
    });
  });

  describe('permissions', () => {
    it('host admin can see fromAccount.location on transactions', async () => {
      const contributorUser = await fakeUser();
      await fakeLocation({ CollectiveId: contributorUser.CollectiveId, country: 'NZ', address: '123 Test St' });
      const locationHostAdmin = await fakeUser();
      const locationHost = await fakeHost({ admin: locationHostAdmin.collective });
      const locationCollective = await fakeCollective({ HostCollectiveId: locationHost.id });
      // Create a BACKER membership so the canSeePrivateLocation loader can find the contributor
      await fakeMember({
        CollectiveId: locationCollective.id,
        MemberCollectiveId: contributorUser.CollectiveId,
        role: 'BACKER',
      });
      await fakeTransaction({
        FromCollectiveId: contributorUser.CollectiveId,
        CollectiveId: locationCollective.id,
        HostCollectiveId: locationHost.id,
        kind: TransactionKind.CONTRIBUTION,
        amount: 5000,
      });

      const locationQuery = gql`
        query TransactionsWithLocation($slug: String!) {
          transactions(account: { slug: $slug }) {
            nodes {
              id
              fromAccount {
                id
                ... on Individual {
                  location {
                    country
                    address
                  }
                }
              }
            }
          }
        }
      `;

      // Random user should NOT see location
      const randomUser = await fakeUser();
      const resultRandom = await graphqlQueryV2(locationQuery, { slug: locationCollective.slug }, randomUser);
      expect(resultRandom.errors).to.not.exist;
      expect(resultRandom.data.transactions.nodes[0].fromAccount.location).to.be.null;

      // Host admin SHOULD see location
      const resultHostAdmin = await graphqlQueryV2(locationQuery, { slug: locationCollective.slug }, locationHostAdmin);
      expect(resultHostAdmin.errors).to.not.exist;
      expect(resultHostAdmin.data.transactions.nodes[0].fromAccount.location).to.deep.include({
        country: 'NZ',
        address: '123 Test St',
      });
    });

    it('can see legalName if owner or host admin', async () => {
      const randomUser = await fakeUser();
      const queryArgs = { slug: collective.slug };

      const resultUnauthenticated = await graphqlQueryV2(transactionsQuery, queryArgs);
      resultUnauthenticated.data.transactions.nodes.forEach(transaction => {
        expect(transaction.fromAccount.legalName).to.be.null;
        expect(transaction.oppositeAccount.legalName).to.be.null;
        expect(transaction.account.legalName).to.be.null;
        expect(transaction.toAccount.legalName).to.be.null;
      });

      const resultRandomUser = await graphqlQueryV2(transactionsQuery, queryArgs, randomUser);
      resultRandomUser.data.transactions.nodes.forEach(transaction => {
        expect(transaction.fromAccount.legalName).to.be.null;
        expect(transaction.oppositeAccount.legalName).to.be.null;
        expect(transaction.account.legalName).to.be.null;
        expect(transaction.toAccount.legalName).to.be.null;
      });

      const resultCollectiveAdmin = await graphqlQueryV2(transactionsQuery, queryArgs, collectiveAdmin);
      resultCollectiveAdmin.data.transactions.nodes.forEach(transaction => {
        expect(transaction.fromAccount.legalName).to.be.null;
        expect(transaction.oppositeAccount.legalName).to.be.null;
        expect(transaction.account.legalName).to.be.null;
        expect(transaction.toAccount.legalName).to.be.null;
      });

      const resultFromCollectiveAdmin = await graphqlQueryV2(transactionsQuery, queryArgs, fromCollectiveAdmin);
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

      const resultHostCollectiveAdmin = await graphqlQueryV2(transactionsQuery, queryArgs, hostAdmin);
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
  });
});
