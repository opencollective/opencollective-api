import { expect } from 'chai';
import { QueryTypes } from 'sequelize';

import { run } from '../../../scripts/cleanup/strip-w9-data-from-jsonb';
import ActivityTypes from '../../../server/constants/activities';
import { Activity, sequelize } from '../../../server/models';
import { fakeCollective, fakeHost } from '../../test-helpers/fake-data';
import { resetTestDB } from '../../utils';

const W9_SNAPSHOT = {
  receivedFromUserIds: [15873, 12155, 12457],
  requestSentToUserIds: [2, 15873],
};

describe('scripts/cleanup/strip-w9-data-from-jsonb', () => {
  beforeEach(resetTestDB);

  describe('collectives phase', () => {
    it('dry run reports reclaimable rows and KB without writing', async () => {
      const collective = await fakeCollective({ data: { W9: W9_SNAPSHOT, isTrustedHost: true } });

      const result = await run({ dryRun: true, phase: 'collectives' });

      expect(result.collectives.processed).to.equal(1);
      expect(result.collectives.updated).to.equal(1);
      expect(result.collectives.bytesSaved).to.be.above(0);
      expect(result.collectives.complete).to.equal(true);

      await collective.reload();
      expect(collective.data).to.have.property('W9');
    });

    it('removes data.W9, preserves sibling keys, and reports the same KB on apply as on dry run', async () => {
      const collective = await fakeCollective({ data: { W9: W9_SNAPSHOT, isTrustedHost: true } });

      const dry = await run({ dryRun: true, phase: 'collectives' });
      const applied = await run({ dryRun: false, phase: 'collectives' });

      expect(applied.collectives.updated).to.equal(1);
      expect(applied.collectives.bytesSaved).to.equal(dry.collectives.bytesSaved);

      await collective.reload();
      expect(collective.data).to.deep.equal({ isTrustedHost: true });

      const rerun = await run({ dryRun: false, phase: 'collectives' });
      expect(rerun.collectives.processed).to.equal(0);
      expect(rerun.collectives.updated).to.equal(0);
      expect(rerun.collectives.complete).to.equal(true);
    });

    it('processes rows in batches with a limit and resumes with afterId', async () => {
      const first = await fakeCollective({ data: { W9: W9_SNAPSHOT } });
      const second = await fakeCollective({ data: { W9: W9_SNAPSHOT } });
      const third = await fakeCollective({ data: { W9: W9_SNAPSHOT } });

      const partial = await run({ dryRun: false, phase: 'collectives', batchSize: 1, limit: 2 });
      expect(partial.collectives.processed).to.equal(2);
      expect(partial.collectives.updated).to.equal(2);
      expect(partial.collectives.complete).to.equal(false);

      await first.reload();
      await second.reload();
      await third.reload();
      expect(first.data).to.not.have.property('W9');
      expect(second.data).to.not.have.property('W9');
      expect(third.data).to.have.property('W9');

      const resumed = await run({ dryRun: false, phase: 'collectives', batchSize: 10, afterId: second.id });
      expect(resumed.collectives.processed).to.equal(1);
      expect(resumed.collectives.updated).to.equal(1);

      await third.reload();
      expect(third.data).to.not.have.property('W9');
    });
  });

  describe('activities phase', () => {
    const createActivity = async (
      data: Record<string, unknown>,
      type: ActivityTypes = ActivityTypes.COLLECTIVE_APPROVED,
    ) => {
      const host = await fakeHost();
      const collective = await fakeCollective({ HostCollectiveId: host.id });
      return Activity.create(
        {
          type,
          CollectiveId: collective.id,
          HostCollectiveId: host.id,
          data,
        },
        { hooks: false },
      );
    };

    it('dry run reports nested occurrences without writing', async () => {
      const activity = await createActivity({
        host: { id: 1, slug: 'host', data: { W9: W9_SNAPSHOT, plan: { name: 'pro' } } },
        virtualCard: {
          id: 'card-1',
          host: { id: 1, data: { W9: W9_SNAPSHOT } },
        },
      });

      const result = await run({ dryRun: true, phase: 'activities' });

      expect(result.activities.processed).to.equal(1);
      expect(result.activities.updated).to.equal(1);
      expect(result.activities.bytesSaved).to.be.above(0);

      await activity.reload();
      expect(activity.data.host.data).to.have.property('W9');
      expect(activity.data.virtualCard.host.data).to.have.property('W9');
    });

    it('removes W9 from explicit snapshot locations and leaves everything else intact', async () => {
      const withSnapshots = await createActivity({
        host: { id: 1, slug: 'host', data: { W9: W9_SNAPSHOT, plan: { name: 'pro' } } },
        fromCollective: { id: 2, slug: 'collective', data: { W9: W9_SNAPSHOT } },
        virtualCard: {
          id: 'card-1',
          host: {
            id: 1,
            data: {
              W9: W9_SNAPSHOT,
              spamReport: { score: 0.5, data: { name: 'Host', data: { W9: W9_SNAPSHOT } } },
            },
          },
          collective: { id: 2, data: { W9: W9_SNAPSHOT } },
        },
      });
      const legalDoc = await createActivity({
        type: 'W9',
        formData: { formType: 'W9' },
        host: { id: 3, slug: 'other-host', data: { plan: { name: 'basic' } } },
      });
      const unrelated = await createActivity({ expense: { id: 99, description: 'office supplies' } });
      // W9 outside the explicit snapshot locations is out of scope and left intact
      const unlisted = await createActivity({
        W9: 'root-value-kept',
        custom: { data: { W9: W9_SNAPSHOT } },
      });

      const dry = await run({ dryRun: true, phase: 'activities' });
      const applied = await run({ dryRun: false, phase: 'activities' });

      expect(applied.activities.updated).to.equal(1);
      expect(applied.activities.bytesSaved).to.equal(dry.activities.bytesSaved);

      await withSnapshots.reload();
      await legalDoc.reload();
      await unrelated.reload();
      await unlisted.reload();

      expect(withSnapshots.data).to.deep.equal({
        host: { id: 1, slug: 'host', data: { plan: { name: 'pro' } } },
        fromCollective: { id: 2, slug: 'collective', data: {} },
        virtualCard: {
          id: 'card-1',
          host: {
            id: 1,
            data: {
              spamReport: { score: 0.5, data: { name: 'Host', data: {} } },
            },
          },
          collective: { id: 2, data: {} },
        },
      });
      // W9 *values* (e.g. LegalDocuments form types) are preserved
      expect(legalDoc.data).to.deep.equal({
        type: 'W9',
        formData: { formType: 'W9' },
        host: { id: 3, slug: 'other-host', data: { plan: { name: 'basic' } } },
      });
      expect(unrelated.data).to.deep.equal({ expense: { id: 99, description: 'office supplies' } });
      expect(unlisted.data).to.deep.equal({
        W9: 'root-value-kept',
        custom: { data: { W9: W9_SNAPSHOT } },
      });

      const rerun = await run({ dryRun: false, phase: 'activities' });
      expect(rerun.activities.processed).to.equal(0);
    });

    it('processes rows in batches with a limit and resumes with afterId', async () => {
      const first = await createActivity({ host: { data: { W9: W9_SNAPSHOT } } });
      const second = await createActivity({ host: { data: { W9: W9_SNAPSHOT } } });
      const third = await createActivity({ host: { data: { W9: W9_SNAPSHOT } } });

      const partial = await run({ dryRun: false, phase: 'activities', batchSize: 1, limit: 2 });
      expect(partial.activities.processed).to.equal(2);
      expect(partial.activities.updated).to.equal(2);
      expect(partial.activities.complete).to.equal(false);

      await first.reload();
      await second.reload();
      await third.reload();
      expect(first.data.host.data).to.not.have.property('W9');
      expect(second.data.host.data).to.not.have.property('W9');
      expect(third.data.host.data).to.have.property('W9');

      const resumed = await run({ dryRun: false, phase: 'activities', batchSize: 10, afterId: second.id });
      expect(resumed.activities.processed).to.equal(1);

      await third.reload();
      expect(third.data.host.data).to.not.have.property('W9');
    });
  });

  describe('validation', () => {
    it('rejects invalid pagination options', async () => {
      await expect(run({ batchSize: 0 })).to.be.rejectedWith('batchSize must be a positive integer');
      await expect(run({ limit: -1 })).to.be.rejectedWith('limit must be a positive integer');
      await expect(run({ afterId: -1 })).to.be.rejectedWith('afterId must be a non-negative integer');
      await expect(run({ scanBudget: 0 })).to.be.rejectedWith('scanBudget must be a positive integer');
      await expect(run({ phase: 'unknown' as never })).to.be.rejectedWith('Invalid phase');
    });
  });

  describe('scan window', () => {
    const allActivityIds = async (): Promise<number[]> => {
      const rows = await sequelize.query<{ id: number }>('SELECT id FROM "Activities" ORDER BY id ASC', {
        type: QueryTypes.SELECT,
      });
      return rows.map(row => row.id);
    };

    const createActivity = async (data: Record<string, unknown>) => {
      const host = await fakeHost();
      const collective = await fakeCollective({ HostCollectiveId: host.id });
      return Activity.create(
        {
          type: ActivityTypes.COLLECTIVE_APPROVED,
          CollectiveId: collective.id,
          HostCollectiveId: host.id,
          data,
        },
        { hooks: false },
      );
    };

    it('examines at most scanBudget rows and resumes manually with afterId', async () => {
      const first = await createActivity({ host: { data: { W9: W9_SNAPSHOT } } });
      const second = await createActivity({ host: { data: { W9: W9_SNAPSHOT } } });
      const third = await createActivity({ host: { data: { W9: W9_SNAPSHOT } } });
      const ids = await allActivityIds();

      const partial = await run({ dryRun: false, phase: 'activities', scanBudget: 1 });

      // Exactly one table row examined, window cursor returned for a manual rerun
      expect(partial.activities.scanned).to.equal(1);
      expect(partial.activities.lastId).to.equal(ids[0]);
      expect(partial.activities.complete).to.equal(false);

      await first.reload();
      await second.reload();
      await third.reload();
      const cleanedInWindow = [first, second, third].filter(a => !a.data.host.data.W9);
      expect(cleanedInWindow.length).to.be.at.most(1);

      const resumed = await run({ dryRun: false, phase: 'activities', afterId: partial.activities.lastId });
      expect(resumed.activities.complete).to.equal(true);

      await first.reload();
      await second.reload();
      await third.reload();
      expect(first.data.host.data).to.not.have.property('W9');
      expect(second.data.host.data).to.not.have.property('W9');
      expect(third.data.host.data).to.not.have.property('W9');

      const rerun = await run({ dryRun: false, phase: 'activities' });
      expect(rerun.activities.processed).to.equal(0);
      expect(rerun.activities.complete).to.equal(true);
    });
  });
});
