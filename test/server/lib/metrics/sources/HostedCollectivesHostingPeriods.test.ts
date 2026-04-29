import { expect } from 'chai';

import { CollectiveType } from '../../../../../server/constants/collectives';
import { queryMetrics } from '../../../../../server/lib/metrics';
import { HostedCollectivesHostingPeriods } from '../../../../../server/lib/metrics/sources';
import models from '../../../../../server/models';
import { HostApplicationStatus } from '../../../../../server/models/HostApplication';
import { fakeActiveHost, fakeActivity, fakeCollective, fakeHostApplication } from '../../../../test-helpers/fake-data';
import { resetTestDB } from '../../../../utils';

describe('server/lib/metrics/sources/HostedCollectivesHostingPeriods', () => {
  let host: Awaited<ReturnType<typeof fakeActiveHost>>;
  let otherHost: Awaited<ReturnType<typeof fakeActiveHost>>;
  let currentlyHosted: Awaited<ReturnType<typeof fakeCollective>>;
  let alsoCurrent: Awaited<ReturnType<typeof fakeCollective>>;
  let pastHosted: Awaited<ReturnType<typeof fakeCollective>>;

  before(async () => {
    await resetTestDB();
    host = await fakeActiveHost({ slug: 'metrics-hp-host' });
    otherHost = await fakeActiveHost({ slug: 'metrics-hp-other-host' });

    // (1) Currently hosted — open-ended interval starting at approvedAt.
    currentlyHosted = await fakeCollective({
      HostCollectiveId: host.id,
      type: CollectiveType.COLLECTIVE,
      approvedAt: new Date('2024-06-01'),
    });
    // (2) Another currently-hosted, joined later.
    alsoCurrent = await fakeCollective({
      HostCollectiveId: host.id,
      type: CollectiveType.COLLECTIVE,
      approvedAt: new Date('2025-09-15'),
    });

    // (3) Past hosted — joined Feb 2024, unhosted Apr 2025.
    // Set up: a HostApplication APPROVED + a collective.unhosted event,
    // and the Collectives row's HostCollectiveId set to NULL (no longer hosted).
    pastHosted = await fakeCollective({
      HostCollectiveId: host.id,
      type: CollectiveType.COLLECTIVE,
      approvedAt: new Date('2024-02-01'),
    });
    await fakeHostApplication({
      CollectiveId: pastHosted.id,
      HostCollectiveId: host.id,
      status: HostApplicationStatus.APPROVED,
      createdAt: new Date('2024-02-01'),
    });
    await fakeActivity({
      type: 'collective.unhosted',
      CollectiveId: pastHosted.id,
      HostCollectiveId: host.id,
      createdAt: new Date('2025-04-15'),
    });
    await models.Collective.update({ HostCollectiveId: null, approvedAt: null }, { where: { id: pastHosted.id } });

    // Other-host collectives — visible only when scoping to otherHost.
    // One currently-hosted + one past-hosted, so the host filter is genuinely exercised.
    await fakeCollective({ HostCollectiveId: otherHost.id, approvedAt: new Date('2024-01-01') });
    const otherPastHosted = await fakeCollective({
      HostCollectiveId: otherHost.id,
      type: CollectiveType.COLLECTIVE,
      approvedAt: new Date('2024-03-01'),
    });
    await fakeHostApplication({
      CollectiveId: otherPastHosted.id,
      HostCollectiveId: otherHost.id,
      status: HostApplicationStatus.APPROVED,
      createdAt: new Date('2024-03-01'),
    });
    await fakeActivity({
      type: 'collective.unhosted',
      CollectiveId: otherPastHosted.id,
      HostCollectiveId: otherHost.id,
      createdAt: new Date('2025-06-01'),
    });
    await models.Collective.update({ HostCollectiveId: null, approvedAt: null }, { where: { id: otherPastHosted.id } });
  });

  describe('hostedCollectives count', () => {
    it('returns currently-hosted collectives whose interval overlaps the period', async () => {
      const result = await queryMetrics({
        source: HostedCollectivesHostingPeriods,
        measures: ['hostedCollectives'],
        dateFrom: '2025-12-01',
        dateTo: '2026-01-01',
        filters: { host: host.id },
      });
      expect(result.rows[0].values.hostedCollectives).to.equal(2);
    });

    it('includes past-hosted collective when the period overlaps its closed interval', async () => {
      const result = await queryMetrics({
        source: HostedCollectivesHostingPeriods,
        measures: ['hostedCollectives'],
        dateFrom: '2024-06-01',
        dateTo: '2024-09-01',
        filters: { host: host.id },
      });
      expect(result.rows[0].values.hostedCollectives).to.equal(2);
    });

    it('excludes alsoCurrent before its approvedAt', async () => {
      const result = await queryMetrics({
        source: HostedCollectivesHostingPeriods,
        measures: ['hostedCollectives'],
        dateFrom: '2025-01-01',
        dateTo: '2025-02-01',
        filters: { host: host.id },
      });
      expect(result.rows[0].values.hostedCollectives).to.equal(2);
    });
  });

  describe('endDate dimension', () => {
    it('filters to currently-hosted via endDate IS NULL', async () => {
      const result = await queryMetrics({
        source: HostedCollectivesHostingPeriods,
        measures: ['hostedCollectives'],
        dateFrom: '2024-01-01',
        dateTo: '2026-01-01',
        filters: { host: host.id, endDate: null },
      });
      expect(result.rows[0].values.hostedCollectives).to.equal(2);
    });
  });

  describe('daysHostedToDate measure', () => {
    it('returns positive tenure for currently-hosted collectives', async () => {
      const result = await queryMetrics({
        source: HostedCollectivesHostingPeriods,
        measures: ['daysHostedToDate'],
        dateFrom: '2024-01-01',
        dateTo: '2026-12-31',
        filters: { host: host.id, endDate: null },
        groupBy: ['account'],
        limit: 100,
      });
      const byCollective = new Map(result.rows.map(r => [r.group?.account as number, r.values.daysHostedToDate]));
      expect(byCollective.get(currentlyHosted.id) as number).to.be.greaterThan(0);
      expect(byCollective.get(currentlyHosted.id) as number).to.be.greaterThan(
        byCollective.get(alsoCurrent.id) as number,
      );
    });
  });

  describe('bucketing', () => {
    it('counts hosted collectives per month using interval-overlap', async () => {
      const result = await queryMetrics({
        source: HostedCollectivesHostingPeriods,
        measures: ['hostedCollectives'],
        dateFrom: '2025-08-01',
        dateTo: '2025-11-01',
        filters: { host: host.id },
        bucket: 'month',
      });
      const byBucket = new Map(result.rows.map(r => [r.bucket, r.values.hostedCollectives]));
      expect(byBucket.get('2025-08-01')).to.equal(1);
      expect(byBucket.get('2025-09-01')).to.equal(2);
      expect(byBucket.get('2025-10-01')).to.equal(2);
    });

    it('includes the bucket containing dateTo when dateTo is mid-month', async () => {
      const result = await queryMetrics({
        source: HostedCollectivesHostingPeriods,
        measures: ['hostedCollectives'],
        dateFrom: '2025-08-01',
        dateTo: '2025-10-15',
        filters: { host: host.id },
        bucket: 'month',
      });
      const buckets = result.rows.map(r => r.bucket);
      expect(buckets).to.include('2025-10-01');
    });
  });

  describe('exclusions', () => {
    it('does not include other-host collectives', async () => {
      const result = await queryMetrics({
        source: HostedCollectivesHostingPeriods,
        measures: ['hostedCollectives'],
        dateFrom: '2024-01-01',
        dateTo: '2026-01-01',
        filters: { host: host.id },
      });
      expect(result.rows[0].values.hostedCollectives).to.equal(3);
    });

    it('returns the other host`s intervals when scoped to it (filter actually switches scope)', async () => {
      const result = await queryMetrics({
        source: HostedCollectivesHostingPeriods,
        measures: ['hostedCollectives'],
        dateFrom: '2024-01-01',
        dateTo: '2026-01-01',
        filters: { host: otherHost.id },
      });
      expect(result.rows[0].values.hostedCollectives).to.equal(2);
    });
  });
});
