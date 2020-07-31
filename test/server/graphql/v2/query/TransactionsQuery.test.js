import { expect } from 'chai';

import { fakeCollective, fakeTransaction } from '../../../../test-helpers/fake-data';
import { graphqlQueryV2 } from '../../../../utils';

const TRANSACTIONS_QUERY = `
  query Transactions(
    $slug: String!
    $type: TransactionType
    $minAmount: Int
    $maxAmount: Int
    $dateFrom: ISODateTime
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
      }
    }
  }
`;

describe('server/graphql/v2/query/TransactionsQuery', () => {
  let transactions, collective;

  before(async () => {
    collective = await fakeCollective();

    transactions = await Promise.all([
      fakeTransaction({ CollectiveId: collective.id, amount: 10000 }),
      fakeTransaction({ CollectiveId: collective.id, amount: -15000 }),
      fakeTransaction({ CollectiveId: collective.id, amount: 10, description: 'this is a test' }),
    ]);
  });

  it('filters', async () => {
    const queryParams = { slug: collective.slug };

    let result = await graphqlQueryV2(TRANSACTIONS_QUERY, queryParams);
    expect(result.data.transactions.totalCount).to.eq(transactions.length);

    result = await graphqlQueryV2(TRANSACTIONS_QUERY, { ...queryParams, minAmount: 9000 });
    expect(result.data.transactions.totalCount).to.eq(2);

    result = await graphqlQueryV2(TRANSACTIONS_QUERY, { ...queryParams, type: 'DEBIT' });
    expect(result.data.transactions.totalCount).to.eq(1);

    result = await graphqlQueryV2(TRANSACTIONS_QUERY, { ...queryParams, searchTerm: 'this' });
    expect(result.data.transactions.totalCount).to.eq(1);

    result = await graphqlQueryV2(TRANSACTIONS_QUERY, { ...queryParams, maxAmount: 20 });
    expect(result.data.transactions.totalCount).to.eq(1);
  });
});
