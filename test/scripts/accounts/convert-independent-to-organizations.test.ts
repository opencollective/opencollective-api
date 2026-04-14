import { expect } from 'chai';

import { main as runConvert } from '../../../scripts/accounts/convert-independent-to-organizations';
import { activities } from '../../../server/constants';
import { CollectiveType } from '../../../server/constants/collectives';
import models from '../../../server/models';
import { fakeActiveHost, fakeCollective, fakeOrganization, fakeUser } from '../../test-helpers/fake-data';
import { resetTestDB } from '../../utils';

describe('scripts/accounts/convert-independent-to-organizations', () => {
  beforeEach(resetTestDB);

  it('successfully converts an independent collective to an organization with money management enabled and hosting disabled', async () => {
    const user = await fakeUser();
    const independentCollective = await fakeCollective({
      type: CollectiveType.COLLECTIVE,
      HostCollectiveId: null,
      CreatedByUserId: user.id,
      isActive: true,
    });

    // Make it independent (self-hosting)
    await independentCollective.update({
      HostCollectiveId: independentCollective.id,
    });

    // Run the conversion
    await runConvert({ isDryRun: false, slug: independentCollective.slug });

    // Reload and verify conversion
    await independentCollective.reload();
    expect(independentCollective.type).to.equal(CollectiveType.ORGANIZATION);
    expect(independentCollective.hasMoneyManagement).to.be.true;
    expect(independentCollective.hasMoneyManagement).to.be.true;
    expect(independentCollective.hasHosting).to.be.false; // Hosting should be disabled

    // Verify activity was created
    const activity = await models.Activity.findOne({
      where: {
        type: activities.COLLECTIVE_CONVERTED_TO_ORGANIZATION,
        CollectiveId: independentCollective.id,
      },
    });

    expect(activity).to.exist;
    expect(activity.UserId).to.be.null;
    expect(activity.FromCollectiveId).to.equal(independentCollective.id);
    expect(activity.data?.collective).to.exist;
  });

  it('only converts independent collectives', async () => {
    // Create an independent collective (should be converted)
    const independentCollective = await fakeCollective({
      type: CollectiveType.COLLECTIVE,
      HostCollectiveId: null,
      isActive: true,
    });
    await independentCollective.update({
      HostCollectiveId: independentCollective.id,
    });

    // Create a hosted collective (should NOT be converted)
    const host = await fakeActiveHost({});
    const hostedCollective = await fakeCollective({
      type: CollectiveType.COLLECTIVE,
      HostCollectiveId: host.id,
      isActive: true,
    });

    // Create an organization (should NOT be converted)
    const organization = await fakeOrganization({
      isActive: true,
    });

    // Create an inactive collective (should NOT be converted)
    const inactiveCollective = await fakeCollective({
      type: CollectiveType.COLLECTIVE,
      HostCollectiveId: null,
      isActive: false,
    });

    // Run the conversion
    await runConvert({ isDryRun: false });

    // Verify independent collective was converted
    await independentCollective.reload();
    expect(independentCollective.type).to.equal(CollectiveType.ORGANIZATION);
    expect(independentCollective.hasMoneyManagement).to.be.true;
    expect(independentCollective.hasHosting).to.be.false;

    // Verify hosted collective was NOT converted
    await hostedCollective.reload();
    expect(hostedCollective.type).to.equal(CollectiveType.COLLECTIVE);
    expect(hostedCollective.HostCollectiveId).to.equal(host.id);

    // Verify organization was NOT converted
    await organization.reload();
    expect(organization.type).to.equal(CollectiveType.ORGANIZATION);

    // Verify inactive collective was NOT converted
    await inactiveCollective.reload();
    expect(inactiveCollective.type).to.equal(CollectiveType.COLLECTIVE);
    expect(inactiveCollective.isActive).to.be.false;

    // Verify only one activity was created (for the independent collective)
    const allActivities = await models.Activity.findAll({
      where: {
        type: activities.COLLECTIVE_CONVERTED_TO_ORGANIZATION,
      },
    });

    expect(allActivities).to.have.lengthOf(1);
    expect(allActivities[0].CollectiveId).to.equal(independentCollective.id);
  });
});
