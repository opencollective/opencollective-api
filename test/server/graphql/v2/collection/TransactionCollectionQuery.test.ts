import { expect } from 'chai';
import gql from 'fake-tag';

import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../../../../../server/constants/paymentMethods';
import { TransactionKind } from '../../../../../server/constants/transaction-kind';
import {
  fakeCollective,
  fakeHost,
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
  ) {
    transactions(
      account: { slug: $slug }
      type: $type
      minAmount: $minAmount
      maxAmount: $maxAmount
      dateFrom: $dateFrom
      searchTerm: $searchTerm
      paymentMethodType: $paymentMethodType
    ) {
      totalCount
      offset
      limit
      kinds
      paymentMethodTypes
      nodes {
        id
        type
        paymentMethod {
          id
          type
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
      }),
      fakeTransaction({
        ...baseTransaction,
        kind: TransactionKind.CONTRIBUTION,
        amount: 10,
        description: 'this is a test',
        PaymentMethodId: PaypalPm.id,
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
  });

  describe('permissions', () => {
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
