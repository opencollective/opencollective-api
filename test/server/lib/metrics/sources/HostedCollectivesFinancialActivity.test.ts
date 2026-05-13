import { expect } from 'chai';

import { CollectiveType } from '../../../../../server/constants/collectives';
import { TransactionKind } from '../../../../../server/constants/transaction-kind';
import { TransactionTypes } from '../../../../../server/constants/transactions';
import { getSumCollectivesAmountReceived, getSumCollectivesAmountSpent } from '../../../../../server/lib/budget';
import { queryMetrics } from '../../../../../server/lib/metrics';
import { HostedCollectivesFinancialActivity } from '../../../../../server/lib/metrics/sources';
import { sequelize } from '../../../../../server/models';
import { fakeActiveHost, fakeCollective, fakeEvent, fakeTransaction } from '../../../../test-helpers/fake-data';
import { resetTestDB } from '../../../../utils';

describe('server/lib/metrics/sources/HostedCollectivesFinancialActivity', () => {
  let host: Awaited<ReturnType<typeof fakeActiveHost>>;
  let otherHost: Awaited<ReturnType<typeof fakeActiveHost>>;
  let archivedHost: Awaited<ReturnType<typeof fakeActiveHost>>;
  let collective: Awaited<ReturnType<typeof fakeCollective>>;
  let fund: Awaited<ReturnType<typeof fakeCollective>>;
  let event: Awaited<ReturnType<typeof fakeEvent>>;
  let otherCollective: Awaited<ReturnType<typeof fakeCollective>>;
  let otherCollectiveB: Awaited<ReturnType<typeof fakeCollective>>;
  let archivedCollective: Awaited<ReturnType<typeof fakeCollective>>;
  let archivedParent: Awaited<ReturnType<typeof fakeCollective>>;
  let archivedParentEvent: Awaited<ReturnType<typeof fakeEvent>>;

  const refreshMV = () => sequelize.query(`REFRESH MATERIALIZED VIEW "HostedCollectivesDailyFinancialActivity"`);

  before(async () => {
    await resetTestDB();
    host = await fakeActiveHost({ slug: 'metrics-fa-host' });
    otherHost = await fakeActiveHost({ slug: 'metrics-fa-other-host' });
    archivedHost = await fakeActiveHost({ slug: 'metrics-fa-archived-host' });

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

    const refunded = await fakeTransaction(
      {
        type: TransactionTypes.CREDIT,
        kind: TransactionKind.CONTRIBUTION,
        CollectiveId: collective.id,
        HostCollectiveId: host.id,
        amount: 99_00,
        createdAt: new Date('2025-06-25'),
      },
      { createDoubleEntry: true },
    );
    const refund = await fakeTransaction(
      {
        type: TransactionTypes.DEBIT,
        kind: TransactionKind.CONTRIBUTION,
        CollectiveId: collective.id,
        HostCollectiveId: host.id,
        amount: -99_00,
        createdAt: new Date('2025-06-26'),
        isRefund: true,
      },
      { createDoubleEntry: true },
    );
    await refunded.update({ RefundTransactionId: refund.id });

    await fakeTransaction(
      {
        type: TransactionTypes.CREDIT,
        kind: TransactionKind.CONTRIBUTION,
        CollectiveId: collective.id,
        HostCollectiveId: host.id,
        amount: 77_00,
        createdAt: new Date('2025-06-27'),
        isInternal: true,
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

    archivedCollective = await fakeCollective({
      HostCollectiveId: archivedHost.id,
      type: CollectiveType.COLLECTIVE,
      approvedAt: new Date('2025-01-01'),
      deactivatedAt: new Date('2025-08-01'),
      currency: 'USD',
    });
    archivedParent = await fakeCollective({
      HostCollectiveId: archivedHost.id,
      type: CollectiveType.COLLECTIVE,
      approvedAt: new Date('2025-01-01'),
      deactivatedAt: new Date('2025-08-01'),
      currency: 'USD',
    });
    archivedParentEvent = await fakeEvent({ ParentCollectiveId: archivedParent.id });

    await fakeTransaction(
      {
        type: TransactionTypes.CREDIT,
        kind: TransactionKind.CONTRIBUTION,
        CollectiveId: archivedCollective.id,
        HostCollectiveId: archivedHost.id,
        amount: 250_00,
        createdAt: new Date('2025-07-15'),
      },
      { createDoubleEntry: true },
    );

    await fakeTransaction(
      {
        type: TransactionTypes.CREDIT,
        kind: TransactionKind.CONTRIBUTION,
        CollectiveId: archivedCollective.id,
        HostCollectiveId: archivedHost.id,
        amount: 33_00,
        createdAt: new Date('2025-09-15'),
      },
      { createDoubleEntry: true },
    );

    await fakeTransaction(
      {
        type: TransactionTypes.CREDIT,
        kind: TransactionKind.CONTRIBUTION,
        CollectiveId: archivedParentEvent.id,
        HostCollectiveId: archivedHost.id,
        amount: 44_00,
        createdAt: new Date('2025-09-20'),
      },
      { createDoubleEntry: true },
    );

    await refreshMV();
  });

  describe('measures', () => {
    it('sums amountReceived from CREDIT contributions', async () => {
      const result = await queryMetrics({
        source: HostedCollectivesFinancialActivity,
        measures: ['amountReceived'],
        dateFrom: '2025-01-01',
        dateTo: '2026-01-01',
        filters: { host: host.id },
      });
      // 100 + 200 + 75 (event) + 500 (fund) = 875_00
      expect(result.rows[0].values.amountReceived).to.equal(875_00);
    });

    it('sums amountSpent from EXPENSE debits as a positive number', async () => {
      const result = await queryMetrics({
        source: HostedCollectivesFinancialActivity,
        measures: ['amountSpent'],
        dateFrom: '2025-01-01',
        dateTo: '2026-01-01',
        filters: { host: host.id },
      });
      expect(result.rows[0].values.amountSpent).to.equal(50_00);
    });

    it('counts transactions with transactionCount (refund + internal rows count, amounts do not)', async () => {
      const result = await queryMetrics({
        source: HostedCollectivesFinancialActivity,
        measures: ['transactionCount'],
        dateFrom: '2025-01-01',
        dateTo: '2026-01-01',
        filters: { host: host.id },
      });
      expect(result.rows[0].values.transactionCount).to.equal(8);
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

    it('returns lastActiveDate (most recent activity) per collective', async () => {
      const result = await queryMetrics({
        source: HostedCollectivesFinancialActivity,
        measures: ['lastActiveDate'],
        dateFrom: '2025-01-01',
        dateTo: '2026-01-01',
        filters: { host: host.id },
        groupBy: ['account'],
        limit: 100,
      });
      const byCollectiveId = new Map(result.rows.map(r => [r.group?.account as number, r.values.lastActiveDate]));
      // Most recent fund transaction was 2025-09-12; collective's was 2025-07-20.
      expect(byCollectiveId.get(fund.id)).to.equal('2025-09-12');
      expect(byCollectiveId.get(collective.id)).to.equal('2025-07-20');
    });
  });

  describe('dimensions and filters', () => {
    it('groups by accountType', async () => {
      const result = await queryMetrics({
        source: HostedCollectivesFinancialActivity,
        measures: ['amountReceived'],
        dateFrom: '2025-01-01',
        dateTo: '2026-01-01',
        filters: { host: host.id },
        groupBy: ['accountType'],
        limit: 100,
      });
      const byType = new Map(result.rows.map(r => [r.group?.accountType, r.values.amountReceived]));
      expect(byType.get('FUND')).to.equal(500_00);
      // collective itself = 100+200, event under it = 75
      expect(byType.get('COLLECTIVE')).to.equal(300_00);
      expect(byType.get('EVENT')).to.equal(75_00);
    });

    it('filters by accountType', async () => {
      const result = await queryMetrics({
        source: HostedCollectivesFinancialActivity,
        measures: ['amountReceived'],
        dateFrom: '2025-01-01',
        dateTo: '2026-01-01',
        filters: { host: host.id, accountType: ['FUND'] },
      });
      expect(result.rows[0].values.amountReceived).to.equal(500_00);
    });

    it('filters by mainAccountType (rolls child events/projects up to their parent type)', async () => {
      // mainAccountType = parent's type when the row is a child, else self's type.
      // For our fixture: the event row's mainAccountType is COLLECTIVE (its parent's type),
      // so it counts toward "COLLECTIVE activity" even though its own accountType is EVENT.
      // Income: collective (100 + 200) + event (75) = 375. Fund excluded.
      const result = await queryMetrics({
        source: HostedCollectivesFinancialActivity,
        measures: ['amountReceived'],
        dateFrom: '2025-01-01',
        dateTo: '2026-01-01',
        filters: { host: host.id, mainAccountType: ['COLLECTIVE'] },
      });
      expect(result.rows[0].values.amountReceived).to.equal(375_00);
    });

    it('filters by mainAccount (rolls children up)', async () => {
      const result = await queryMetrics({
        source: HostedCollectivesFinancialActivity,
        measures: ['amountReceived', 'transactionCount'],
        dateFrom: '2025-01-01',
        dateTo: '2026-01-01',
        filters: { host: host.id, mainAccount: collective.id },
      });
      expect(result.rows[0].values.amountReceived).to.equal(375_00);
      expect(result.rows[0].values.transactionCount).to.equal(7);
    });

    it('filters by parentCollectiveId (children only, no parent)', async () => {
      const result = await queryMetrics({
        source: HostedCollectivesFinancialActivity,
        measures: ['amountReceived'],
        dateFrom: '2025-01-01',
        dateTo: '2026-01-01',
        filters: { host: host.id, parent: collective.id },
      });
      // Only the event's 75 (parent's own rows have parentId NULL).
      expect(result.rows[0].values.amountReceived).to.equal(75_00);
    });

    it('filters by isMainAccount (excludes children)', async () => {
      const result = await queryMetrics({
        source: HostedCollectivesFinancialActivity,
        measures: ['amountReceived'],
        dateFrom: '2025-01-01',
        dateTo: '2026-01-01',
        filters: { host: host.id, isMainAccount: true },
      });
      // collective (300) + fund (500) = 800. Event excluded.
      expect(result.rows[0].values.amountReceived).to.equal(800_00);
    });
  });

  describe('archived', () => {
    it('isArchived is time-aware: pre-archival rows keep isArchived=false (per-row, not parent rollup)', async () => {
      const result = await queryMetrics({
        source: HostedCollectivesFinancialActivity,
        measures: ['amountReceived'],
        dateFrom: '2025-01-01',
        dateTo: '2026-01-01',
        filters: { host: archivedHost.id, isArchived: false },
      });
      expect(result.rows[0].values.amountReceived).to.equal(294_00);
    });

    it('isArchived=true returns only post-archival activity', async () => {
      const result = await queryMetrics({
        source: HostedCollectivesFinancialActivity,
        measures: ['amountReceived'],
        dateFrom: '2025-01-01',
        dateTo: '2026-01-01',
        filters: { host: archivedHost.id, isArchived: true },
      });
      expect(result.rows[0].values.amountReceived).to.equal(33_00);
    });

    it('mainAccountIsArchived=true catches child activity under archived parents', async () => {
      const result = await queryMetrics({
        source: HostedCollectivesFinancialActivity,
        measures: ['amountReceived'],
        dateFrom: '2025-01-01',
        dateTo: '2026-01-01',
        filters: { host: archivedHost.id, mainAccountIsArchived: true },
      });
      expect(result.rows[0].values.amountReceived).to.equal(77_00);
    });

    it('mainAccountIsArchived=false excludes child activity under archived parents', async () => {
      const result = await queryMetrics({
        source: HostedCollectivesFinancialActivity,
        measures: ['amountReceived'],
        dateFrom: '2025-01-01',
        dateTo: '2026-01-01',
        filters: { host: archivedHost.id, mainAccountIsArchived: false },
      });
      expect(result.rows[0].values.amountReceived).to.equal(250_00);
    });

    it('archived flag does not retroactively shift a date range fully before archival', async () => {
      const result = await queryMetrics({
        source: HostedCollectivesFinancialActivity,
        measures: ['amountReceived', 'transactionCount'],
        dateFrom: '2025-01-01',
        dateTo: '2025-08-01', // up to (but not including) 2025-08-01
        filters: { host: archivedHost.id, mainAccountIsArchived: false },
      });
      expect(result.rows[0].values.amountReceived).to.equal(250_00);
      expect(result.rows[0].values.transactionCount).to.equal(1);
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
      // June: 100 contribution + refund pair (2) + internal (1) = 4. Counts include refund/internal rows.
      expect(byBucket.get('2025-06-01')).to.equal(4);
      expect(byBucket.get('2025-07-01')).to.equal(2); // 200 + 50 spend
      expect(byBucket.get('2025-08-01')).to.equal(1); // event 75
      expect(byBucket.get('2025-09-01')).to.equal(1); // fund 500
    });
  });

  describe('top-N', () => {
    it('returns top-N collectives by income', async () => {
      const result = await queryMetrics({
        source: HostedCollectivesFinancialActivity,
        measures: ['amountReceived'],
        dateFrom: '2025-01-01',
        dateTo: '2026-01-01',
        filters: { host: host.id },
        groupBy: ['account'],
        orderBy: [{ measure: 'amountReceived', direction: 'desc' }],
        limit: 2,
      });
      expect(result.rows).to.have.length(2);
      expect(result.rows[0].group?.account).to.equal(fund.id); // highest income
    });

    it('applies HAVING before top-N group selection', async () => {
      const result = await queryMetrics({
        source: HostedCollectivesFinancialActivity,
        measures: ['amountReceived', 'amountSpent'],
        dateFrom: '2025-01-01',
        dateTo: '2026-01-01',
        filters: { host: host.id },
        groupBy: ['account'],
        bucket: 'month',
        orderBy: [{ measure: 'amountReceived', direction: 'desc' }],
        having: [{ measure: 'amountSpent', op: 'gt', value: 0 }],
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
        measures: ['amountReceived'],
        dateFrom: '2025-01-01',
        dateTo: '2026-01-01',
        filters: { host: host.id, account: host.id },
      });
      const value = result.rows[0]?.values.amountReceived ?? 0;
      expect(value).to.equal(0);
    });

    it('amount measures drop refund + internal rows; counts retain them', async () => {
      const result = await queryMetrics({
        source: HostedCollectivesFinancialActivity,
        measures: ['amountReceived', 'transactionCount'],
        dateFrom: '2025-06-25',
        dateTo: '2025-06-28',
        filters: { host: host.id, account: collective.id },
      });
      expect(result.rows[0]?.values.amountReceived ?? 0).to.equal(0);
      // Refund CREDIT + refund DEBIT + internal CREDIT = 3 rows
      expect(result.rows[0]?.values.transactionCount ?? 0).to.equal(3);
    });

    it('scopes by hostCollectiveId — other-host activity is invisible', async () => {
      const result = await queryMetrics({
        source: HostedCollectivesFinancialActivity,
        measures: ['amountReceived'],
        dateFrom: '2025-01-01',
        dateTo: '2026-01-01',
        filters: { host: host.id },
      });
      expect(result.rows[0].values.amountReceived).to.equal(875_00);
    });

    it('returns the other host`s activity when scoped to it (filter actually switches scope)', async () => {
      const result = await queryMetrics({
        source: HostedCollectivesFinancialActivity,
        measures: ['amountReceived', 'amountSpent', 'transactionCount', 'activeCollectives'],
        dateFrom: '2025-01-01',
        dateTo: '2026-01-01',
        filters: { host: otherHost.id },
      });
      // otherHost: 400 + 600 = 1000 income, 150 spending, 3 transactions, 2 active collectives.
      expect(result.rows[0].values.amountReceived).to.equal(1000_00);
      expect(result.rows[0].values.amountSpent).to.equal(150_00);
      expect(result.rows[0].values.transactionCount).to.equal(3);
      expect(result.rows[0].values.activeCollectives).to.equal(2);
    });
  });

  describe('hostStats parity', () => {
    const dateFrom = new Date('2025-01-01');
    const dateTo = new Date('2026-01-01');

    type AmountMeasure = 'amountReceived' | 'amountReceivedNet' | 'amountSpent' | 'amountSpentNet';

    type HostStatsFn = typeof getSumCollectivesAmountReceived;
    type HostStatsSums = Record<string, { value: number }>;

    const queryMetric = async (measure: AmountMeasure, extraFilters: Record<string, number> = {}) => {
      const result = await queryMetrics({
        source: HostedCollectivesFinancialActivity,
        measures: [measure],
        dateFrom,
        dateTo,
        filters: { host: host.id, ...extraFilters },
      });
      const value = result.rows[0]?.values[measure];
      return typeof value === 'number' ? value : 0;
    };

    const sumHostStatsTotal = (sums: HostStatsSums) => Object.values(sums).reduce((acc, v) => acc + (v.value ?? 0), 0);

    const sumHostStatsForHostedCollectives = async (fn: HostStatsFn, net: boolean) => {
      const hosted = await host.getHostedCollectives({ attributes: ['id'] });
      const ids = hosted.map(c => c.id).filter(id => id !== host.id);
      const sums = (await fn(ids, {
        net,
        startDate: dateFrom,
        endDate: dateTo,
        // bypass the cached fast-path so date filters apply
        useMaterializedView: false,
      })) as HostStatsSums;
      return sumHostStatsTotal(sums);
    };

    const sumHostStatsForCollective = async (fn: HostStatsFn, collectiveId: number, net: boolean) => {
      const sums = (await fn([collectiveId], {
        net,
        startDate: dateFrom,
        endDate: dateTo,
        useMaterializedView: false,
      })) as HostStatsSums;
      return sumHostStatsTotal(sums);
    };

    describe('host-wide (sum over all hosted collectives)', () => {
      it('amountReceived matches getSumCollectivesAmountReceived(net: false)', async () => {
        const metric = await queryMetric('amountReceived');
        const hostStatsTotal = await sumHostStatsForHostedCollectives(getSumCollectivesAmountReceived, false);
        expect(metric).to.be.greaterThan(0);
        expect(Math.abs(metric)).to.equal(Math.abs(hostStatsTotal));
      });

      it('amountReceivedNet matches getSumCollectivesAmountReceived(net: true)', async () => {
        const metric = await queryMetric('amountReceivedNet');
        const hostStatsTotal = await sumHostStatsForHostedCollectives(getSumCollectivesAmountReceived, true);
        expect(Math.abs(metric)).to.equal(Math.abs(hostStatsTotal));
      });

      it('amountSpent matches getSumCollectivesAmountSpent(net: false)', async () => {
        const metric = await queryMetric('amountSpent');
        const hostStatsTotal = await sumHostStatsForHostedCollectives(getSumCollectivesAmountSpent, false);
        expect(metric).to.be.greaterThan(0);
        expect(Math.abs(metric)).to.equal(Math.abs(hostStatsTotal));
      });

      it('amountSpentNet matches getSumCollectivesAmountSpent(net: true)', async () => {
        const metric = await queryMetric('amountSpentNet');
        const hostStatsTotal = await sumHostStatsForHostedCollectives(getSumCollectivesAmountSpent, true);
        expect(Math.abs(metric)).to.equal(Math.abs(hostStatsTotal));
      });
    });

    describe('single collective', () => {
      it('amountReceived matches hostStats for the single collective', async () => {
        const metric = await queryMetric('amountReceived', { account: collective.id });
        const hostStatsTotal = await sumHostStatsForCollective(getSumCollectivesAmountReceived, collective.id, false);
        expect(metric).to.equal(300_00);
        expect(Math.abs(metric)).to.equal(Math.abs(hostStatsTotal));
      });

      it('amountReceivedNet matches hostStats(net: true) for the single collective', async () => {
        const metric = await queryMetric('amountReceivedNet', { account: collective.id });
        const hostStatsTotal = await sumHostStatsForCollective(getSumCollectivesAmountReceived, collective.id, true);
        expect(Math.abs(metric)).to.equal(Math.abs(hostStatsTotal));
      });

      it('amountSpent matches hostStats for the single collective', async () => {
        const metric = await queryMetric('amountSpent', { account: collective.id });
        const hostStatsTotal = await sumHostStatsForCollective(getSumCollectivesAmountSpent, collective.id, false);
        expect(metric).to.equal(50_00);
        expect(Math.abs(metric)).to.equal(Math.abs(hostStatsTotal));
      });

      it('amountSpentNet matches hostStats(net: true) for the single collective', async () => {
        const metric = await queryMetric('amountSpentNet', { account: collective.id });
        const hostStatsTotal = await sumHostStatsForCollective(getSumCollectivesAmountSpent, collective.id, true);
        expect(Math.abs(metric)).to.equal(Math.abs(hostStatsTotal));
      });
    });
  });
});
