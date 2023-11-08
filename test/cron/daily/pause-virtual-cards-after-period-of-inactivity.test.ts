import { expect } from 'chai';
import moment from 'moment';
import { createSandbox } from 'sinon';

import { run as runCron } from '../../../cron/daily/52-pause-virtual-cards-after-period-of-inactivity';
import ActivityTypes from '../../../server/constants/activities';
import VirtualCardProviders from '../../../server/constants/virtual_card_providers';
import { Activity, VirtualCard } from '../../../server/models';
import { VirtualCardStatus } from '../../../server/models/VirtualCard';
import * as stripeVirtualCards from '../../../server/paymentProviders/stripe/virtual-cards';
import { fakeActiveHost, fakeExpense, fakeHost, fakeVirtualCard } from '../../test-helpers/fake-data';
import { resetTestDB } from '../../utils';

describe('cron/daily/pause-virtual-cards-after-period-of-inactivity', () => {
  const sandbox = createSandbox();
  afterEach(sandbox.restore);

  beforeEach(async () => {
    await resetTestDB();
    sandbox.stub(stripeVirtualCards, 'pauseCard').resolves();
  });

  it('pauses inactive virtual cards', async () => {
    const expectPaused: VirtualCard[] = [];
    const expectActive: VirtualCard[] = [];

    async function makeVirtualCardWithExpense({
      HostCollectiveId,
      cardCreatedAt,
      expenseCreatedAt = null,
      expectIsPaused,
      name = undefined,
    }) {
      const vc = await fakeVirtualCard({
        provider: VirtualCardProviders.STRIPE,
        HostCollectiveId: HostCollectiveId,
        CollectiveId: HostCollectiveId,
        createdAt: cardCreatedAt,
        name,
      });

      if (expenseCreatedAt) {
        await fakeExpense({
          VirtualCardId: vc.id,
          createdAt: expenseCreatedAt,
        });
      }

      if (expectIsPaused) {
        expectPaused.push(vc);
      } else {
        expectActive.push(vc);
      }

      return vc;
    }

    const hostWith30DaysInactivePolicy = await fakeHost({
      name: '30DaysInactive',
      settings: {
        virtualcards: {
          autopauseUnusedCards: {
            enabled: true,
            period: 30,
          },
        },
      },
    });

    const vc = await makeVirtualCardWithExpense({
      name: '1',
      HostCollectiveId: hostWith30DaysInactivePolicy.id,
      cardCreatedAt: moment().subtract(40, 'days'),
      expenseCreatedAt: moment().subtract(31, 'days'),
      expectIsPaused: true,
    });

    await Activity.create({
      type: ActivityTypes.COLLECTIVE_VIRTUAL_CARD_RESUMED,
      createdAt: moment().subtract(32, 'days').toDate(),
      CollectiveId: vc.CollectiveId,
      HostCollectiveId: vc.HostCollectiveId,
      data: {
        virtualCard: vc,
      },
    });

    await makeVirtualCardWithExpense({
      name: '2',
      HostCollectiveId: hostWith30DaysInactivePolicy.id,
      cardCreatedAt: moment().subtract(61, 'days'),
      expenseCreatedAt: moment().subtract(61, 'days'),
      expectIsPaused: true,
    });

    await makeVirtualCardWithExpense({
      name: '3',
      HostCollectiveId: hostWith30DaysInactivePolicy.id,
      cardCreatedAt: moment().subtract(2, 'days'),
      expectIsPaused: false,
    });

    await makeVirtualCardWithExpense({
      name: '4',
      HostCollectiveId: hostWith30DaysInactivePolicy.id,
      cardCreatedAt: moment().subtract(2, 'days'),
      expenseCreatedAt: moment(),
      expectIsPaused: false,
    });

    const hostWith60DaysInactivePolicy = await fakeHost({
      name: '60DaysInactive',
      settings: {
        virtualcards: {
          autopauseUnusedCards: {
            enabled: true,
            period: 60,
          },
        },
      },
    });

    await makeVirtualCardWithExpense({
      name: '5',
      HostCollectiveId: hostWith60DaysInactivePolicy.id,
      cardCreatedAt: moment().subtract(31, 'days'),
      expenseCreatedAt: moment().subtract(31, 'days'),
      expectIsPaused: false,
    });

    await makeVirtualCardWithExpense({
      name: '6',
      HostCollectiveId: hostWith60DaysInactivePolicy.id,
      cardCreatedAt: moment().subtract(61, 'days'),
      expenseCreatedAt: moment().subtract(61, 'days'),
      expectIsPaused: true,
    });

    await makeVirtualCardWithExpense({
      name: '7',
      HostCollectiveId: hostWith60DaysInactivePolicy.id,
      cardCreatedAt: moment().subtract(61, 'days'),
      expectIsPaused: true,
    });

    const hostWithoutInactivePolicy = await fakeHost({
      name: 'NoInactivePolicy',
    });

    await makeVirtualCardWithExpense({
      name: '8',
      HostCollectiveId: hostWithoutInactivePolicy.id,
      cardCreatedAt: moment().subtract(61, 'days'),
      expenseCreatedAt: moment().subtract(61, 'days'),
      expectIsPaused: false,
    });

    await makeVirtualCardWithExpense({
      name: '9',
      HostCollectiveId: hostWithoutInactivePolicy.id,
      cardCreatedAt: moment().subtract(360, 'days'),
      expectIsPaused: false,
    });

    await runCron({ concurrency: 1 });

    for (const vc of expectActive) {
      await vc.reload();
      expect(vc.data.status, `Card ${vc.name} should be ACTIVE`).to.eql(VirtualCardStatus.ACTIVE);
    }

    for (const vc of expectPaused) {
      await vc.reload();
      expect(vc.data.status, `Card ${vc.name} should be INACTIVE`).to.eql(VirtualCardStatus.INACTIVE);
    }
  });

  it('does not pause vc if it was resumed within the period of inactivity', async () => {
    const hostWith30DaysInactivePolicy = await fakeActiveHost({
      name: '30DaysInactive',
      settings: {
        virtualcards: {
          autopauseUnusedCards: {
            enabled: true,
            period: 30,
          },
        },
      },
    });

    const unusedVirtualCard = await fakeVirtualCard({
      provider: VirtualCardProviders.STRIPE,
      HostCollectiveId: hostWith30DaysInactivePolicy.id,
      CollectiveId: hostWith30DaysInactivePolicy.id,
      createdAt: moment().subtract(31, 'days').toDate(),
      name: 'unused',
      data: { satus: VirtualCardStatus.ACTIVE },
    });

    await runCron({ concurrency: 1 });
    await unusedVirtualCard.reload();
    expect(unusedVirtualCard.data.status).to.eql(VirtualCardStatus.INACTIVE);

    await unusedVirtualCard.update({
      data: {
        status: VirtualCardStatus.ACTIVE,
      },
    });
    await Activity.create({
      type: ActivityTypes.COLLECTIVE_VIRTUAL_CARD_RESUMED,
      createdAt: new Date(),
      CollectiveId: unusedVirtualCard.CollectiveId,
      HostCollectiveId: unusedVirtualCard.HostCollectiveId,
      data: {
        virtualCard: unusedVirtualCard,
      },
    });

    await runCron({ concurrency: 1 });
    await unusedVirtualCard.reload();
    expect(unusedVirtualCard.data.status).to.eql(VirtualCardStatus.ACTIVE);
  });
});
