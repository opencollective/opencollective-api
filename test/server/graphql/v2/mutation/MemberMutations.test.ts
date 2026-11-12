import { expect } from 'chai';
import gql from 'fake-tag';
import { describe, it } from 'mocha';

import ActivityTypes from '../../../../../server/constants/activities';
import roles from '../../../../../server/constants/roles';
import { idEncode, IDENTIFIER_TYPES } from '../../../../../server/graphql/v2/identifiers';
import models from '../../../../../server/models';
import { fakeCollective, fakePersonalToken, fakeProject, fakeUser } from '../../../../test-helpers/fake-data';
import * as utils from '../../../../utils';

let collectiveAdminUser, collectiveMemberUser, collective;

describe('memberMutations', () => {
  before(async () => {
    await utils.resetTestDB();
    collectiveAdminUser = await fakeUser();
    collectiveMemberUser = await fakeUser();
    collective = await fakeCollective({ admin: collectiveAdminUser });
    await collective.addUserWithRole(collectiveMemberUser, roles.MEMBER);
  });
  describe('editMember', () => {
    const editMemberMutation = gql`
      mutation EditMember(
        $memberAccount: AccountReferenceInput!
        $account: AccountReferenceInput!
        $role: MemberRole
        $description: String
        $since: DateTime
      ) {
        editMember(
          memberAccount: $memberAccount
          account: $account
          role: $role
          description: $description
          since: $since
        ) {
          id
          role
          description
          since
        }
      }
    `;
    it('should edit a member role, description and since and document the changes in an activity', async () => {
      const result = await utils.graphqlQueryV2(
        editMemberMutation,
        {
          memberAccount: { id: idEncode(collectiveMemberUser.CollectiveId, IDENTIFIER_TYPES.ACCOUNT) },
          account: { id: idEncode(collective.id, IDENTIFIER_TYPES.ACCOUNT) },
          description: 'role changed to ACCOUNTANT',
          role: roles.ACCOUNTANT,
          since: new Date('01 January 2022').toISOString(),
        },
        collectiveAdminUser,
      );

      const activity = await models.Activity.findAll({
        where: {
          type: ActivityTypes.COLLECTIVE_CORE_MEMBER_EDITED,
          CollectiveId: collective.id,
        },
      });
      const editedMember = result.data.editMember;

      expect(result.errors).to.not.exist;
      expect(activity.length).to.equal(1);
      expect(activity[0].data.memberCollective.id).to.equal(collectiveMemberUser.id);
      expect(editedMember.role).to.equal(roles.ACCOUNTANT);
      expect(editedMember.description).to.equal('role changed to ACCOUNTANT');
      expect(editedMember.since.toISOString()).to.equal(new Date('01 January 2022').toISOString());
    });
    it('must be authenticated as an admin of the collective', async () => {
      const randomUser = await fakeUser();
      const result = await utils.graphqlQueryV2(
        editMemberMutation,
        {
          memberAccount: { id: idEncode(collectiveMemberUser.CollectiveId, IDENTIFIER_TYPES.ACCOUNT) },
          account: { id: idEncode(collective.id, IDENTIFIER_TYPES.ACCOUNT) },
          description: 'role changed to ACCOUNTANT by a random user',
          role: roles.ACCOUNTANT,
          since: new Date('01 January 2022').toISOString(),
        },
        randomUser,
      );
      expect(result.errors).to.have.length(1);
      expect(result.errors[0].message).to.equal('Only admins can edit members.');
    });
    it('must not change the role of the last admin', async () => {
      const result = await utils.graphqlQueryV2(
        editMemberMutation,
        {
          memberAccount: { id: idEncode(collectiveAdminUser.CollectiveId, IDENTIFIER_TYPES.ACCOUNT) },
          account: { id: idEncode(collective.id, IDENTIFIER_TYPES.ACCOUNT) },
          description: 'collectiveAdminUser(last admin) role changed to ACCOUNTANT',
          role: roles.ACCOUNTANT,
          since: new Date('01 January 2022').toISOString(),
        },
        collectiveAdminUser,
      );
      expect(result.errors).to.have.length(1);
      expect(result.errors[0].message).to.equal('There must be at least one admin for the account.');
    });
    it('can only update role to accountant, admin, community manager or member', async () => {
      [roles.ADMIN, roles.MEMBER, roles.COMMUNITY_MANAGER, roles.ACCOUNTANT, roles.HOST].forEach(async role => {
        const result = await utils.graphqlQueryV2(
          editMemberMutation,
          {
            memberAccount: { id: idEncode(collectiveMemberUser.CollectiveId, IDENTIFIER_TYPES.ACCOUNT) },
            account: { id: idEncode(collective.id, IDENTIFIER_TYPES.ACCOUNT) },
            description: `role changed to ${role}`,
            role,
            since: new Date('01 January 2022').toISOString(),
          },
          collectiveAdminUser,
        );

        if (role === roles.HOST) {
          expect(result.errors).to.have.length(1);
          expect(result.errors[0].message).to.equal(
            'You can only edit accountants, admins, members, or community managers.',
          );
        } else {
          expect(result.errors).to.not.exist;
          expect(result.data.editMember.role).to.equal(role);
          expect(result.data.editMember.description).to.equal(`role changed to ${role}`);
        }
      });
    });
  });

  describe('removeMember', () => {
    const removeMemberMutation = gql`
      mutation RemoveMember(
        $memberAccount: AccountReferenceInput!
        $account: AccountReferenceInput!
        $role: MemberRole!
        $isInvitation: Boolean
      ) {
        removeMember(memberAccount: $memberAccount, account: $account, role: $role, isInvitation: $isInvitation)
      }
    `;
    it('should remove a member from the collective and document the change in an activity', async () => {
      const randomUser = await fakeUser();
      await collective.addUserWithRole(randomUser, roles.MEMBER);
      const personalToken = await fakePersonalToken({ UserId: randomUser.id, CollectiveId: collective.id });

      const result = await utils.graphqlQueryV2(
        removeMemberMutation,
        {
          memberAccount: { id: idEncode(randomUser.CollectiveId, IDENTIFIER_TYPES.ACCOUNT) },
          account: { id: idEncode(collective.id, IDENTIFIER_TYPES.ACCOUNT) },
          description: 'user 2 role changed to ACCOUNTANT',
          role: roles.MEMBER,
        },
        collectiveAdminUser,
      );

      const activity = await models.Activity.findAll({
        where: {
          type: ActivityTypes.COLLECTIVE_CORE_MEMBER_REMOVED,
          CollectiveId: collective.id,
        },
      });

      expect(result.errors).to.not.exist;
      expect(activity.length).to.equal(1);
      expect(activity[0].data.memberCollective.id).to.equal(randomUser.CollectiveId);
      expect(activity[0].data.member.MemberCollectiveId).to.equal(randomUser.CollectiveId);
      expect(activity[0].data.member.CollectiveId).to.equal(collective.id);
      expect(result.data.removeMember).to.equal(true);

      await personalToken.reload({ paranoid: false });
      expect(personalToken.deletedAt).to.not.be.null;
    });
    it('should remove the invitation (if not accepted yet)', async () => {
      const randomInvitedUser = await fakeUser();
      const invitation = await models.MemberInvitation.invite(collective, {
        role: roles.MEMBER,
        description: 'invite user to delete invitation test case',
        MemberCollectiveId: randomInvitedUser.CollectiveId,
        CreatedByUserId: collectiveAdminUser.id,
      });
      const result = await utils.graphqlQueryV2(
        removeMemberMutation,
        {
          memberAccount: { id: idEncode(randomInvitedUser.CollectiveId, IDENTIFIER_TYPES.ACCOUNT) },
          account: { id: idEncode(collective.id, IDENTIFIER_TYPES.ACCOUNT) },
          description: 'invite user to delete invitation test case',
          role: roles.MEMBER,
          isInvitation: true,
        },
        collectiveAdminUser,
      );

      expect(result.errors).to.not.exist;
      expect(result.data.removeMember).to.equal(true);
      await invitation.reload({ paranoid: false });
      expect(invitation.deletedAt).to.not.be.null;
    });
    it('must be authenticated as an admin of the collective', async () => {
      const randomUser = await fakeUser();
      const result = await utils.graphqlQueryV2(
        removeMemberMutation,
        {
          memberAccount: { id: idEncode(collectiveMemberUser.CollectiveId, IDENTIFIER_TYPES.ACCOUNT) },
          account: { id: idEncode(collective.id, IDENTIFIER_TYPES.ACCOUNT) },
          description: 'role changed to ACCOUNTANT',
          role: roles.MEMBER,
        },
        randomUser,
      );
      expect(result.errors).to.have.length(1);
      expect(result.errors[0].message).to.equal('Only admins can remove a member.');
    });
    it('must not remove the last admin when they hold several admin rows', async () => {
      // A sole admin who is also an accountant ends up with two ADMIN rows after `editMember(role: ADMIN)`
      const adminUser = await fakeUser();
      const account = await fakeCollective({ admin: adminUser, HostCollectiveId: null, approvedAt: null });
      await account.addUserWithRole(adminUser, roles.ACCOUNTANT);
      const memberAccount = { id: idEncode(adminUser.CollectiveId, IDENTIFIER_TYPES.ACCOUNT) };
      const accountRef = { id: idEncode(account.id, IDENTIFIER_TYPES.ACCOUNT) };

      const editResult = await utils.graphqlQueryV2(
        gql`
          mutation EditMember($memberAccount: AccountReferenceInput!, $account: AccountReferenceInput!) {
            editMember(memberAccount: $memberAccount, account: $account, role: ADMIN) {
              id
            }
          }
        `,
        { memberAccount, account: accountRef },
        adminUser,
      );
      expect(editResult.errors).to.not.exist;
      expect(await models.Member.count({ where: { CollectiveId: account.id, role: roles.ADMIN } })).to.equal(2);

      const result = await utils.graphqlQueryV2(
        removeMemberMutation,
        { memberAccount, account: accountRef, role: roles.ADMIN },
        adminUser,
      );
      expect(result.errors).to.have.length(1);
      expect(result.errors[0].message).to.equal('There must be at least one admin for the account.');
      expect(await models.Member.count({ where: { CollectiveId: account.id, role: roles.ADMIN } })).to.equal(2);
    });
    it('can remove the admin role on a project when the member stays admin through the parent', async () => {
      const adminUser = await fakeUser();
      const parent = await fakeCollective({ admin: adminUser, HostCollectiveId: null, approvedAt: null });
      const project = await fakeProject({ ParentCollectiveId: parent.id, HostCollectiveId: null, approvedAt: null });
      await project.addUserWithRole(adminUser, roles.ADMIN);

      const result = await utils.graphqlQueryV2(
        removeMemberMutation,
        {
          memberAccount: { id: idEncode(adminUser.CollectiveId, IDENTIFIER_TYPES.ACCOUNT) },
          account: { id: idEncode(project.id, IDENTIFIER_TYPES.ACCOUNT) },
          role: roles.ADMIN,
        },
        adminUser,
      );
      expect(result.errors).to.not.exist;
      expect(result.data.removeMember).to.equal(true);
      expect(await models.Member.count({ where: { CollectiveId: project.id, role: roles.ADMIN } })).to.equal(0);
    });
    it('can only remove members with role accountant, admin, community manager or member', async () => {
      const randomAdminUser = await fakeUser();
      const randomMemberUser = await fakeUser();
      const randomCommunityManagerUser = await fakeUser();
      const randomAccountantUser = await fakeUser();
      const randomBackerUser = await fakeUser();
      await collective.addUserWithRole(randomAdminUser, roles.ADMIN);
      await collective.addUserWithRole(randomMemberUser, roles.MEMBER);
      await collective.addUserWithRole(randomCommunityManagerUser, roles.COMMUNITY_MANAGER);
      await collective.addUserWithRole(randomAccountantUser, roles.ACCOUNTANT);
      await collective.addUserWithRole(randomBackerUser, roles.BACKER);

      const removeAdminUserResult = await utils.graphqlQueryV2(
        removeMemberMutation,
        {
          memberAccount: { id: idEncode(randomAdminUser.CollectiveId, IDENTIFIER_TYPES.ACCOUNT) },
          account: { id: idEncode(collective.id, IDENTIFIER_TYPES.ACCOUNT) },
          description: 'ADMIN User',
          role: roles.ADMIN,
        },
        collectiveAdminUser,
      );
      expect(removeAdminUserResult.errors).to.not.exist;
      expect(removeAdminUserResult.data.removeMember).to.equal(true);

      const removeMemberUserResult = await utils.graphqlQueryV2(
        removeMemberMutation,
        {
          memberAccount: { id: idEncode(randomMemberUser.CollectiveId, IDENTIFIER_TYPES.ACCOUNT) },
          account: { id: idEncode(collective.id, IDENTIFIER_TYPES.ACCOUNT) },
          description: 'MEMBER User',
          role: roles.MEMBER,
        },
        collectiveAdminUser,
      );
      expect(removeMemberUserResult.errors).to.not.exist;
      expect(removeMemberUserResult.data.removeMember).to.equal(true);

      const removeCommunityManagerUserResult = await utils.graphqlQueryV2(
        removeMemberMutation,
        {
          memberAccount: { id: idEncode(randomCommunityManagerUser.CollectiveId, IDENTIFIER_TYPES.ACCOUNT) },
          account: { id: idEncode(collective.id, IDENTIFIER_TYPES.ACCOUNT) },
          description: 'COMMUNITY_MANAGER User',
          role: roles.COMMUNITY_MANAGER,
        },
        collectiveAdminUser,
      );

      removeCommunityManagerUserResult.errors && console.error(removeCommunityManagerUserResult.errors);
      expect(removeCommunityManagerUserResult.errors).to.not.exist;
      expect(removeCommunityManagerUserResult.data.removeMember).to.equal(true);

      const removeAccountantUserResult = await utils.graphqlQueryV2(
        removeMemberMutation,
        {
          memberAccount: { id: idEncode(randomAccountantUser.CollectiveId, IDENTIFIER_TYPES.ACCOUNT) },
          account: { id: idEncode(collective.id, IDENTIFIER_TYPES.ACCOUNT) },
          description: 'ACCOUNTANT User',
          role: roles.ACCOUNTANT,
        },
        collectiveAdminUser,
      );
      expect(removeAccountantUserResult.errors).to.not.exist;
      expect(removeAccountantUserResult.data.removeMember).to.equal(true);

      const removeBackerUserResult = await utils.graphqlQueryV2(
        removeMemberMutation,
        {
          memberAccount: { id: idEncode(randomBackerUser.CollectiveId, IDENTIFIER_TYPES.ACCOUNT) },
          account: { id: idEncode(collective.id, IDENTIFIER_TYPES.ACCOUNT) },
          description: 'BACKER User',
          role: roles.BACKER,
        },
        collectiveAdminUser,
      );
      expect(removeBackerUserResult.errors).to.have.length(1);
      expect(removeBackerUserResult.errors[0].message).to.equal(
        'You can only remove accountants, admins, members, or community managers.',
      );
    });
  });

  describe('when the team is locked', () => {
    const editMemberMutation = gql`
      mutation EditMemberLocked(
        $memberAccount: AccountReferenceInput!
        $account: AccountReferenceInput!
        $role: MemberRole
      ) {
        editMember(memberAccount: $memberAccount, account: $account, role: $role) {
          id
        }
      }
    `;

    const removeMemberMutation = gql`
      mutation RemoveMemberLocked(
        $memberAccount: AccountReferenceInput!
        $account: AccountReferenceInput!
        $role: MemberRole!
        $isInvitation: Boolean
      ) {
        removeMember(memberAccount: $memberAccount, account: $account, role: $role, isInvitation: $isInvitation)
      }
    `;

    const setupAccount = async () => {
      const admin = await fakeUser();
      const member = await fakeUser();
      const account = await fakeCollective({ admin });
      await account.addUserWithRole(member, roles.MEMBER);
      return { admin, member, account };
    };

    const editMember = (account, member, admin) =>
      utils.graphqlQueryV2(
        editMemberMutation,
        {
          memberAccount: { legacyId: member.CollectiveId },
          account: { legacyId: account.id },
          role: roles.ADMIN,
        },
        admin,
      );

    const removeMember = (account, member, admin) =>
      utils.graphqlQueryV2(
        removeMemberMutation,
        { memberAccount: { legacyId: member.CollectiveId }, account: { legacyId: account.id }, role: roles.MEMBER },
        admin,
      );

    const expectTeamLocked = result => {
      expect(result.errors).to.have.length(1);
      expect(result.errors[0].extensions.code).to.equal('TeamLocked');
    };

    it('cannot edit or remove members of a frozen account', async () => {
      const { admin, member, account } = await setupAccount();
      await account.freeze('Frozen for audit', false);

      expectTeamLocked(await editMember(account, member, admin));
      expectTeamLocked(await removeMember(account, member, admin));

      const membership = await models.Member.findOne({
        where: { CollectiveId: account.id, MemberCollectiveId: member.CollectiveId },
      });
      expect(membership.role).to.equal(roles.MEMBER);

      // Unfreezing restores the ability to edit the team
      await account.reload();
      await account.unfreeze('Unfrozen', 'Unfrozen');
      const result = await editMember(account, member, admin);
      expect(result.errors).to.not.exist;
    });

    it('cannot edit or remove members when the TEAM feature is disabled', async () => {
      const { admin, member, account } = await setupAccount();
      await account.update({ data: { features: { TEAM: false } } });
      expectTeamLocked(await editMember(account, member, admin));
      expectTeamLocked(await removeMember(account, member, admin));
    });

    it('cannot edit members of a project when the team of the parent is locked', async () => {
      const { admin, account } = await setupAccount();
      const project = await fakeProject({ ParentCollectiveId: account.id });
      const projectMember = await fakeUser();
      await project.addUserWithRole(projectMember, roles.MEMBER);
      await account.update({ data: { features: { TEAM: false } } });
      expectTeamLocked(await editMember(project, projectMember, admin));
    });

    it('can still cancel a pending invitation', async () => {
      const { admin, account } = await setupAccount();
      const invitedUser = await fakeUser();
      const invitation = await models.MemberInvitation.invite(account, {
        role: roles.MEMBER,
        MemberCollectiveId: invitedUser.CollectiveId,
        CreatedByUserId: admin.id,
      });
      await account.freeze('Frozen for audit', false);

      const result = await utils.graphqlQueryV2(
        removeMemberMutation,
        {
          memberAccount: { legacyId: invitedUser.CollectiveId },
          account: { legacyId: account.id },
          role: roles.MEMBER,
          isInvitation: true,
        },
        admin,
      );

      expect(result.errors).to.not.exist;
      await invitation.reload({ paranoid: false });
      expect(invitation.deletedAt).to.not.be.null;
    });
  });

  describe('removed follower feature', () => {
    it('does not expose follow mutations or the follower member role', async () => {
      const result = await utils.graphqlQueryV2(
        gql`
          query RemovedFollowerFeature {
            __schema {
              mutationType {
                fields {
                  name
                }
              }
            }
            __type(name: "MemberRole") {
              enumValues {
                name
              }
            }
          }
        `,
        {},
      );

      expect(result.errors).to.not.exist;
      const mutations = result.data.__schema.mutationType.fields.map(field => field.name);
      const memberRoles = result.data.__type.enumValues.map(role => role.name);
      expect(mutations).to.not.include('followAccount');
      expect(mutations).to.not.include('unfollowAccount');
      expect(memberRoles).to.not.include('FOLLOWER');
    });
  });
});
