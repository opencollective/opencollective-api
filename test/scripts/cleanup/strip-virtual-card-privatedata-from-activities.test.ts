import { expect } from 'chai';

import { run } from '../../../scripts/cleanup/strip-virtual-card-privatedata-from-activities';
import ActivityTypes from '../../../server/constants/activities';
import { Activity } from '../../../server/models';
import { fakeCollective, fakeHost } from '../../test-helpers/fake-data';
import { resetTestDB } from '../../utils';

describe('scripts/cleanup/strip-virtual-card-privatedata-from-activities', () => {
  beforeEach(resetTestDB);

  const createActivity = async (data: Record<string, unknown>) => {
    const host = await fakeHost();
    const collective = await fakeCollective({ HostCollectiveId: host.id });
    return Activity.create(
      {
        type: ActivityTypes.COLLECTIVE_VIRTUAL_CARD_SUSPENDED,
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

    await run({ dryRun: true });
    await activity.reload();

    expect(activity.data.virtualCard).to.have.property('privateData');
    expect(activity.data.virtualCard.last4).to.equal('4242');
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
    await alreadyPublic.reload();
    await unrelated.reload();

    expect(withPrivateData.data.virtualCard).to.deep.equal({
      id: 'card-1',
      last4: '4242',
      name: 'Ops card',
    });
    expect(alreadyPublic.data.virtualCard).to.deep.equal({
      id: 'card-2',
      last4: '1111',
    });
    expect(unrelated.data).to.deep.equal({
      expense: { id: 99, description: 'office supplies' },
    });
  });
});
