import { expect } from 'chai';
import moment from 'moment';
import { createSandbox } from 'sinon';

import { run } from '../../../cron/daily/50-check-virtual-cards-missing-receipts';
import ActivityTypes from '../../../server/constants/activities';
import VirtualCardProviders from '../../../server/constants/virtual-card-providers';
import { Activity } from '../../../server/models';
import { VirtualCardStatus } from '../../../server/models/VirtualCard';
import * as stripeVirtualCards from '../../../server/paymentProviders/stripe/virtual-cards';
import { fakeCollective, fakeExpense, fakeHost, fakeVirtualCard } from '../../test-helpers/fake-data';
import { resetTestDB } from '../../utils';

const PRIVATE_CARD_DATA = { cardNumber: '4111111111114242', cvv: 'FAKESECRET_q3r4s5t6u7v8w9x0y1z2' };

describe('cron/daily/check-virtual-cards-missing-receipts', () => {
  const sandbox = createSandbox();
  afterEach(sandbox.restore);

  beforeEach(async () => {
    await resetTestDB();
    sandbox.stub(stripeVirtualCards, 'pauseCard').resolves();
  });

  const setupHostedCard = async ({ createdAt, settings }) => {
    const host = await fakeHost({ settings: { virtualcards: settings } });
    const collective = await fakeCollective({ HostCollectiveId: host.id });
    const virtualCard = await fakeVirtualCard({
      provider: VirtualCardProviders.STRIPE,
      CollectiveId: collective.id,
      HostCollectiveId: host.id,
      name: 'Ops card',
      last4: '4242',
      privateData: PRIVATE_CARD_DATA,
    });
    await fakeExpense({
      type: 'CHARGE',
      status: 'PAID',
      CollectiveId: collective.id,
      HostCollectiveId: host.id,
      VirtualCardId: virtualCard.id,
      createdAt,
      items: [{ amount: 10000, url: null }],
    });

    return { host, collective, virtualCard };
  };

  const expectPublicVirtualCardSnapshot = (snapshot, virtualCard) => {
    expect(snapshot).to.include({
      id: virtualCard.id,
      name: virtualCard.name,
      last4: virtualCard.last4,
    });
    expect(snapshot).to.not.have.property('privateData');
    expect(snapshot).to.not.have.property('cardNumber');
    expect(snapshot).to.not.have.property('cvv');
  };

  it('notifies missing receipts without storing private card data', async () => {
    const { virtualCard } = await setupHostedCard({
      createdAt: moment().subtract(15, 'days').toDate(),
      settings: { reminder: true },
    });

    await run();

    await virtualCard.reload();
    expect(virtualCard.data.status).to.eql(VirtualCardStatus.ACTIVE);

    const activity = await Activity.findOne({
      where: { type: ActivityTypes.COLLECTIVE_VIRTUAL_CARD_MISSING_RECEIPTS },
    });
    expect(activity).to.exist;
    expectPublicVirtualCardSnapshot(activity.data.virtualCard, virtualCard);
  });

  it('pauses cards with overdue receipts and stores a public virtual card snapshot', async () => {
    const { virtualCard } = await setupHostedCard({
      createdAt: moment().subtract(32, 'days').toDate(),
      settings: { autopause: true },
    });

    await run();

    await virtualCard.reload();
    expect(virtualCard.data.status).to.eql(VirtualCardStatus.INACTIVE);
    expect(virtualCard.data.pauseReason).to.eql('MISSING_RECEIPTS');

    const activity = await Activity.findOne({
      where: { type: ActivityTypes.COLLECTIVE_VIRTUAL_CARD_SUSPENDED },
    });
    expect(activity).to.exist;
    expectPublicVirtualCardSnapshot(activity.data.virtualCard, virtualCard);
  });
});
