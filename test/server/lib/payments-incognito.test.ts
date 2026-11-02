import { expect } from 'chai';
import { createSandbox } from 'sinon';

import { activities } from '../../../server/constants';
import OrderStatuses from '../../../server/constants/order-status';
import roles from '../../../server/constants/roles';
import emailLib from '../../../server/lib/email';
import {
  disableActivityDispatchTracking,
  enableActivityDispatchTracking,
} from '../../../server/lib/notifications/activity-dispatch-tracker';
import { sendEmailNotifications } from '../../../server/lib/payments';
import { Activity, Collective, Member, User } from '../../../server/models';
import { ManualPaymentProviderTypes } from '../../../server/models/ManualPaymentProvider';
import {
  fakeActiveHost,
  fakeCollective,
  fakeIncognitoProfile,
  fakeManualPaymentProvider,
  fakeMember,
  fakeOrder,
  fakeUser,
} from '../../test-helpers/fake-data';
import { resetTestDB, waitForCondition } from '../../utils';

describe('server/lib/payments pending contribution reply-to', () => {
  const sandbox = createSandbox();

  beforeEach(async () => {
    await resetTestDB();
    enableActivityDispatchTracking();
    sandbox.stub(emailLib, 'send').resolves();
  });

  afterEach(async () => {
    await Activity.waitAllDispatch();
    disableActivityDispatchTracking();
    sandbox.restore();
  });

  const createPendingContributionActivity = async (fromCollective: Collective, user: User): Promise<Activity> => {
    const host = await fakeActiveHost();
    const collective = await fakeCollective({ HostCollectiveId: host.id });
    const provider = await fakeManualPaymentProvider({
      CollectiveId: host.id,
      type: ManualPaymentProviderTypes.OTHER,
    });
    const order = await fakeOrder({
      status: OrderStatuses.PENDING,
      CreatedByUserId: user.id,
      FromCollectiveId: fromCollective.id,
      CollectiveId: collective.id,
      ManualPaymentProviderId: provider.id,
    });

    sendEmailNotifications(order);

    // Both notifications run asynchronously; wait for the contributor activity as well so it cannot outlive the test.
    return waitForCondition(async () => {
      const orderActivities = await Activity.findAll({ where: { OrderId: order.id } });
      const hostActivity = orderActivities.find(
        activity => activity.type === activities.ORDER_PENDING_CONTRIBUTION_NEW,
      );
      const contributorActivity = orderActivities.find(activity => activity.type === activities.ORDER_PENDING);
      return contributorActivity && hostActivity;
    });
  };

  it('uses the Incognito ADMIN email when the profile creator is a different user', async () => {
    const owner = await fakeUser();
    const creator = await fakeUser();
    const incognito = await fakeIncognitoProfile(owner);
    await incognito.update({ CreatedByUserId: creator.id });

    const activity = await createPendingContributionActivity(incognito, owner);

    expect(activity.data.replyTo).to.equal(owner.email);
    expect(activity.data.replyTo).not.to.include(creator.email);
  });

  it('uses the Incognito ADMIN email when the profile has no creator', async () => {
    const owner = await fakeUser();
    const incognito = await fakeIncognitoProfile(owner);
    await incognito.update({ CreatedByUserId: null });

    const activity = await createPendingContributionActivity(incognito, owner);

    expect(activity.data.replyTo).to.equal(owner.email);
  });

  it('does not use the creator email after their Incognito ADMIN role is revoked', async () => {
    const owner = await fakeUser();
    const incognito = await fakeIncognitoProfile(owner);
    await Member.update(
      { role: roles.MEMBER },
      { where: { CollectiveId: incognito.id, MemberCollectiveId: owner.CollectiveId, role: roles.ADMIN } },
    );

    const activity = await createPendingContributionActivity(incognito, owner);

    expect(activity.data.replyTo).to.equal('');
  });

  it('does not use the creator email after their Incognito ADMIN membership is soft deleted', async () => {
    const owner = await fakeUser();
    const incognito = await fakeIncognitoProfile(owner);
    await Member.destroy({
      where: { CollectiveId: incognito.id, MemberCollectiveId: owner.CollectiveId, role: roles.ADMIN },
    });

    const activity = await createPendingContributionActivity(incognito, owner);

    expect(activity.data.replyTo).to.equal('');
  });

  it('preserves the reply-to email for a regular user profile', async () => {
    const user = await fakeUser();

    const activity = await createPendingContributionActivity(user.collective, user);

    expect(activity.data.replyTo).to.equal(user.email);
  });

  it('preserves all ADMIN emails for a regular collective', async () => {
    const firstAdmin = await fakeUser();
    const secondAdmin = await fakeUser();
    const contributor = await fakeCollective({ HostCollectiveId: null });
    await fakeMember({ CollectiveId: contributor.id, MemberCollectiveId: firstAdmin.CollectiveId, role: roles.ADMIN });
    await fakeMember({ CollectiveId: contributor.id, MemberCollectiveId: secondAdmin.CollectiveId, role: roles.ADMIN });

    const activity = await createPendingContributionActivity(contributor, firstAdmin);

    expect(activity.data.replyTo).to.equal(`${firstAdmin.email}, ${secondAdmin.email}`);
  });
});
