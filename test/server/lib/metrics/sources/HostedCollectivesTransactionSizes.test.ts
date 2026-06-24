import { expect } from 'chai';

import { CollectiveType } from '../../../../../server/constants/collectives';
import { TransactionKind } from '../../../../../server/constants/transaction-kind';
import { TransactionTypes } from '../../../../../server/constants/transactions';
import { queryMetrics } from '../../../../../server/lib/metrics';
import { HostedCollectivesTransactionSizes } from '../../../../../server/lib/metrics/sources';
import { AMOUNT_BAND_VALUES } from '../../../../../server/lib/metrics/sources/hosted-collectives-enum-values';
import { sequelize } from '../../../../../server/models';
import {
  fakeActiveHost,
  fakeCollective,
  fakeEvent,
  fakeOrder,
  fakeTransaction,
} from '../../../../test-helpers/fake-data';
import { resetTestDB } from '../../../../utils';

describe('server/lib/metrics/sources/HostedCollectivesTransactionSizes', () => {
  let host: Awaited<ReturnType<typeof fakeActiveHost>>;
  let collective: Awaited<ReturnType<typeof fakeCollective>>;
  let event: Awaited<ReturnType<typeof fakeEvent>>;

  const refreshMV = () => sequelize.query(`REFRESH MATERIALIZED VIEW "HostedCollectivesDailyTransactionSizes"`);

  const contribution = (amount: number, CollectiveId: number, createdAt = new Date('2025-06-15')) =>
    fakeTransaction(
      {
        type: TransactionTypes.CREDIT,
        kind: TransactionKind.CONTRIBUTION,
        CollectiveId,
        HostCollectiveId: host.id,
        amount,
        createdAt,
      },
      { createDoubleEntry: true },
    );

  const payout = (amount: number, CollectiveId: number, createdAt = new Date('2025-06-15')) =>
    fakeTransaction(
      {
        type: TransactionTypes.DEBIT,
        kind: TransactionKind.EXPENSE,
        CollectiveId,
        HostCollectiveId: host.id,
        amount: -Math.abs(amount),
        createdAt,
      },
      { createDoubleEntry: true },
    );

  before(async () => {
    await resetTestDB();
    host = await fakeActiveHost({ slug: 'metrics-sizes-host' });
    collective = await fakeCollective({
      HostCollectiveId: host.id,
      type: CollectiveType.COLLECTIVE,
      approvedAt: new Date('2025-01-01'),
      currency: 'USD',
    });
    event = await fakeEvent({ ParentCollectiveId: collective.id });

    // Contributions across bands: 3.00 -> GT_0_LTE_5; 30.00 + 30.00 -> GT_25_LTE_50.
    await contribution(3_00, collective.id);
    await contribution(30_00, collective.id);
    await contribution(30_00, collective.id);
    // Child event contribution (rolls up via mainAccount): 8.00 -> GT_5_LTE_10.
    await contribution(8_00, event.id);
    // Payout 200.00 -> GT_150_LTE_200 (bands are upper-inclusive).
    await payout(200_00, collective.id);

    // Refund pair + internal — excluded by the view WHERE.
    const refunded = await contribution(99_00, collective.id, new Date('2025-06-20'));
    const refund = await fakeTransaction(
      {
        type: TransactionTypes.DEBIT,
        kind: TransactionKind.CONTRIBUTION,
        CollectiveId: collective.id,
        HostCollectiveId: host.id,
        amount: -99_00,
        createdAt: new Date('2025-06-21'),
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
        createdAt: new Date('2025-06-22'),
        isInternal: true,
      },
      { createDoubleEntry: true },
    );

    await refreshMV();
  });

  const histogram = async (extraFilters = {}) => {
    const result = await queryMetrics({
      source: HostedCollectivesTransactionSizes,
      measures: ['transactionCount', 'amount'],
      dateFrom: '2025-01-01',
      dateTo: '2026-01-01',
      filters: { host: host.id, ...extraFilters },
      groupBy: ['amountBand', 'kindClass'],
      limit: 100,
    });
    return new Map(result.rows.map(r => [`${r.group?.kindClass}:${r.group?.amountBand}`, r.values]));
  };

  it('buckets contributions into front-weighted size bands (children roll up via mainAccount)', async () => {
    const byBand = await histogram({ mainAccount: collective.id });
    expect(byBand.get('CONTRIBUTION:GT_0_LTE_5')?.transactionCount).to.equal(1); // 3.00
    expect(byBand.get('CONTRIBUTION:GT_5_LTE_10')?.transactionCount).to.equal(1); // event 8.00
    expect(byBand.get('CONTRIBUTION:GT_25_LTE_50')?.transactionCount).to.equal(2); // 30 + 30
    expect(byBand.get('CONTRIBUTION:GT_25_LTE_50')?.amount).to.equal(60_00);
  });

  it('buckets payouts by absolute size under PAYOUT kindClass', async () => {
    const byBand = await histogram();
    expect(byBand.get('PAYOUT:GT_150_LTE_200')?.transactionCount).to.equal(1); // 200.00 (upper-inclusive)
    expect(byBand.get('PAYOUT:GT_150_LTE_200')?.amount).to.equal(200_00);
  });

  it('excludes refunds, refunded transactions and internal transfers', async () => {
    const byBand = await histogram();
    const totalContributions = Array.from(byBand.entries())
      .filter(([k]) => k.startsWith('CONTRIBUTION:'))
      .reduce((acc, [, v]) => acc + (v.transactionCount as number), 0);
    // Only the 4 clean contributions (3, 30, 30, event 8); refund/refunded/internal dropped.
    expect(totalContributions).to.equal(4);
  });

  it('scopes by host — other hosts are invisible', async () => {
    const otherHost = await fakeActiveHost({ slug: 'metrics-sizes-other' });
    const otherCollective = await fakeCollective({ HostCollectiveId: otherHost.id, currency: 'USD' });
    await fakeTransaction(
      {
        type: TransactionTypes.CREDIT,
        kind: TransactionKind.CONTRIBUTION,
        CollectiveId: otherCollective.id,
        HostCollectiveId: otherHost.id,
        amount: 5_00,
        createdAt: new Date('2025-06-15'),
      },
      { createDoubleEntry: true },
    );
    await refreshMV();

    const result = await queryMetrics({
      source: HostedCollectivesTransactionSizes,
      measures: ['transactionCount'],
      dateFrom: '2025-01-01',
      dateTo: '2026-01-01',
      filters: { host: host.id },
      groupBy: ['amountBand', 'kindClass'],
      limit: 100,
    });
    // Our host still only sees its own 5 clean transactions (4 contributions + 1 payout).
    const total = result.rows.reduce((acc, r) => acc + (r.values.transactionCount as number), 0);
    expect(total).to.equal(5);
  });

  describe('contributionFrequency dimension', () => {
    let freqHost: Awaited<ReturnType<typeof fakeActiveHost>>;
    let freqCollective: Awaited<ReturnType<typeof fakeCollective>>;

    before(async () => {
      freqHost = await fakeActiveHost({ slug: 'metrics-sizes-frequency-host', currency: 'USD' });
      freqCollective = await fakeCollective({ HostCollectiveId: freqHost.id, currency: 'USD' });

      // One-time contribution (no order) — 30.00 -> band GT_25_LTE_50.
      await fakeTransaction(
        {
          type: TransactionTypes.CREDIT,
          kind: TransactionKind.CONTRIBUTION,
          CollectiveId: freqCollective.id,
          HostCollectiveId: freqHost.id,
          amount: 30_00,
          createdAt: new Date('2025-06-15'),
        },
        { createDoubleEntry: true },
      );
      // Recurring contribution (monthly order) — 30.00 -> band GT_25_LTE_50.
      const order = await fakeOrder({ CollectiveId: freqCollective.id, interval: 'month' });
      await fakeTransaction(
        {
          type: TransactionTypes.CREDIT,
          kind: TransactionKind.CONTRIBUTION,
          CollectiveId: freqCollective.id,
          HostCollectiveId: freqHost.id,
          OrderId: order.id,
          amount: 30_00,
          createdAt: new Date('2025-06-16'),
        },
        { createDoubleEntry: true },
      );
      // Added funds — 200.00 -> band GT_150_LTE_200 (upper-inclusive).
      await fakeTransaction(
        {
          type: TransactionTypes.CREDIT,
          kind: TransactionKind.ADDED_FUNDS,
          CollectiveId: freqCollective.id,
          HostCollectiveId: freqHost.id,
          amount: 200_00,
          createdAt: new Date('2025-06-17'),
        },
        { createDoubleEntry: true },
      );
      await refreshMV();
    });

    it('splits the size histogram by frequency class', async () => {
      const result = await queryMetrics({
        source: HostedCollectivesTransactionSizes,
        measures: ['transactionCount', 'amount'],
        dateFrom: '2025-01-01',
        dateTo: '2026-01-01',
        filters: { host: freqHost.id, account: freqCollective.id },
        groupBy: ['contributionFrequency', 'amountBand'],
        limit: 100,
      });
      const byKey = new Map(
        result.rows.map(r => [`${r.group?.contributionFrequency}:${r.group?.amountBand}`, r.values]),
      );
      // Even though one-time and recurring land in the SAME size band (GT_25_LTE_50), the frequency
      // dimension keeps them as distinct rows.
      expect(byKey.get('ONE_TIME:GT_25_LTE_50')?.transactionCount).to.equal(1);
      expect(byKey.get('RECURRING:GT_25_LTE_50')?.transactionCount).to.equal(1);
      expect(byKey.get('ADDED_FUNDS:GT_150_LTE_200')?.transactionCount).to.equal(1);
      expect(byKey.get('ADDED_FUNDS:GT_150_LTE_200')?.amount).to.equal(200_00);
    });
  });

  describe('amountBand enum (filter + drift guard)', () => {
    let enumHost: Awaited<ReturnType<typeof fakeActiveHost>>;
    let enumCollective: Awaited<ReturnType<typeof fakeCollective>>;
    // One amount that lands in each band (the upper bound, since bands are upper-inclusive).
    const bandUpperBounds = [5, 10, 25, 50, 75, 100, 150, 200, 250, 500, 1000, 2000, 5000, 10000, 25000, 50000];

    before(async () => {
      enumHost = await fakeActiveHost({ slug: 'metrics-sizes-enum-host', currency: 'USD' });
      enumCollective = await fakeCollective({ HostCollectiveId: enumHost.id, currency: 'USD' });
      for (const dollars of [...bandUpperBounds, 60000 /* GT_50000 */]) {
        await fakeTransaction(
          {
            type: TransactionTypes.CREDIT,
            kind: TransactionKind.CONTRIBUTION,
            CollectiveId: enumCollective.id,
            HostCollectiveId: enumHost.id,
            amount: dollars * 100,
            createdAt: new Date('2025-06-15'),
          },
          { createDoubleEntry: true },
        );
      }
      await refreshMV();
    });

    it('emits exactly the declared enum tokens (SQL CASE ↔ declared values drift guard)', async () => {
      const result = await queryMetrics({
        source: HostedCollectivesTransactionSizes,
        measures: ['transactionCount'],
        dateFrom: '2025-01-01',
        dateTo: '2026-01-01',
        filters: { host: enumHost.id, account: enumCollective.id },
        groupBy: ['amountBand'],
        limit: 100,
      });
      const emitted = result.rows.map(r => r.group?.amountBand).sort();
      const declared = AMOUNT_BAND_VALUES.map(v => v.value).sort();
      expect(emitted).to.deep.equal(declared);
    });

    it('filters by amountBand enum tokens', async () => {
      const result = await queryMetrics({
        source: HostedCollectivesTransactionSizes,
        measures: ['transactionCount'],
        dateFrom: '2025-01-01',
        dateTo: '2026-01-01',
        filters: { host: enumHost.id, account: enumCollective.id, amountBand: ['GT_0_LTE_5', 'GT_50000'] },
        groupBy: ['amountBand'],
        limit: 100,
      });
      expect(result.rows.map(r => r.group?.amountBand).sort()).to.deep.equal(['GT_0_LTE_5', 'GT_50000']);
    });
  });
});
