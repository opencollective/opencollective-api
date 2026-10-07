import { expect } from 'chai';
import gql from 'fake-tag';
import moment from 'moment';

import { TransactionKind } from '../../../../../server/constants/transaction-kind';
import { fakeCollective, fakeOrder, fakeTransaction } from '../../../../test-helpers/fake-data';
import { graphqlQueryV2, resetTestDB } from '../../../../utils';

const accountQuery = gql`
  query Account($slug: String!, $includeChildren: Boolean!) {
    account(slug: $slug) {
      id
      stats {
        contributionsAmount(includeChildren: $includeChildren) {
          label
          count
          amount {
            value
            valueInCents
            currency
          }
        }
      }
    }
  }
`;

describe('server/graphql/v2/object/AccountStats', () => {
  before(async () => {
    await resetTestDB({ groupedTruncate: false });
  });

  let collective, project;
  beforeEach(async () => {
    collective = await fakeCollective({ type: 'COLLECTIVE' });
    const order1 = await fakeOrder({ CollectiveId: collective.id, amount: 100000 }, { withSubscription: false });
    await fakeTransaction({ CollectiveId: collective.id, kind: 'CONTRIBUTION', amount: 100000, OrderId: order1.id });
    const order2 = await fakeOrder({ CollectiveId: collective.id, amount: 50000 }, { withSubscription: true });
    await fakeTransaction({ CollectiveId: collective.id, kind: 'CONTRIBUTION', amount: 50000, OrderId: order2.id });

    project = await fakeCollective({ ParentCollectiveId: collective.id, type: 'PROJECT' });
    const order3 = await fakeOrder({ CollectiveId: project.id, amount: 10000 }, { withSubscription: false });
    await fakeTransaction({ CollectiveId: project.id, kind: 'CONTRIBUTION', amount: 10000, OrderId: order3.id });
  });

  describe('contributionsAmount', () => {
    it('should return contributionsAmount for recurring vs. one-time donations', async () => {
      const result = await graphqlQueryV2(accountQuery, { slug: collective.slug, includeChildren: false });
      const contributionsAmount = result.data.account.stats.contributionsAmount;

      expect(contributionsAmount).to.containSubset([{ label: 'one-time', amount: { value: 1000 } }]);
      expect(contributionsAmount).to.containSubset([{ label: 'recurring', amount: { value: 500 } }]);
    });

    it('should include children collective donations', async () => {
      const result = await graphqlQueryV2(accountQuery, { slug: collective.slug, includeChildren: true });
      const contributionsAmount = result.data.account.stats.contributionsAmount;

      expect(contributionsAmount).to.containSubset([{ label: 'one-time', amount: { value: 1100 } }]);
      expect(contributionsAmount).to.containSubset([{ label: 'recurring', amount: { value: 500 } }]);
    });

    it('should ignore contributions between parent and children collective', async () => {
      await fakeTransaction(
        { CollectiveId: project.id, FromCollectiveId: collective.id, kind: 'CONTRIBUTION', amount: 20000 },
        { createDoubleEntry: true },
      );
      await fakeTransaction(
        { CollectiveId: collective.id, FromCollectiveId: project.id, kind: 'CONTRIBUTION', amount: 30000 },
        { createDoubleEntry: true },
      );

      const result = await graphqlQueryV2(accountQuery, { slug: collective.slug, includeChildren: true });
      const contributionsAmount = result.data.account.stats.contributionsAmount;

      expect(contributionsAmount).to.containSubset([{ label: 'one-time', amount: { value: 1100 } }]);
      expect(contributionsAmount).to.containSubset([{ label: 'recurring', amount: { value: 500 } }]);
    });
  });

  describe('totalAmountSpentTimeSeries', () => {
    const totalAmountSpentTimeSeriesQuery = gql`
      query Account(
        $slug: String!
        $dateFrom: DateTime
        $dateTo: DateTime
        $timeUnit: TimeUnit
        $kind: [TransactionKind]
        $includeChildren: Boolean
        $periodInMonths: Int
      ) {
        account(slug: $slug) {
          stats {
            totalAmountSpentTimeSeries(
              dateFrom: $dateFrom
              dateTo: $dateTo
              timeUnit: $timeUnit
              kind: $kind
              includeChildren: $includeChildren
              periodInMonths: $periodInMonths
            ) {
              timeUnit
              nodes {
                date
                amount {
                  value
                  valueInCents
                  currency
                }
              }
            }
          }
        }
      }
    `;

    let spendCollective, spendProject;

    beforeEach(async () => {
      spendCollective = await fakeCollective({ type: 'COLLECTIVE', currency: 'USD' });
      spendProject = await fakeCollective({
        type: 'PROJECT',
        currency: 'USD',
        ParentCollectiveId: spendCollective.id,
      });

      await fakeTransaction(
        {
          type: 'DEBIT',
          kind: TransactionKind.EXPENSE,
          CollectiveId: spendCollective.id,
          amount: -50e2,
          createdAt: new Date('2025-06-15'),
        },
        { createDoubleEntry: true },
      );
      await fakeTransaction(
        {
          type: 'DEBIT',
          kind: TransactionKind.EXPENSE,
          CollectiveId: spendCollective.id,
          amount: -30e2,
          createdAt: new Date('2025-07-10'),
        },
        { createDoubleEntry: true },
      );
    });

    const getNodes = result => {
      const series = result.data.account.stats.totalAmountSpentTimeSeries;
      // Nodes come back in aggregation order (newest first), same as totalAmountReceivedTimeSeries.
      // Assert on dates sorted ascending so the tests pin values, not SQL row order.
      return series.nodes
        .map(node => ({
          date: moment(node.date).toISOString(),
          value: node.amount.value,
          valueInCents: node.amount.valueInCents,
          currency: node.amount.currency,
        }))
        .sort((a, b) => a.date.localeCompare(b.date));
    };

    it('returns one absolute node per period', async () => {
      const result = await graphqlQueryV2(totalAmountSpentTimeSeriesQuery, {
        slug: spendCollective.slug,
        dateFrom: '2025-06-01T00:00:00.000Z',
        dateTo: '2025-08-01T00:00:00.000Z',
        timeUnit: 'MONTH',
      });
      result.errors && console.error(result.errors);

      expect(getNodes(result)).to.deep.equal([
        { date: '2025-06-01T00:00:00.000Z', value: 50, valueInCents: 50e2, currency: 'USD' },
        { date: '2025-07-01T00:00:00.000Z', value: 30, valueInCents: 30e2, currency: 'USD' },
      ]);
    });

    it('derives the time unit from the date range when not provided', async () => {
      const result = await graphqlQueryV2(totalAmountSpentTimeSeriesQuery, {
        slug: spendCollective.slug,
        dateFrom: moment().subtract(40, 'days').toISOString(),
        dateTo: moment().toISOString(),
      });
      result.errors && console.error(result.errors);

      // 40 days => WEEK (per getTimeUnit thresholds)
      expect(result.data.account.stats.totalAmountSpentTimeSeries.timeUnit).to.equal('WEEK');
    });

    it('only includes transactions within periodInMonths', async () => {
      await fakeTransaction(
        {
          type: 'DEBIT',
          kind: TransactionKind.EXPENSE,
          CollectiveId: spendCollective.id,
          amount: -70e2,
          createdAt: moment().subtract(10, 'days').toDate(),
        },
        { createDoubleEntry: true },
      );

      const result = await graphqlQueryV2(totalAmountSpentTimeSeriesQuery, {
        slug: spendCollective.slug,
        timeUnit: 'MONTH',
        periodInMonths: 1,
      });
      result.errors && console.error(result.errors);

      // The 2025-06/2025-07 transactions are outside the window; only the recent one is counted
      const nodes = getNodes(result);
      expect(nodes).to.have.length(1);
      expect(nodes[0].value).to.equal(70);
    });

    it('includes children spend only when includeChildren is true', async () => {
      await fakeTransaction(
        {
          type: 'DEBIT',
          kind: TransactionKind.EXPENSE,
          CollectiveId: spendProject.id,
          amount: -20e2,
          createdAt: new Date('2025-06-20'),
        },
        { createDoubleEntry: true },
      );

      const withoutChildren = await graphqlQueryV2(totalAmountSpentTimeSeriesQuery, {
        slug: spendCollective.slug,
        dateFrom: '2025-06-01T00:00:00.000Z',
        dateTo: '2025-08-01T00:00:00.000Z',
        timeUnit: 'MONTH',
        includeChildren: false,
      });
      const withChildren = await graphqlQueryV2(totalAmountSpentTimeSeriesQuery, {
        slug: spendCollective.slug,
        dateFrom: '2025-06-01T00:00:00.000Z',
        dateTo: '2025-08-01T00:00:00.000Z',
        timeUnit: 'MONTH',
        includeChildren: true,
      });
      withChildren.errors && console.error(withChildren.errors);

      expect(getNodes(withoutChildren)).to.deep.equal([
        { date: '2025-06-01T00:00:00.000Z', value: 50, valueInCents: 50e2, currency: 'USD' },
        { date: '2025-07-01T00:00:00.000Z', value: 30, valueInCents: 30e2, currency: 'USD' },
      ]);
      expect(getNodes(withChildren)).to.deep.equal([
        { date: '2025-06-01T00:00:00.000Z', value: 70, valueInCents: 70e2, currency: 'USD' },
        { date: '2025-07-01T00:00:00.000Z', value: 30, valueInCents: 30e2, currency: 'USD' },
      ]);
    });

    it('filters by transaction kind', async () => {
      await fakeTransaction(
        {
          type: 'DEBIT',
          kind: TransactionKind.PREPAID_EXPENSE,
          CollectiveId: spendCollective.id,
          amount: -25e2,
          createdAt: new Date('2025-06-20'),
        },
        { createDoubleEntry: true },
      );

      const result = await graphqlQueryV2(totalAmountSpentTimeSeriesQuery, {
        slug: spendCollective.slug,
        dateFrom: '2025-06-01T00:00:00.000Z',
        dateTo: '2025-08-01T00:00:00.000Z',
        timeUnit: 'MONTH',
        kind: [TransactionKind.EXPENSE],
      });
      result.errors && console.error(result.errors);

      expect(getNodes(result)).to.deep.equal([
        { date: '2025-06-01T00:00:00.000Z', value: 50, valueInCents: 50e2, currency: 'USD' },
        { date: '2025-07-01T00:00:00.000Z', value: 30, valueInCents: 30e2, currency: 'USD' },
      ]);
    });
  });
});
