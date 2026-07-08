import { expect } from 'chai';

import { roles } from '../../../../../server/constants';
import { CollectiveType } from '../../../../../server/constants/collectives';
import { TransactionKind } from '../../../../../server/constants/transaction-kind';
import { TransactionTypes } from '../../../../../server/constants/transactions';
import { sequelize } from '../../../../../server/models';
import {
  fakeActiveHost,
  fakeCollective,
  fakeEvent,
  fakeTransaction,
  fakeUser,
} from '../../../../test-helpers/fake-data';
import { graphqlQueryV2, resetTestDB } from '../../../../utils';

const METRICS_QUERY = `
  query HostMetricsParity($slug: String!, $accountSlug: String!, $from: DateTime!, $to: DateTime!) {
    host(slug: $slug) {
      id
      currency
      metrics {
        hostedCollectivesFinancialActivity(
          input: {
            dateRange: { from: $from, to: $to }
            measures: [amountReceived, amountReceivedNet, amountSpent, amountSpentNet]
            filters: { mainAccount: { eq: { slug: $accountSlug } } }
          }
        ) {
          rows {
            values {
              amountReceived { valueInCents }
              amountReceivedNet { valueInCents }
              amountSpent { valueInCents }
              amountSpentNet { valueInCents }
            }
          }
        }
      }
    }
  }
`;

const STATS_QUERY = `
  query AccountStatsParity($slug: String!) {
    account(slug: $slug) {
      id
      stats {
        totalAmountReceived(includeChildren: true) { valueInCents }
        totalAmountReceivedNet: totalAmountReceived(net: true, includeChildren: true) { valueInCents }
        totalAmountSpent(includeChildren: true) { valueInCents }
        totalAmountSpentNet: totalAmountSpent(net: true, includeChildren: true) { valueInCents }
      }
    }
  }
`;

describe('server/lib/metrics/graphql/host-metrics', () => {
  let host, hostAdmin, nonAdmin, collective, event;
  const DATE_FROM = '2000-01-01T00:00:00.000Z';
  const DATE_TO = '2026-12-31T23:59:59.000Z';

  before(async () => {
    await resetTestDB();
    host = await fakeActiveHost({ slug: 'metrics-gql-host', currency: 'USD' });
    hostAdmin = await fakeUser();
    nonAdmin = await fakeUser();
    await host.addUserWithRole(hostAdmin, roles.ADMIN);

    collective = await fakeCollective({
      HostCollectiveId: host.id,
      type: CollectiveType.COLLECTIVE,
      approvedAt: new Date('2025-01-01'),
      currency: 'USD',
    });
    event = await fakeEvent({ ParentCollectiveId: collective.id });

    // Parent contribution.
    await fakeTransaction(
      {
        type: TransactionTypes.CREDIT,
        kind: TransactionKind.CONTRIBUTION,
        CollectiveId: collective.id,
        HostCollectiveId: host.id,
        amount: 300_00,
        createdAt: new Date('2025-06-15'),
      },
      { createDoubleEntry: true },
    );
    // Child-event contribution (rolls up under mainAccount = collective).
    await fakeTransaction(
      {
        type: TransactionTypes.CREDIT,
        kind: TransactionKind.CONTRIBUTION,
        CollectiveId: event.id,
        HostCollectiveId: host.id,
        amount: 75_00,
        createdAt: new Date('2025-07-10'),
      },
      { createDoubleEntry: true },
    );
    // Parent expense (payout).
    await fakeTransaction(
      {
        type: TransactionTypes.DEBIT,
        kind: TransactionKind.EXPENSE,
        CollectiveId: collective.id,
        HostCollectiveId: host.id,
        amount: -120_00,
        createdAt: new Date('2025-08-20'),
      },
      { createDoubleEntry: true },
    );

    await sequelize.query(`REFRESH MATERIALIZED VIEW "HostedCollectivesDailyFinancialActivity"`);
  });

  it('metrics (mainAccount, consolidated) matches account.stats (includeChildren: true)', async () => {
    const metricsResult = await graphqlQueryV2(
      METRICS_QUERY,
      { slug: host.slug, accountSlug: collective.slug, from: DATE_FROM, to: DATE_TO },
      hostAdmin,
    );
    expect(metricsResult.errors).to.not.exist;
    const values = metricsResult.data.host.metrics.hostedCollectivesFinancialActivity.rows[0].values;

    const statsResult = await graphqlQueryV2(STATS_QUERY, { slug: collective.slug }, hostAdmin);
    expect(statsResult.errors).to.not.exist;
    const stats = statsResult.data.account.stats;

    const abs = (v: number | null | undefined) => Math.abs(v ?? 0);
    expect(abs(values.amountReceived.valueInCents)).to.equal(abs(stats.totalAmountReceived.valueInCents));
    expect(abs(values.amountReceivedNet.valueInCents)).to.equal(abs(stats.totalAmountReceivedNet.valueInCents));
    expect(abs(values.amountSpent.valueInCents)).to.equal(abs(stats.totalAmountSpent.valueInCents));
    expect(abs(values.amountSpentNet.valueInCents)).to.equal(abs(stats.totalAmountSpentNet.valueInCents));

    // Consolidated received rolls the child event up under the parent (300 + 75).
    expect(abs(values.amountReceived.valueInCents)).to.equal(375_00);
  });

  it('returns metrics = null for a non-admin caller', async () => {
    const result = await graphqlQueryV2(
      METRICS_QUERY,
      { slug: host.slug, accountSlug: collective.slug, from: DATE_FROM, to: DATE_TO },
      nonAdmin,
    );
    expect(result.errors).to.not.exist;
    expect(result.data.host.metrics).to.be.null;
  });

  it('returns metrics = null for an anonymous caller', async () => {
    const result = await graphqlQueryV2(METRICS_QUERY, {
      slug: host.slug,
      accountSlug: collective.slug,
      from: DATE_FROM,
      to: DATE_TO,
    });
    expect(result.errors).to.not.exist;
    expect(result.data.host.metrics).to.be.null;
  });
});
