import { expect } from 'chai';

import { main as runConvert } from '../../../scripts/accounts/convert-independent-to-host';
import { CollectiveType } from '../../../server/constants/collectives';
import MemberRoles from '../../../server/constants/roles';
import { fakeCollective, fakeEvent, fakeOrganization, fakeProject, fakeUser } from '../../test-helpers/fake-data';
import { resetTestDB } from '../../utils';

describe('scripts/accounts/convert-independent-to-host', () => {
  beforeEach(resetTestDB);

  it('successfully converts an independent collective to a host organization', async () => {
    const user = await fakeUser();
    const collective = await fakeCollective({
      type: CollectiveType.COLLECTIVE,
      HostCollectiveId: null,
      CreatedByUserId: user.id,
    });

    // Make it independent
    await collective.update({
      HostCollectiveId: collective.id,
      isActive: true,
      approvedAt: new Date(),
      hasMoneyManagement: true,
    });

    // Add some admin members
    await collective.addUserWithRole(user, MemberRoles.ADMIN);

    // Create some projects
    const project1 = await fakeCollective({
      type: CollectiveType.PROJECT,
      ParentCollectiveId: collective.id,
      CreatedByUserId: user.id,
    });

    const project2 = await fakeCollective({
      type: CollectiveType.PROJECT,
      ParentCollectiveId: collective.id,
      CreatedByUserId: user.id,
    });

    const event = await fakeEvent({
      ParentCollectiveId: collective.id,
      CreatedByUserId: user.id,
    });

    // Run the conversion
    await runConvert(collective.slug, { isDryRun: false, projectsToCollectives: true });

    // Verify the main collective was converted
    const updatedCollective = await collective.reload();
    expect(updatedCollective.type).to.equal(CollectiveType.ORGANIZATION);
    expect(updatedCollective.hasMoneyManagement).to.be.true;

    // Verify projects were converted
    const updatedProject1 = await project1.reload();
    const updatedProject2 = await project2.reload();

    expect(updatedProject1.type).to.equal(CollectiveType.COLLECTIVE);
    expect(updatedProject1.ParentCollectiveId).to.be.null;
    expect(updatedProject2.type).to.equal(CollectiveType.COLLECTIVE);
    expect(updatedProject2.ParentCollectiveId).to.be.null;

    // Verify event are unchanged
    const updatedEvent = await event.reload();
    expect(updatedEvent.type).to.equal(CollectiveType.EVENT);
    expect(updatedEvent.ParentCollectiveId).to.equal(collective.id);

    // Verify admin members were copied to projects
    const project1Admins = await updatedProject1.getAdminMembers();
    const project2Admins = await updatedProject2.getAdminMembers();

    expect(project1Admins).to.have.lengthOf(1);
    expect(project2Admins).to.have.lengthOf(1);
    expect(project1Admins[0].MemberCollectiveId).to.equal(user.CollectiveId);
    expect(project2Admins[0].MemberCollectiveId).to.equal(user.CollectiveId);
  });

  it('runs in dry run mode without making changes', async () => {
    // Create test data
    const user = await fakeUser();
    const collective = await fakeCollective({
      type: CollectiveType.COLLECTIVE,
      hasMoneyManagement: false,
      HostCollectiveId: null,
      CreatedByUserId: user.id,
    });
    await collective.update({ HostCollectiveId: collective.id }); // Make it independent

    const project = await fakeCollective({
      type: CollectiveType.PROJECT,
      ParentCollectiveId: collective.id,
      CreatedByUserId: user.id,
    });

    // Run in dry run mode
    await runConvert(collective.slug, { isDryRun: true, projectsToCollectives: true });

    // Verify no changes were made
    const updatedCollective = await collective.reload();
    const updatedProject = await project.reload();

    expect(updatedCollective.type).to.equal(CollectiveType.COLLECTIVE);
    expect(updatedCollective.hasMoneyManagement).to.be.false;
    expect(updatedProject.type).to.equal(CollectiveType.PROJECT);
    expect(updatedProject.ParentCollectiveId).to.equal(collective.id);
  });

  it('throws an error if collective is not found', async () => {
    await expect(
      runConvert('non-existent-collective', { isDryRun: false, projectsToCollectives: false }),
    ).to.be.rejectedWith('Account with slug non-existent-collective not found');
  });

  it('throws an error if collective is not independent', async () => {
    const collective = await fakeCollective({
      type: CollectiveType.COLLECTIVE,
      hasMoneyManagement: false,
    });

    await expect(runConvert(collective.slug, { isDryRun: false, projectsToCollectives: false })).to.be.rejectedWith(
      `Account with slug ${collective.slug} is not an independent collective`,
    );
  });

  it('throws an error if not a collective', async () => {
    const org = await fakeOrganization();
    await expect(runConvert(org.slug, { isDryRun: false, projectsToCollectives: false })).to.be.rejectedWith(
      `Account with slug ${org.slug} is not an independent collective`,
    );

    const project = await fakeProject();
    await expect(runConvert(project.slug, { isDryRun: false, projectsToCollectives: false })).to.be.rejectedWith(
      `Account with slug ${project.slug} is not an independent collective`,
    );

    const event = await fakeEvent();
    await expect(runConvert(event.slug, { isDryRun: false, projectsToCollectives: false })).to.be.rejectedWith(
      `Account with slug ${event.slug} is not an independent collective`,
    );
  });

  it('converts without projects if projectsToCollectives is false', async () => {
    // Create test data
    const user = await fakeUser();
    const collective = await fakeCollective({
      type: CollectiveType.COLLECTIVE,
      hasMoneyManagement: false,
      HostCollectiveId: null,
      CreatedByUserId: user.id,
    });
    await collective.update({ HostCollectiveId: collective.id }); // Make it independent

    const project = await fakeCollective({
      type: CollectiveType.PROJECT,
      ParentCollectiveId: collective.id,
      CreatedByUserId: user.id,
    });

    // Run conversion without project conversion
    await runConvert(collective.slug, { isDryRun: false, projectsToCollectives: false });

    // Verify main collective was converted
    const updatedCollective = await collective.reload();
    expect(updatedCollective.type).to.equal(CollectiveType.ORGANIZATION);
    expect(updatedCollective.hasMoneyManagement).to.be.true;

    // Verify project was not converted
    const updatedProject = await project.reload();
    expect(updatedProject.type).to.equal(CollectiveType.PROJECT);
    expect(updatedProject.ParentCollectiveId).to.equal(collective.id);
  });
});
