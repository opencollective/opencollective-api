import { expect } from 'chai';

import { CollectiveType } from '../../../../../server/constants/collectives';
import { queryMetrics } from '../../../../../server/lib/metrics';
import { HostedCollectivesMembership } from '../../../../../server/lib/metrics/sources';
import { fakeActiveHost, fakeActivity, fakeCollective, fakeEvent } from '../../../../test-helpers/fake-data';
import { resetTestDB } from '../../../../utils';

describe('server/lib/metrics/sources/HostedCollectivesMembership', () => {
  let host: Awaited<ReturnType<typeof fakeActiveHost>>;
  let otherHost: Awaited<ReturnType<typeof fakeActiveHost>>;
  let collectiveA: Awaited<ReturnType<typeof fakeCollective>>;
  let collectiveB: Awaited<ReturnType<typeof fakeCollective>>;
  let fund: Awaited<ReturnType<typeof fakeCollective>>;
  let event: Awaited<ReturnType<typeof fakeEvent>>;

  before(async () => {
    await resetTestDB();
    host = await fakeActiveHost({ slug: 'metrics-mb-host' });
    otherHost = await fakeActiveHost({ slug: 'metrics-mb-other-host' });

    collectiveA = await fakeCollective({ HostCollectiveId: host.id, type: CollectiveType.COLLECTIVE });
    collectiveB = await fakeCollective({ HostCollectiveId: host.id, type: CollectiveType.COLLECTIVE });
    fund = await fakeCollective({ HostCollectiveId: host.id, type: CollectiveType.FUND });
    event = await fakeEvent({ ParentCollectiveId: collectiveA.id });

    // --- Joined events (collective.approved) ---
    await fakeActivity({
      type: 'collective.approved',
      CollectiveId: collectiveA.id,
      HostCollectiveId: host.id,
      createdAt: new Date('2025-03-10'),
    });
    await fakeActivity({
      type: 'collective.approved',
      CollectiveId: collectiveB.id,
      HostCollectiveId: host.id,
      createdAt: new Date('2025-04-15'),
    });
    await fakeActivity({
      type: 'collective.approved',
      CollectiveId: fund.id,
      HostCollectiveId: host.id,
      createdAt: new Date('2025-04-20'),
    });
    await fakeActivity({
      type: 'collective.approved',
      CollectiveId: collectiveA.id,
      HostCollectiveId: host.id,
      createdAt: new Date('2025-07-05'),
    });

    // --- Churned events (collective.unhosted) ---
    await fakeActivity({
      type: 'collective.unhosted',
      CollectiveId: collectiveB.id,
      HostCollectiveId: host.id,
      createdAt: new Date('2025-09-01'),
    });

    // --- Should be filtered out: event-typed activity (children excluded by view) ---
    await fakeActivity({
      type: 'collective.approved',
      CollectiveId: event.id,
      HostCollectiveId: host.id,
      createdAt: new Date('2025-04-12'),
    });
    // --- Should be filtered out: self-hosting ---
    await fakeActivity({
      type: 'collective.approved',
      CollectiveId: host.id,
      HostCollectiveId: host.id,
      createdAt: new Date('2025-01-01'),
    });
    // --- Different host — visible only when scoping to otherHost, never under our host ---
    // Two approvals + one churn, so the host filter is genuinely exercised.
    const otherCollectiveA = await fakeCollective({ HostCollectiveId: otherHost.id });
    const otherCollectiveB = await fakeCollective({ HostCollectiveId: otherHost.id });
    await fakeActivity({
      type: 'collective.approved',
      CollectiveId: otherCollectiveA.id,
      HostCollectiveId: otherHost.id,
      createdAt: new Date('2025-04-01'),
    });
    await fakeActivity({
      type: 'collective.approved',
      CollectiveId: otherCollectiveB.id,
      HostCollectiveId: otherHost.id,
      createdAt: new Date('2025-05-15'),
    });
    await fakeActivity({
      type: 'collective.unhosted',
      CollectiveId: otherCollectiveB.id,
      HostCollectiveId: otherHost.id,
      createdAt: new Date('2025-08-20'),
    });
  });

  describe('measures', () => {
    it('joinedCount counts every approval event (re-approvals included)', async () => {
      const result = await queryMetrics({
        source: HostedCollectivesMembership,
        measures: ['joinedCount'],
        dateFrom: '2025-01-01',
        dateTo: '2026-01-01',
        filters: { host: host.id },
      });
      // A (Mar) + B (Apr) + Fund (Apr) + A re-approval (Jul) = 4
      expect(result.rows[0].values.joinedCount).to.equal(4);
    });

    it('joinedDistinctCollectives counts each collective once', async () => {
      const result = await queryMetrics({
        source: HostedCollectivesMembership,
        measures: ['joinedDistinctCollectives'],
        dateFrom: '2025-01-01',
        dateTo: '2026-01-01',
        filters: { host: host.id },
      });
      expect(result.rows[0].values.joinedDistinctCollectives).to.equal(3); // A, B, Fund
    });

    it('churnedCount counts unhost events in scope', async () => {
      const result = await queryMetrics({
        source: HostedCollectivesMembership,
        measures: ['churnedCount'],
        dateFrom: '2025-01-01',
        dateTo: '2026-01-01',
        filters: { host: host.id },
      });
      expect(result.rows[0].values.churnedCount).to.equal(1);
    });
  });

  describe('filters and dimensions', () => {
    it('filters by accountType', async () => {
      const result = await queryMetrics({
        source: HostedCollectivesMembership,
        measures: ['joinedDistinctCollectives'],
        dateFrom: '2025-01-01',
        dateTo: '2026-01-01',
        filters: { host: host.id, accountType: ['FUND'] },
      });
      expect(result.rows[0].values.joinedDistinctCollectives).to.equal(1);
    });

    it('filters by event (only JOINED)', async () => {
      const result = await queryMetrics({
        source: HostedCollectivesMembership,
        measures: ['joinedCount', 'churnedCount'],
        dateFrom: '2025-01-01',
        dateTo: '2026-01-01',
        filters: { host: host.id, event: 'JOINED' },
      });
      expect(result.rows[0].values.joinedCount).to.equal(4);
      expect(result.rows[0].values.churnedCount).to.equal(0);
    });
  });

  describe('bucketing', () => {
    it('buckets joined events by month', async () => {
      const result = await queryMetrics({
        source: HostedCollectivesMembership,
        measures: ['joinedCount'],
        dateFrom: '2025-03-01',
        dateTo: '2025-08-01',
        filters: { host: host.id },
        bucket: 'month',
      });
      const byBucket = new Map(result.rows.map(r => [r.bucket, r.values.joinedCount]));
      expect(byBucket.get('2025-03-01')).to.equal(1);
      expect(byBucket.get('2025-04-01')).to.equal(2);
      expect(byBucket.get('2025-07-01')).to.equal(1);
    });
  });

  describe('exclusions', () => {
    it('excludes child-account (event) activities — view restricts to root only', async () => {
      const result = await queryMetrics({
        source: HostedCollectivesMembership,
        measures: ['joinedCount'],
        dateFrom: '2025-01-01',
        dateTo: '2026-01-01',
        filters: { host: host.id, account: event.id },
      });
      // The event's collective.approved activity must not appear (children filtered out).
      expect(result.rows[0]?.values.joinedCount ?? 0).to.equal(0);
    });

    it('excludes self-hosting', async () => {
      const result = await queryMetrics({
        source: HostedCollectivesMembership,
        measures: ['joinedCount'],
        dateFrom: '2025-01-01',
        dateTo: '2026-01-01',
        filters: { host: host.id, account: host.id },
      });
      expect(result.rows[0]?.values.joinedCount ?? 0).to.equal(0);
    });

    it('scopes by host', async () => {
      const result = await queryMetrics({
        source: HostedCollectivesMembership,
        measures: ['joinedCount'],
        dateFrom: '2025-01-01',
        dateTo: '2026-01-01',
        filters: { host: host.id },
      });
      // The other-host approvals shouldn't leak in.
      expect(result.rows[0].values.joinedCount).to.equal(4);
    });

    it('returns the other host`s membership when scoped to it (filter actually switches scope)', async () => {
      const result = await queryMetrics({
        source: HostedCollectivesMembership,
        measures: ['joinedCount', 'churnedCount', 'joinedDistinctCollectives'],
        dateFrom: '2025-01-01',
        dateTo: '2026-01-01',
        filters: { host: otherHost.id },
      });
      // otherHost: 2 approvals + 1 churn.
      expect(result.rows[0].values.joinedCount).to.equal(2);
      expect(result.rows[0].values.churnedCount).to.equal(1);
      expect(result.rows[0].values.joinedDistinctCollectives).to.equal(2);
    });
  });
});
