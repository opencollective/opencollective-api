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

    const result = await run({ dryRun: true });

    expect(result.processed).to.equal(1);
    expect(result.updated).to.equal(1);
    expect(result.bytesSaved).to.be.above(0);

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

    const dry = await run({ dryRun: true });
    const applied = await run({ dryRun: false });

    expect(applied.updated).to.equal(1);
    expect(applied.bytesSaved).to.equal(dry.bytesSaved);

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

    const rerun = await run({ dryRun: false });
    expect(rerun.processed).to.equal(0);
    expect(rerun.complete).to.equal(true);
  });

  it('migrates up to limit rows and resumes with afterId', async () => {
    const first = await createActivity({ host: { data: { W9: W9_SNAPSHOT } } });
    const second = await createActivity({ host: { data: { W9: W9_SNAPSHOT } } });
    const third = await createActivity({ host: { data: { W9: W9_SNAPSHOT } } });

    const partial = await run({ dryRun: false, batchSize: 1, limit: 2 });
    expect(partial.processed).to.equal(2);
    expect(partial.updated).to.equal(2);
    expect(partial.complete).to.equal(false);

    await first.reload();
    await second.reload();
    await third.reload();
    expect(first.data.host.data).to.not.have.property('W9');
    expect(second.data.host.data).to.not.have.property('W9');
    expect(third.data.host.data).to.have.property('W9');

    const resumed = await run({ dryRun: false, batchSize: 10, afterId: second.id });
    expect(resumed.processed).to.equal(1);

    await third.reload();
    expect(third.data.host.data).to.not.have.property('W9');
  });

  it('rejects invalid options', async () => {
    await expect(run({ batchSize: 0 })).to.be.rejectedWith('batchSize must be a positive integer');
    await expect(run({ limit: -1 })).to.be.rejectedWith('limit must be a positive integer');
    await expect(run({ afterId: -1 })).to.be.rejectedWith('afterId must be a non-negative integer');
  });

  describe('probe window', () => {
    const allActivityIds = async (): Promise<number[]> => {
      const rows = await sequelize.query<{ id: number }>('SELECT id FROM "Activities" ORDER BY id ASC', {
        type: QueryTypes.SELECT,
      });
      return rows.map(row => row.id);
    };

    it('uses batchSize as the probe window and advances one window at a time', async () => {
      const first = await createActivity({ host: { data: { W9: W9_SNAPSHOT } } });
      await createActivity({ host: { data: { W9: W9_SNAPSHOT } } });
      await createActivity({ host: { data: { W9: W9_SNAPSHOT } } });
      const ids = await allActivityIds();

      // batchSize=1 probes a single row per window; limit=1 stops after the first match
      const partial = await run({ dryRun: true, batchSize: 1, limit: 1 });

      // Windows advanced one row at a time until the first W9 match
      expect(partial.scanned).to.equal(ids.indexOf(first.id) + 1);
      expect(partial.processed).to.equal(1);
      expect(partial.lastId).to.equal(first.id);
      expect(partial.complete).to.equal(false);

      const resumed = await run({ dryRun: true, afterId: partial.lastId });
      expect(resumed.complete).to.equal(true);

      const rerun = await run({ dryRun: true });
      expect(rerun.processed).to.equal(3);
      expect(rerun.complete).to.equal(true);
    });
  });
});
