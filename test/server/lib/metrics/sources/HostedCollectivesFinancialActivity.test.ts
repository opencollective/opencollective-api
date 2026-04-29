import { expect } from 'chai';

import { CollectiveType } from '../../../../../server/constants/collectives';
import { TransactionKind } from '../../../../../server/constants/transaction-kind';
import { TransactionTypes } from '../../../../../server/constants/transactions';
import { queryMetrics } from '../../../../../server/lib/metrics';
import { HostedCollectivesFinancialActivity } from '../../../../../server/lib/metrics/sources';
import { sequelize } from '../../../../../server/models';
import { fakeActiveHost, fakeCollective, fakeEvent, fakeTransaction } from '../../../../test-helpers/fake-data';
import { resetTestDB } from '../../../../utils';

describe('server/lib/metrics/sources/HostedCollectivesFinancialActivity', () => {
  let host: Awaited<ReturnType<typeof fakeActiveHost>>;
  let otherHost: Awaited<ReturnType<typeof fakeActiveHost>>;
  let collective: Awaited<ReturnType<typeof fakeCollective>>;
  let fund: Awaited<ReturnType<typeof fakeCollective>>;
  let event: Awaited<ReturnType<typeof fakeEvent>>;
  let otherCollective: Awaited<ReturnType<typeof fakeCollective>>;
  let otherCollectiveB: Awaited<ReturnType<typeof fakeCollective>>;

  const refreshMV = () => sequelize.query(`REFRESH MATERIALIZED VIEW "HostedCollectivesDailyFinancialActivity"`);

  before(async () => {
    await resetTestDB();
    host = await fakeActiveHost({ slug: 'metrics-fa-host' });
    otherHost = await fakeActiveHost({ slug: 'metrics-fa-other-host' });

    collective = await fakeCollective({
      HostCollectiveId: host.id,
      type: CollectiveType.COLLECTIVE,
      approvedAt: new Date('2025-01-01'),
      currency: 'USD',
    });
    fund = await fakeCollective({
      HostCollectiveId: host.id,
      type: CollectiveType.FUND,
      approvedAt: new Date('2025-01-01'),
      currency: 'USD',
    });
    event = await fakeEvent({ ParentCollectiveId: collective.id });

    // --- Income on the parent collective (June + July) ---
    await fakeTransaction(
      {
        type: TransactionTypes.CREDIT,
        kind: TransactionKind.CONTRIBUTION,
        CollectiveId: collective.id,
        HostCollectiveId: host.id,
        amount: 100_00,
        createdAt: new Date('2025-06-15'),
      },
      { createDoubleEntry: true },
    );
    await fakeTransaction(
      {
        type: TransactionTypes.CREDIT,
        kind: TransactionKind.CONTRIBUTION,
        CollectiveId: collective.id,
        HostCollectiveId: host.id,
        amount: 200_00,
        createdAt: new Date('2025-07-10'),
      },
      { createDoubleEntry: true },
    );

    // --- Spending on the parent collective (July) ---
    await fakeTransaction(
      {
        type: TransactionTypes.DEBIT,
        kind: TransactionKind.EXPENSE,
        CollectiveId: collective.id,
        HostCollectiveId: host.id,
        amount: -50_00,
        createdAt: new Date('2025-07-20'),
      },
      { createDoubleEntry: true },
    );

    // --- Income on the child event (August) — should roll up to the parent for activeCollectives ---
    await fakeTransaction(
      {
        type: TransactionTypes.CREDIT,
        kind: TransactionKind.CONTRIBUTION,
        CollectiveId: event.id,
        HostCollectiveId: host.id,
        amount: 75_00,
        createdAt: new Date('2025-08-05'),
      },
      { createDoubleEntry: true },
    );

    // --- Income on the fund (September) ---
    await fakeTransaction(
      {
        type: TransactionTypes.CREDIT,
        kind: TransactionKind.CONTRIBUTION,
        CollectiveId: fund.id,
        HostCollectiveId: host.id,
        amount: 500_00,
        createdAt: new Date('2025-09-12'),
      },
      { createDoubleEntry: true },
    );

    // --- Self-host transaction (host paying itself) — must be excluded by the MV ---
    await fakeTransaction(
      {
        type: TransactionTypes.CREDIT,
        kind: TransactionKind.CONTRIBUTION,
        CollectiveId: host.id,
        HostCollectiveId: host.id,
        amount: 999_00,
        createdAt: new Date('2025-06-01'),
      },
      { createDoubleEntry: true },
    );

    // --- Activity on a different host's collectives — must not appear under our host ---
    // Two collectives, contributions in different months, plus an expense, so the
    // host filter is genuinely exercised: queries scoped to `otherHost` see this
    // activity and our host's queries never do.
    otherCollective = await fakeCollective({ HostCollectiveId: otherHost.id, currency: 'USD' });
    otherCollectiveB = await fakeCollective({ HostCollectiveId: otherHost.id, currency: 'USD' });
    await fakeTransaction(
      {
        type: TransactionTypes.CREDIT,
        kind: TransactionKind.CONTRIBUTION,
        CollectiveId: otherCollective.id,
        HostCollectiveId: otherHost.id,
        amount: 400_00,
        createdAt: new Date('2025-06-05'),
      },
      { createDoubleEntry: true },
    );
    await fakeTransaction(
      {
        type: TransactionTypes.CREDIT,
        kind: TransactionKind.CONTRIBUTION,
        CollectiveId: otherCollectiveB.id,
        HostCollectiveId: otherHost.id,
        amount: 600_00,
        createdAt: new Date('2025-07-05'),
      },
      { createDoubleEntry: true },
    );
    await fakeTransaction(
      {
        type: TransactionTypes.DEBIT,
        kind: TransactionKind.EXPENSE,
        CollectiveId: otherCollectiveB.id,
        HostCollectiveId: otherHost.id,
        amount: -150_00,
        createdAt: new Date('2025-08-10'),
      },
      { createDoubleEntry: true },
    );

    await refreshMV();
  });

  describe('measures', () => {
    it('sums incomeAmount from CONTRIBUTION credits', async () => {
      const result = await queryMetrics({
        source: HostedCollectivesFinancialActivity,
        measures: ['incomeAmount'],
        dateFrom: '2025-01-01',
        dateTo: '2026-01-01',
        filters: { host: host.id },
      });
      // 100 + 200 + 75 (event) + 500 (fund) = 875_00
      expect(result.rows[0].values.incomeAmount).to.equal(875_00);
    });

    it('sums spendingAmount from EXPENSE debits', async () => {
      const result = await queryMetrics({
        source: HostedCollectivesFinancialActivity,
        measures: ['spendingAmount'],
        dateFrom: '2025-01-01',
        dateTo: '2026-01-01',
        filters: { host: host.id },
      });
      expect(result.rows[0].values.spendingAmount).to.equal(50_00);
    });

    it('counts transactions with transactionCount', async () => {
      const result = await queryMetrics({
        source: HostedCollectivesFinancialActivity,
        measures: ['transactionCount'],
        dateFrom: '2025-01-01',
        dateTo: '2026-01-01',
        filters: { host: host.id },
      });
      // 5 transactions on host's collectives (collective: 2 income + 1 expense; event: 1; fund: 1).
      // Self-host and other-host transactions are filtered out by the MV.
      expect(result.rows[0].values.transactionCount).to.equal(5);
    });

    it('counts activeCollectives with parent rollup (event counted under parent collective)', async () => {
      const result = await queryMetrics({
        source: HostedCollectivesFinancialActivity,
        measures: ['activeCollectives'],
        dateFrom: '2025-01-01',
        dateTo: '2026-01-01',
        filters: { host: host.id },
      });
      // collective + fund = 2 distinct main accounts (event rolls up to collective).
      expect(result.rows[0].values.activeCollectives).to.equal(2);
    });

    it('computes daysSinceLastActivity per collective', async () => {
      const result = await queryMetrics({
        source: HostedCollectivesFinancialActivity,
        measures: ['daysSinceLastActivity'],
        dateFrom: '2025-01-01',
        dateTo: '2026-01-01',
        filters: { host: host.id },
        groupBy: ['account'],
        limit: 100,
      });
      const byCollectiveId = new Map(
        result.rows.map(r => [r.group?.account as number, r.values.daysSinceLastActivity]),
      );
      // Most recent fund transaction was 2025-09-12; collective's was 2025-07-20; event's was 2025-08-05.
      // Fund's days-since should be smaller (more recent) than the collective's.
      expect(byCollectiveId.get(fund.id)).to.be.lessThan(byCollectiveId.get(collective.id) as number);
    });
  });

  describe('dimensions and filters', () => {
    it('groups by accountType', async () => {
      const result = await queryMetrics({
        source: HostedCollectivesFinancialActivity,
        measures: ['incomeAmount'],
        dateFrom: '2025-01-01',
        dateTo: '2026-01-01',
        filters: { host: host.id },
        groupBy: ['accountType'],
        limit: 100,
      });
      const byType = new Map(result.rows.map(r => [r.group?.accountType, r.values.incomeAmount]));
      expect(byType.get('FUND')).to.equal(500_00);
      // collective itself = 100+200, event under it = 75
      expect(byType.get('COLLECTIVE')).to.equal(300_00);
      expect(byType.get('EVENT')).to.equal(75_00);
    });

    it('filters by accountType', async () => {
      const result = await queryMetrics({
        source: HostedCollectivesFinancialActivity,
        measures: ['incomeAmount'],
        dateFrom: '2025-01-01',
        dateTo: '2026-01-01',
        filters: { host: host.id, accountType: ['FUND'] },
      });
      expect(result.rows[0].values.incomeAmount).to.equal(500_00);
    });

    it('filters by mainAccountType (rolls child events/projects up to their parent type)', async () => {
      // mainAccountType = parent's type when the row is a child, else self's type.
      // For our fixture: the event row's mainAccountType is COLLECTIVE (its parent's type),
      // so it counts toward "COLLECTIVE activity" even though its own accountType is EVENT.
      // Income: collective (100 + 200) + event (75) = 375. Fund excluded.
      const result = await queryMetrics({
        source: HostedCollectivesFinancialActivity,
        measures: ['incomeAmount'],
        dateFrom: '2025-01-01',
        dateTo: '2026-01-01',
        filters: { host: host.id, mainAccountType: ['COLLECTIVE'] },
      });
      expect(result.rows[0].values.incomeAmount).to.equal(375_00);
    });

    it('filters by mainAccount (rolls children up)', async () => {
      // Filter to the parent collective via mainAccount: should include both the
      // parent's own transactions (2 income + 1 expense) AND the child event's (1 income) = 4.
      // Income-side: 100 + 200 (parent) + 75 (event) = 375.
      const result = await queryMetrics({
        source: HostedCollectivesFinancialActivity,
        measures: ['incomeAmount', 'transactionCount'],
        dateFrom: '2025-01-01',
        dateTo: '2026-01-01',
        filters: { host: host.id, mainAccount: collective.id },
      });
      expect(result.rows[0].values.incomeAmount).to.equal(375_00);
      expect(result.rows[0].values.transactionCount).to.equal(4);
    });

    it('filters by parentCollectiveId (children only, no parent)', async () => {
      const result = await queryMetrics({
        source: HostedCollectivesFinancialActivity,
        measures: ['incomeAmount'],
        dateFrom: '2025-01-01',
        dateTo: '2026-01-01',
        filters: { host: host.id, parent: collective.id },
      });
      // Only the event's 75 (parent's own rows have parentId NULL).
      expect(result.rows[0].values.incomeAmount).to.equal(75_00);
    });

    it('filters by isMainAccount (excludes children)', async () => {
      const result = await queryMetrics({
        source: HostedCollectivesFinancialActivity,
        measures: ['incomeAmount'],
        dateFrom: '2025-01-01',
        dateTo: '2026-01-01',
        filters: { host: host.id, isMainAccount: true },
      });
      // collective (300) + fund (500) = 800. Event excluded.
      expect(result.rows[0].values.incomeAmount).to.equal(800_00);
    });
  });

  describe('bucketing', () => {
    it('buckets by month with DATE_TRUNC', async () => {
      const result = await queryMetrics({
        source: HostedCollectivesFinancialActivity,
        measures: ['transactionCount'],
        dateFrom: '2025-06-01',
        dateTo: '2025-10-01',
        filters: { host: host.id },
        bucket: 'month',
      });
      const byBucket = new Map(result.rows.map(r => [r.bucket, r.values.transactionCount]));
      expect(byBucket.get('2025-06-01')).to.equal(1); // 100
      expect(byBucket.get('2025-07-01')).to.equal(2); // 200 + 50 spend
      expect(byBucket.get('2025-08-01')).to.equal(1); // event 75
      expect(byBucket.get('2025-09-01')).to.equal(1); // fund 500
    });
  });

  describe('top-N', () => {
    it('returns top-N collectives by income', async () => {
      const result = await queryMetrics({
        source: HostedCollectivesFinancialActivity,
        measures: ['incomeAmount'],
        dateFrom: '2025-01-01',
        dateTo: '2026-01-01',
        filters: { host: host.id },
        groupBy: ['account'],
        orderBy: [{ measure: 'incomeAmount', direction: 'desc' }],
        limit: 2,
      });
      expect(result.rows).to.have.length(2);
      expect(result.rows[0].group?.account).to.equal(fund.id); // highest income
    });

    it('applies HAVING before top-N group selection', async () => {
      const result = await queryMetrics({
        source: HostedCollectivesFinancialActivity,
        measures: ['incomeAmount', 'spendingAmount'],
        dateFrom: '2025-01-01',
        dateTo: '2026-01-01',
        filters: { host: host.id },
        groupBy: ['account'],
        bucket: 'month',
        orderBy: [{ measure: 'incomeAmount', direction: 'desc' }],
        having: [{ measure: 'spendingAmount', op: 'gt', value: 0 }],
        limit: 1,
      });
      const accounts = new Set(result.rows.map(r => r.group?.account));
      expect(accounts.size).to.equal(1);
      expect([...accounts]).to.deep.equal([collective.id]);
    });
  });

  describe('exclusions', () => {
    it('does not include the host self as a hosted collective', async () => {
      const result = await queryMetrics({
        source: HostedCollectivesFinancialActivity,
        measures: ['incomeAmount'],
        dateFrom: '2025-01-01',
        dateTo: '2026-01-01',
        filters: { host: host.id, account: host.id },
      });
      const value = result.rows[0]?.values.incomeAmount ?? 0;
      expect(value).to.equal(0);
    });

    it('scopes by hostCollectiveId — other-host activity is invisible', async () => {
      const result = await queryMetrics({
        source: HostedCollectivesFinancialActivity,
        measures: ['incomeAmount'],
        dateFrom: '2025-01-01',
        dateTo: '2026-01-01',
        filters: { host: host.id },
      });
      expect(result.rows[0].values.incomeAmount).to.equal(875_00);
    });

    it('returns the other host`s activity when scoped to it (filter actually switches scope)', async () => {
      const result = await queryMetrics({
        source: HostedCollectivesFinancialActivity,
        measures: ['incomeAmount', 'spendingAmount', 'transactionCount', 'activeCollectives'],
        dateFrom: '2025-01-01',
        dateTo: '2026-01-01',
        filters: { host: otherHost.id },
      });
      // otherHost: 400 + 600 = 1000 income, 150 spending, 3 transactions, 2 active collectives.
      expect(result.rows[0].values.incomeAmount).to.equal(1000_00);
      expect(result.rows[0].values.spendingAmount).to.equal(150_00);
      expect(result.rows[0].values.transactionCount).to.equal(3);
      expect(result.rows[0].values.activeCollectives).to.equal(2);
    });
  });
});
