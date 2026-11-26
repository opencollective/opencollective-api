import { expect } from 'chai';

import { run } from '../../../scripts/cleanup/strip-virtual-card-privatedata-from-activities';
import ActivityTypes from '../../../server/constants/activities';
import { Activity } from '../../../server/models';
import { fakeCollective, fakeHost } from '../../test-helpers/fake-data';
import { resetTestDB } from '../../utils';

describe('scripts/cleanup/strip-virtual-card-privatedata-from-activities', () => {
  beforeEach(resetTestDB);

  const createActivity = async (
    data: Record<string, unknown>,
    type = ActivityTypes.COLLECTIVE_VIRTUAL_CARD_SUSPENDED,
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

  it('does not update rows during dry run', async () => {
    const activity = await createActivity({
      virtualCard: {
        id: 'card-1',
        last4: '4242',
        privateData: { cardNumber: '4111111111114242', cvv: 'FAKESECRET_q3r4s5t6u7v8w9x0y1z2' },
      },
    });
    const laterActivity = await createActivity({ virtualCard: { privateData: { cvv: 'FAKESECRET_later' } } });

    expect(await run({ dryRun: true, batchSize: 1, afterId: activity.id })).to.deep.equal({
      processed: 1,
      lastId: laterActivity.id,
    });
    await activity.reload();
    await laterActivity.reload();

    expect(activity.data.virtualCard).to.have.property('privateData');
    expect(activity.data.virtualCard.last4).to.equal('4242');
    expect(laterActivity.data.virtualCard).to.have.property('privateData');
  });

  it('removes privateData from virtual card snapshots and leaves other fields intact', async () => {
    const withPrivateData = await createActivity({
      virtualCard: {
        id: 'card-1',
        last4: '4242',
        name: 'Ops card',
        privateData: { cardNumber: '4111111111114242', cvv: 'FAKESECRET_q3r4s5t6u7v8w9x0y1z2' },
      },
    });
    const resumed = await createActivity(
      { virtualCard: { id: 'card-3', privateData: { cvv: 'FAKESECRET_resumed' } } },
      ActivityTypes.COLLECTIVE_VIRTUAL_CARD_RESUMED,
    );
    const historical = await createActivity(
      { virtualCard: { id: 'card-4', privateData: { cvv: 'FAKESECRET_historical' } } },
      ActivityTypes.COLLECTIVE_VIRTUAL_CARD_CREATED,
    );
    const alreadyPublic = await createActivity({
      virtualCard: {
        id: 'card-2',
        last4: '1111',
      },
    });
    const unrelated = await createActivity({
      expense: { id: 99, description: 'office supplies' },
    });

    await run({ dryRun: false });

    await withPrivateData.reload();
    await resumed.reload();
    await historical.reload();
    await alreadyPublic.reload();
    await unrelated.reload();

    expect(withPrivateData.data.virtualCard).to.deep.equal({
      id: 'card-1',
      last4: '4242',
      name: 'Ops card',
    });
    expect(resumed.data.virtualCard).to.deep.equal({ id: 'card-3' });
    expect(historical.data.virtualCard).to.deep.equal({ id: 'card-4' });
    expect(alreadyPublic.data.virtualCard).to.deep.equal({
      id: 'card-2',
      last4: '1111',
    });
    expect(unrelated.data).to.deep.equal({
      expense: { id: 99, description: 'office supplies' },
    });
  });

  it('updates a limited number of rows in batches and continues on the next run', async () => {
    const first = await createActivity({ virtualCard: { privateData: { cvv: 'FAKESECRET_first' } } });
    const second = await createActivity({ virtualCard: { privateData: { cvv: 'FAKESECRET_second' } } });
    const third = await createActivity({ virtualCard: { privateData: { cvv: 'FAKESECRET_third' } } });

    expect(await run({ dryRun: false, batchSize: 1, limit: 2 })).to.deep.equal({ processed: 2, lastId: second.id });

    await first.reload();
    await second.reload();
    await third.reload();
    expect(first.data.virtualCard).to.not.have.property('privateData');
    expect(second.data.virtualCard).to.not.have.property('privateData');
    expect(third.data.virtualCard).to.have.property('privateData');

    expect(await run({ dryRun: false, batchSize: 1 })).to.deep.equal({ processed: 1, lastId: third.id });
    await third.reload();
    expect(third.data.virtualCard).to.not.have.property('privateData');
    expect(await run({ dryRun: false, batchSize: 1 })).to.deep.equal({ processed: 0, lastId: 0 });
  });
});
