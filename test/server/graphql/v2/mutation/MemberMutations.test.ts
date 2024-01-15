import { expect } from 'chai';
import gql from 'fake-tag';
import { describe, it } from 'mocha';

import ActivityTypes from '../../../../../server/constants/activities';
import roles from '../../../../../server/constants/roles';
import MemberRoles from '../../../../../server/constants/roles';
import { idEncode, IDENTIFIER_TYPES } from '../../../../../server/graphql/v2/identifiers';
import models, { Member } from '../../../../../server/models';
import { fakeCollective, fakeMember, fakeUser } from '../../../../test-helpers/fake-data';
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
    it('can only update role to accountant, admin or member', async () => {
      [roles.ADMIN, roles.MEMBER, roles.ACCOUNTANT, roles.HOST].forEach(async role => {
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
          expect(result.errors[0].message).to.equal('You can only edit accountants, admins, or members.');
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
      expect(result.data.removeMember).to.equal(true);
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
    it('can only remove members with role accountant, admin or member', async () => {
      const randomAdminUser = await fakeUser();
      const randomMemberUser = await fakeUser();
      const randomAccountantUser = await fakeUser();
      const randomBackerUser = await fakeUser();
      await collective.addUserWithRole(randomAdminUser, roles.ADMIN);
      await collective.addUserWithRole(randomMemberUser, roles.MEMBER);
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
      expect(removeBackerUserResult.errors[0].message).to.equal('You can only remove accountants, admins, or members.');
    });
  });

  describe('follow', () => {
    const followMutation = gql`
      mutation FollowCollective($account: AccountReferenceInput!) {
        followAccount(account: $account) {
          member {
            id
            role
          }
          individual {
            memberOf(role: [FOLLOWER]) {
              nodes {
                id
              }
            }
          }
        }
      }
    `;

    it('follows new account', async () => {
      const collective = await fakeCollective();
      const user = await fakeUser();

      const result = await utils.graphqlQueryV2(
        followMutation,
        {
          account: { id: idEncode(collective.id, IDENTIFIER_TYPES.ACCOUNT) },
        },
        user,
      );

      expect(result.errors).to.not.exist;
      expect(result.data.followAccount.member.role).to.equal(MemberRoles.FOLLOWER);
      expect(result.data.followAccount.individual.memberOf.nodes).to.have.length(1);

      const followers = await Member.findAll({
        where: {
          MemberCollectiveId: user.collective.id,
          CollectiveId: collective.id,
          role: MemberRoles.FOLLOWER,
        },
      });

      expect(followers).to.have.length(1);
    });

    it('tries to follow account again', async () => {
      const collective = await fakeCollective();
      const user = await fakeUser();

      const member = await fakeMember({
        CollectiveId: collective.id,
        MemberCollectiveId: user.collective.id,
        role: MemberRoles.FOLLOWER,
      });

      const result = await utils.graphqlQueryV2(
        followMutation,
        {
          account: { id: idEncode(collective.id, IDENTIFIER_TYPES.ACCOUNT) },
        },
        user,
      );

      expect(result.errors).to.not.exist;
      expect(result.data.followAccount.member.role).to.equal(MemberRoles.FOLLOWER);
      expect(result.data.followAccount.member.id).to.equal(idEncode(member.id, IDENTIFIER_TYPES.MEMBER));

      expect(result.data.followAccount.individual.memberOf.nodes).to.have.length(1);
      expect(result.data.followAccount.individual.memberOf.nodes[0].id).to.equal(
        idEncode(member.id, IDENTIFIER_TYPES.MEMBER),
      );

      const followers = await Member.findAll({
        where: {
          MemberCollectiveId: user.collective.id,
          CollectiveId: collective.id,
          role: MemberRoles.FOLLOWER,
        },
      });

      expect(followers).to.have.length(1);
    });

    it('creates only one follow member', async () => {
      const collective = await fakeCollective();
      const user = await fakeUser();

      const member = await fakeMember({
        CollectiveId: collective.id,
        MemberCollectiveId: user.collective.id,
        role: MemberRoles.FOLLOWER,
        deletedAt: new Date(),
      });

      let memberRecords = await Member.findAll({
        where: {
          MemberCollectiveId: user.collective.id,
          CollectiveId: collective.id,
          role: MemberRoles.FOLLOWER,
        },
        paranoid: false,
      });
      expect(memberRecords).to.have.length(1);

      const result = await utils.graphqlQueryV2(
        followMutation,
        {
          account: { id: idEncode(collective.id, IDENTIFIER_TYPES.ACCOUNT) },
        },
        user,
      );

      expect(result.errors).to.not.exist;
      expect(result.data.followAccount.member.role).to.equal(MemberRoles.FOLLOWER);
      expect(result.data.followAccount.member.id).to.equal(idEncode(member.id, IDENTIFIER_TYPES.MEMBER));

      expect(result.data.followAccount.individual.memberOf.nodes).to.have.length(1);
      expect(result.data.followAccount.individual.memberOf.nodes[0].id).to.equal(
        idEncode(member.id, IDENTIFIER_TYPES.MEMBER),
      );

      const followers = await Member.findAll({
        where: {
          MemberCollectiveId: user.collective.id,
          CollectiveId: collective.id,
          role: MemberRoles.FOLLOWER,
        },
      });

      expect(followers).to.have.length(1);

      memberRecords = await Member.findAll({
        where: {
          MemberCollectiveId: user.collective.id,
          CollectiveId: collective.id,
          role: MemberRoles.FOLLOWER,
        },
        paranoid: false,
      });
      expect(memberRecords).to.have.length(1);
    });
  });

  describe('unfollow', () => {
    const unfollowMutation = gql`
      mutation UnfollowCollective($account: AccountReferenceInput!) {
        unfollowAccount(account: $account) {
          member {
            id
          }
          individual {
            id
            memberOf(role: [FOLLOWER]) {
              nodes {
                id
              }
            }
          }
        }
      }
    `;

    it('handles unfollowing account', async () => {
      const collective = await fakeCollective();
      const collective2 = await fakeCollective();
      const user = await fakeUser();

      await fakeMember({
        CollectiveId: collective.id,
        MemberCollectiveId: user.collective.id,
        role: MemberRoles.FOLLOWER,
      });

      const member2 = await fakeMember({
        CollectiveId: collective2.id,
        MemberCollectiveId: user.collective.id,
        role: MemberRoles.FOLLOWER,
      });

      const result = await utils.graphqlQueryV2(
        unfollowMutation,
        {
          account: { id: idEncode(collective.id, IDENTIFIER_TYPES.ACCOUNT) },
        },
        user,
      );

      expect(result.errors).to.not.exist;
      expect(result.data.unfollowAccount.individual.memberOf.nodes).to.have.length(1);
      expect(result.data.unfollowAccount.individual.memberOf.nodes[0].id).to.eq(
        idEncode(member2.id, IDENTIFIER_TYPES.MEMBER),
      );
    });

    it('handles unfollowing account without follow', async () => {
      const collective = await fakeCollective();
      const user = await fakeUser();

      const result = await utils.graphqlQueryV2(
        unfollowMutation,
        {
          account: { id: idEncode(collective.id, IDENTIFIER_TYPES.ACCOUNT) },
        },
        user,
      );

      expect(result.errors).to.not.exist;
      expect(result.data.unfollowAccount.individual.memberOf.nodes).to.have.length(0);

      const followers = await Member.findAll({
        where: {
          MemberCollectiveId: user.collective.id,
          CollectiveId: collective.id,
          role: MemberRoles.FOLLOWER,
        },
      });

      expect(followers).to.have.length(0);
    });
  });
});
