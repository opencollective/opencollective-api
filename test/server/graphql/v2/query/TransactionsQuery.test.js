import { expect } from 'chai';
import gqlV2 from 'fake-tag';

import {
  fakeCollective,
  fakeHost,
  fakeOrganization,
  fakeTransaction,
  fakeUser,
} from '../../../../test-helpers/fake-data';
import { graphqlQueryV2 } from '../../../../utils';

const transactionsQuery = gqlV2/* GraphQL */ `
  query Transactions(
    $slug: String!
    $type: TransactionType
    $minAmount: Int
    $maxAmount: Int
    $dateFrom: DateTime
    $searchTerm: String
  ) {
    transactions(
      account: { slug: $slug }
      type: $type
      minAmount: $minAmount
      maxAmount: $maxAmount
      dateFrom: $dateFrom
      searchTerm: $searchTerm
    ) {
      totalCount
      offset
      limit
      nodes {
        id
        type
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

describe('server/graphql/v2/query/TransactionsQuery', () => {
  let transactions, collective, collectiveAdmin, fromCollectiveAdmin, hostAdmin;

  before(async () => {
    collectiveAdmin = await fakeUser();
    fromCollectiveAdmin = await fakeUser({});
    hostAdmin = await fakeUser();

    const fromCollective = await fakeOrganization({ legalName: 'Secret Corp', admin: fromCollectiveAdmin.collective });
    const host = await fakeHost({ admin: hostAdmin.collective });
    collective = await fakeCollective({ admin: collectiveAdmin.collective, HostCollectiveId: host.id });

    const baseTransaction = {
      FromCollectiveId: fromCollective.id,
      CollectiveId: collective.id,
      HostCollectiveId: host.id,
    };
    transactions = await Promise.all([
      fakeTransaction({ ...baseTransaction, amount: 10000 }),
      fakeTransaction({ ...baseTransaction, amount: -15000 }),
      fakeTransaction({ ...baseTransaction, amount: 10, description: 'this is a test' }),
    ]);
  });

  it('filters', async () => {
    const queryParams = { slug: collective.slug };

    let result = await graphqlQueryV2(transactionsQuery, queryParams);
    expect(result.data.transactions.totalCount).to.eq(transactions.length);

    result = await graphqlQueryV2(transactionsQuery, { ...queryParams, minAmount: 9000 });
    expect(result.data.transactions.totalCount).to.eq(2);

    result = await graphqlQueryV2(transactionsQuery, { ...queryParams, type: 'DEBIT' });
    expect(result.data.transactions.totalCount).to.eq(1);

    result = await graphqlQueryV2(transactionsQuery, { ...queryParams, searchTerm: 'this' });
    expect(result.data.transactions.totalCount).to.eq(1);

    result = await graphqlQueryV2(transactionsQuery, { ...queryParams, maxAmount: 20 });
    expect(result.data.transactions.totalCount).to.eq(1);
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
