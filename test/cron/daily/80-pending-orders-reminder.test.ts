import { expect } from 'chai';
import { createSandbox, SinonSandbox, SinonSpy } from 'sinon';

import { run } from '../../../cron/daily/80-pending-orders-reminder';
import ActivityTypes from '../../../server/constants/activities';
import OrderStatuses from '../../../server/constants/order-status';
import emailLib from '../../../server/lib/email';
import models from '../../../server/models';
import { fakeCollective, fakeOrder, fakeUser } from '../../test-helpers/fake-data';
import { resetTestDB, waitForCondition } from '../../utils';

const REMINDER_DAYS = 4;

describe('cron/daily/80-pending-orders-reminder', () => {
  let sandbox: SinonSandbox;
  let sendMessageSpy: SinonSpy;
  let host, collective, admin;

  before(() => {
    // Pin the cron reference date so the "createdAt 4 days ago" window is deterministic.
    process.env.START_DATE = '2024-06-15T12:00:00.000Z';
  });

  after(() => {
    delete process.env.START_DATE;
  });

  beforeEach(async () => {
    await resetTestDB();
    sandbox = createSandbox();
    sendMessageSpy = sandbox.spy(emailLib, 'sendMessage');
    admin = await fakeUser();
    host = await fakeCollective({ hasMoneyManagement: true, admin });
    collective = await fakeCollective({ HostCollectiveId: host.id });
  });

  afterEach(() => {
    sandbox.restore();
  });

  /** Creates a pending order (no payment method) on the day the cron looks at. */
  const createPendingOrderOnReminderDay = (data = {}) => {
    const reminderDay = new Date(process.env.START_DATE);
    reminderDay.setDate(reminderDay.getDate() - REMINDER_DAYS);
    reminderDay.setUTCHours(10, 0, 0, 0);

    return fakeOrder({
      status: OrderStatuses.PENDING,
      PaymentMethodId: null,
      CollectiveId: collective.id,
      createdAt: reminderDay,
      data,
    });
  };

  it('sends a reminder for manual pending orders (bank transfers)', async () => {
    const order = await createPendingOrderOnReminderDay({
      isManualContribution: true,
      fromAccountInfo: { name: 'Bank Payer', email: 'payer@example.com' },
    });

    await run();

    const activity = await models.Activity.findOne({
      where: { type: ActivityTypes.ORDER_PENDING_CONTRIBUTION_REMINDER, OrderId: order.id },
    });
    expect(activity).to.exist;

    await waitForCondition(() => sendMessageSpy.called);
    expect(sendMessageSpy.args.some(args => args[0] === admin.email)).to.be.true;
    console.dir(sendMessageSpy.args);
  });

  it('does not send a reminder for expected funds created through createPendingOrder', async () => {
    const order = await createPendingOrderOnReminderDay({
      isPendingContribution: true,
      fromAccountInfo: { name: 'Expected Funder', email: 'funder@example.com' },
    });

    await run();

    const activity = await models.Activity.findOne({
      where: { type: ActivityTypes.ORDER_PENDING_CONTRIBUTION_REMINDER, OrderId: order.id },
    });
    expect(activity).to.be.null;
    expect(sendMessageSpy.called).to.be.false;
  });
});
