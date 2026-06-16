import { expect } from 'chai';
import gql from 'fake-tag';
import { omit } from 'lodash';
import { describe, it } from 'mocha';
import { createSandbox } from 'sinon';

import ActivityTypes from '../../../../../server/constants/activities';
import roles from '../../../../../server/constants/roles';
import { idEncode, IDENTIFIER_TYPES } from '../../../../../server/graphql/v2/identifiers';
import emailLib from '../../../../../server/lib/email';
import models from '../../../../../server/models';
import {
  fakeActiveHost,
  fakeCollective,
  fakeMemberInvitation,
  fakeOrganization,
  fakeUser,
} from '../../../../test-helpers/fake-data';
import * as utils from '../../../../utils';

let collectiveAdminUser, collective;
let sandbox, sendEmailSpy;

describe('MemberInvitationMutations', () => {
  before(async () => {
    await utils.resetTestDB();
    sandbox = createSandbox();
    sendEmailSpy = sandbox.spy(emailLib, 'sendMessage');
    collectiveAdminUser = await fakeUser();
    collective = await fakeCollective({ name: 'webpack test collective', admin: collectiveAdminUser });
  });

  after(() => sandbox.restore());

  afterEach(() => {
    sendEmailSpy.resetHistory();
  });

  const inviteMemberMutation = gql`
    mutation InviteMember(
      $memberAccount: AccountReferenceInput!
      $account: AccountReferenceInput!
      $role: MemberRole!
      $description: String
      $since: DateTime
      $privateNote: String
    ) {
      inviteMember(
        memberAccount: $memberAccount
        account: $account
        role: $role
        description: $description
        since: $since
        privateNote: $privateNote
      ) {
        id
        role
        description
        since
      }
    }
  `;

  describe('inviteMember', () => {
    it('should create a new member invitation and its related activity', async () => {
      const randomUserToInvite = await fakeUser();
      const result = await utils.graphqlQueryV2(
        inviteMemberMutation,
        {
          memberAccount: { id: idEncode(randomUserToInvite.collective.id, IDENTIFIER_TYPES.ACCOUNT) },
          account: { id: idEncode(collective.id, IDENTIFIER_TYPES.ACCOUNT) },
          description: 'new user 2 as MEMBER',
          role: roles.MEMBER,
          since: new Date('01 January 2022').toISOString(),
        },
        collectiveAdminUser,
      );
      await utils.waitForCondition(() => sendEmailSpy.callCount);

      const activity = await models.Activity.findAll({
        where: {
          type: ActivityTypes.COLLECTIVE_CORE_MEMBER_INVITED,
          CollectiveId: collective.id,
        },
      });
      const createdMemberInvitation = result.data.inviteMember;

      expect(result.errors).to.not.exist;
      expect(activity.length).to.equal(1);
      expect(activity[0].data.memberCollective.id).to.equal(randomUserToInvite.collective.id);
      expect(createdMemberInvitation.role).to.equal(roles.MEMBER);
      expect(createdMemberInvitation.description).to.equal('new user 2 as MEMBER');
      expect(createdMemberInvitation.since.toISOString()).to.equal(new Date('01 January 2022').toISOString());
      expect(sendEmailSpy.callCount).to.equal(1);
      expect(sendEmailSpy.args[0][1]).to.equal('Invitation to join webpack test collective on Open Collective');
    });

    it('attaches a sanitized private note to the invitation email activity', async () => {
      const randomUserToInvite = await fakeUser();
      const result = await utils.graphqlQueryV2(
        inviteMemberMutation,
        {
          memberAccount: { id: idEncode(randomUserToInvite.collective.id, IDENTIFIER_TYPES.ACCOUNT) },
          account: { id: idEncode(collective.id, IDENTIFIER_TYPES.ACCOUNT) },
          role: roles.MEMBER,
          privateNote: '<script>alert(1)</script>Hi there!\nWelcome aboard.',
        },
        collectiveAdminUser,
      );
      await utils.waitForCondition(() => sendEmailSpy.callCount);

      expect(result.errors).to.not.exist;

      const emailActivity = await models.Activity.findOne({
        where: {
          type: ActivityTypes.COLLECTIVE_MEMBER_INVITED,
          CollectiveId: collective.id,
          FromCollectiveId: randomUserToInvite.collective.id,
        },
      });
      expect(emailActivity).to.exist;
      expect(emailActivity.data.privateNote).to.equal('Hi there!\nWelcome aboard.');

      // Ensure the note is NOT persisted on the MemberInvitation record
      const invitation = await models.MemberInvitation.findOne({
        where: { CollectiveId: collective.id, MemberCollectiveId: randomUserToInvite.collective.id },
      });
      expect(invitation).to.exist;
      expect(invitation).to.not.have.property('privateNote');
      // Ensure the email was actually sent and contains the note
      expect(sendEmailSpy.callCount).to.equal(1);
      expect(sendEmailSpy.args[0][2]).to.include('Hi there!');
      expect(sendEmailSpy.args[0][2]).to.not.include('<script>');
    });

    it('must be authenticated as an admin of the collective', async () => {
      const randomUser = await fakeUser();
      const anotherRandomUser = await fakeUser();
      const result = await utils.graphqlQueryV2(
        inviteMemberMutation,
        {
          memberAccount: { id: idEncode(anotherRandomUser.CollectiveId, IDENTIFIER_TYPES.ACCOUNT) },
          account: { id: idEncode(collective.id, IDENTIFIER_TYPES.ACCOUNT) },
          description: 'new user 2 as MEMBER',
          role: roles.MEMBER,
          since: new Date('01 January 2022').toISOString(),
        },
        randomUser,
      );
      expect(sendEmailSpy.callCount).to.equal(0);
      expect(result.errors).to.have.length(1);
      expect(result.errors[0].message).to.equal('Only admins can send an invitation.');
    });

    it('allows a fiscal host admin to invite a member when the collective has no admins', async () => {
      const hostAdminUser = await fakeUser();
      const host = await fakeActiveHost({ admin: hostAdminUser });
      const hostedCollective = await fakeCollective({ HostCollectiveId: host.id, admin: null });
      // Remove any auto-created admin member so the collective truly has no admins
      await models.Member.destroy({ where: { CollectiveId: hostedCollective.id, role: roles.ADMIN } });
      const userToInvite = await fakeUser();

      const result = await utils.graphqlQueryV2(
        inviteMemberMutation,
        {
          memberAccount: { id: idEncode(userToInvite.collective.id, IDENTIFIER_TYPES.ACCOUNT) },
          account: { id: idEncode(hostedCollective.id, IDENTIFIER_TYPES.ACCOUNT) },
          description: 'invited by host admin',
          role: roles.ADMIN,
          since: new Date('01 January 2022').toISOString(),
        },
        hostAdminUser,
      );

      expect(result.errors).to.not.exist;
      expect(result.data.inviteMember.role).to.equal(roles.ADMIN);
    });

    it('does not allow a fiscal host admin to invite a member when the collective already has an admin', async () => {
      const hostAdminUser = await fakeUser();
      const host = await fakeActiveHost({ admin: hostAdminUser });
      const existingAdminUser = await fakeUser();
      const hostedCollective = await fakeCollective({ HostCollectiveId: host.id, admin: existingAdminUser });
      const userToInvite = await fakeUser();

      const result = await utils.graphqlQueryV2(
        inviteMemberMutation,
        {
          memberAccount: { id: idEncode(userToInvite.collective.id, IDENTIFIER_TYPES.ACCOUNT) },
          account: { id: idEncode(hostedCollective.id, IDENTIFIER_TYPES.ACCOUNT) },
          description: 'should be blocked',
          role: roles.ADMIN,
          since: new Date('01 January 2022').toISOString(),
        },
        hostAdminUser,
      );

      expect(result.errors).to.have.length(1);
      expect(result.errors[0].message).to.equal('Only admins can send an invitation.');
    });

    it('can only add with role accountant, admin, community manager, or member', async () => {
      const validRoles = [roles.ADMIN, roles.MEMBER, roles.COMMUNITY_MANAGER, roles.ACCOUNTANT];
      for (const role of validRoles) {
        const invitedUser = await fakeUser();
        const result = await utils.graphqlQueryV2(
          inviteMemberMutation,
          {
            memberAccount: { id: idEncode(invitedUser.CollectiveId, IDENTIFIER_TYPES.ACCOUNT) },
            account: { id: idEncode(collective.id, IDENTIFIER_TYPES.ACCOUNT) },
            description: 'new user description',
            since: new Date('01 January 2022').toISOString(),
            role,
          },
          collectiveAdminUser,
        );
        await utils.waitForCondition(() => sendEmailSpy.callCount);

        expect(result.errors).to.not.exist;
        expect(result.data.inviteMember.role).to.equal(role);
        expect(result.data.inviteMember.description).to.equal('new user description');
        expect(sendEmailSpy.callCount).to.equal(1);
        expect(sendEmailSpy.args[0][1]).to.equal('Invitation to join webpack test collective on Open Collective');
        sendEmailSpy.resetHistory();
      }

      // Throw error if adding other roles
      const invalidRoles = Object.values(omit(roles, [...validRoles, 'CONNECTED_COLLECTIVE']));
      for (const role of invalidRoles) {
        const invitedUser = await fakeUser();
        const result = await utils.graphqlQueryV2(
          inviteMemberMutation,
          {
            memberAccount: { id: idEncode(invitedUser.id, IDENTIFIER_TYPES.ACCOUNT) },
            account: { id: idEncode(collective.id, IDENTIFIER_TYPES.ACCOUNT) },
            description: 'new user 6 as BACKER',
            since: new Date('01 January 2022').toISOString(),
            role,
          },
          collectiveAdminUser,
        );
        expect(sendEmailSpy.callCount).to.equal(0);
        expect(result.errors).to.have.length(1);
        expect(result.errors[0].message).to.equal('You can only invite accountants, admins, or members.');
      }
    });

    it('can only add with a user account', async () => {
      const randomCollective = await fakeCollective({ admin: collectiveAdminUser });
      const result = await utils.graphqlQueryV2(
        inviteMemberMutation,
        {
          memberAccount: { id: idEncode(randomCollective.id, IDENTIFIER_TYPES.ACCOUNT) },
          account: { id: idEncode(collective.id, IDENTIFIER_TYPES.ACCOUNT) },
          description: 'not a user acccount',
          role: roles.MEMBER,
          since: new Date('01 January 2022').toISOString(),
        },
        collectiveAdminUser,
      );

      expect(sendEmailSpy.callCount).to.equal(0);
      expect(result.errors).to.have.length(1);
      expect(result.errors[0].message).to.equal('You can only invite users.');
    });
  });

  describe('inviteMembers', () => {
    const inviteMembersMutation = gql`
      mutation InviteMembers($account: AccountReferenceInput!, $members: [InviteMemberInput!]!) {
        inviteMembers(account: $account, members: $members) {
          id
          role
          description
          since
        }
      }
    `;

    it('should invite multiple members to an organization', async () => {
      const organization = await fakeOrganization({ admin: collectiveAdminUser });
      const user1 = await fakeUser();
      const user2 = await fakeUser();
      const user3 = await fakeUser();

      const result = await utils.graphqlQueryV2(
        inviteMembersMutation,
        {
          account: { id: idEncode(organization.id, IDENTIFIER_TYPES.ACCOUNT) },
          members: [
            {
              memberAccount: { id: idEncode(user1.collective.id, IDENTIFIER_TYPES.ACCOUNT) },
              role: roles.ADMIN,
              description: 'Admin user 1',
            },
            {
              memberAccount: { id: idEncode(user2.collective.id, IDENTIFIER_TYPES.ACCOUNT) },
              role: roles.MEMBER,
              description: 'Member user 2',
            },
            {
              memberAccount: { id: idEncode(user3.collective.id, IDENTIFIER_TYPES.ACCOUNT) },
              role: roles.ACCOUNTANT,
              description: 'Accountant user 3',
            },
          ],
        },
        collectiveAdminUser,
      );

      expect(result.errors).to.not.exist;
      expect(result.data.inviteMembers).to.exist;
    });

    it('should throw an error if no members are provided', async () => {
      const organization = await fakeOrganization({ admin: collectiveAdminUser });

      const result = await utils.graphqlQueryV2(
        inviteMembersMutation,
        {
          account: { id: idEncode(organization.id, IDENTIFIER_TYPES.ACCOUNT) },
          members: [],
        },
        collectiveAdminUser,
      );

      expect(result.errors).to.have.length(1);
      expect(result.errors[0].message).to.equal('No members to invite provided');
    });

    it('should not allow inviting admins to a user account', async () => {
      const userCollective = collectiveAdminUser.collective;
      const invitedUser = await fakeUser();

      const result = await utils.graphqlQueryV2(
        inviteMembersMutation,
        {
          account: { id: idEncode(userCollective.id, IDENTIFIER_TYPES.ACCOUNT) },
          members: [
            {
              memberAccount: { id: idEncode(invitedUser.collective.id, IDENTIFIER_TYPES.ACCOUNT) },
              role: roles.ADMIN,
            },
          ],
        },
        collectiveAdminUser,
      );

      expect(result.errors).to.have.length(1);
      expect(result.errors[0].message).to.equal('You can only invite admins to an Organization or a Collective.');
    });

    it('allows a fiscal host admin to invite members when the collective has no admins', async () => {
      const hostAdminUser = await fakeUser();
      const host = await fakeActiveHost({ admin: hostAdminUser });
      const hostedCollective = await fakeCollective({ HostCollectiveId: host.id, admin: null });
      await models.Member.destroy({ where: { CollectiveId: hostedCollective.id, role: roles.ADMIN } });
      const userToInvite = await fakeUser();

      const result = await utils.graphqlQueryV2(
        inviteMembersMutation,
        {
          account: { id: idEncode(hostedCollective.id, IDENTIFIER_TYPES.ACCOUNT) },
          members: [
            {
              memberAccount: { id: idEncode(userToInvite.collective.id, IDENTIFIER_TYPES.ACCOUNT) },
              role: roles.ADMIN,
              description: 'host-invited admin',
            },
          ],
        },
        hostAdminUser,
      );

      expect(result.errors).to.not.exist;
      expect(result.data.inviteMembers).to.have.length(1);
      expect(result.data.inviteMembers[0].role).to.equal(roles.ADMIN);
    });

    it('does not allow a fiscal host admin to invite members when the collective already has an admin', async () => {
      const hostAdminUser = await fakeUser();
      const host = await fakeActiveHost({ admin: hostAdminUser });
      const existingAdminUser = await fakeUser();
      const hostedCollective = await fakeCollective({ HostCollectiveId: host.id, admin: existingAdminUser });
      const userToInvite = await fakeUser();

      const result = await utils.graphqlQueryV2(
        inviteMembersMutation,
        {
          account: { id: idEncode(hostedCollective.id, IDENTIFIER_TYPES.ACCOUNT) },
          members: [
            {
              memberAccount: { id: idEncode(userToInvite.collective.id, IDENTIFIER_TYPES.ACCOUNT) },
              role: roles.ADMIN,
            },
          ],
        },
        hostAdminUser,
      );

      expect(result.errors).to.have.length(1);
      expect(result.errors[0].message).to.equal(
        'You need to be an Admin of the provided account in order to invite members.',
      );
    });

    it('must be authenticated as an admin of the account', async () => {
      const organization = await fakeOrganization({ admin: collectiveAdminUser });
      const randomUser = await fakeUser();
      const invitedUser = await fakeUser();

      const result = await utils.graphqlQueryV2(
        inviteMembersMutation,
        {
          account: { id: idEncode(organization.id, IDENTIFIER_TYPES.ACCOUNT) },
          members: [
            {
              memberAccount: { id: idEncode(invitedUser.collective.id, IDENTIFIER_TYPES.ACCOUNT) },
              role: roles.ADMIN,
            },
          ],
        },
        randomUser,
      );

      expect(result.errors).to.have.length(1);
      expect(result.errors[0].message).to.equal(
        'You need to be an Admin of the provided account in order to invite members.',
      );
    });

    it('can only invite with valid roles (admin, accountant, community manager, member)', async () => {
      sendEmailSpy.resetHistory();
      const organization = await fakeOrganization({ admin: collectiveAdminUser });
      const validRoles = [roles.ADMIN, roles.MEMBER, roles.COMMUNITY_MANAGER, roles.ACCOUNTANT];

      for (const role of validRoles) {
        const invitedUser = await fakeUser();
        const result = await utils.graphqlQueryV2(
          inviteMembersMutation,
          {
            account: { id: idEncode(organization.id, IDENTIFIER_TYPES.ACCOUNT) },
            members: [
              {
                memberAccount: { id: idEncode(invitedUser.collective.id, IDENTIFIER_TYPES.ACCOUNT) },
                role,
                description: `Invited as ${role}`,
              },
            ],
          },
          collectiveAdminUser,
        );

        await utils.waitForCondition(() => sendEmailSpy.callCount);
        expect(result.errors).to.not.exist;
        expect(result.data.inviteMembers).to.exist;
        sendEmailSpy.resetHistory();
      }
    });

    it('should invite a new user using memberInfo (email and name)', async () => {
      sendEmailSpy.resetHistory();
      const organization = await fakeOrganization({ admin: collectiveAdminUser });
      const newUserEmail = 'invitedadmin@oc-example.com';
      const newUserName = 'New User';

      const result = await utils.graphqlQueryV2(
        inviteMembersMutation,
        {
          account: { id: idEncode(organization.id, IDENTIFIER_TYPES.ACCOUNT) },
          members: [
            {
              memberInfo: {
                email: newUserEmail,
                name: newUserName,
              },
              role: roles.ADMIN,
              description: 'New admin invited by email',
            },
          ],
        },
        collectiveAdminUser,
      );

      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.inviteMembers).to.exist;
      await utils.waitForCondition(() => sendEmailSpy.callCount);

      const user = await models.User.findOne({ where: { email: newUserEmail } });
      expect(user).to.exist;
      expect(await user.name).to.equal(newUserName);

      expect(sendEmailSpy.callCount).to.equal(1);
      expect(sendEmailSpy.args[0][0]).to.equal(newUserEmail);
      sendEmailSpy.resetHistory();
    });
  });

  describe('editMemberInvitation', async () => {
    const editMemberInvitationMutation = gql`
      mutation EditMemberInvitation(
        $memberAccount: AccountReferenceInput!
        $account: AccountReferenceInput!
        $role: MemberRole
        $description: String
        $since: DateTime
      ) {
        editMemberInvitation(
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

    let invitation;

    before(async () => {
      invitation = await fakeMemberInvitation({
        CollectiveId: collective.id,
        description: 'new user as MEMBER',
        role: roles.MEMBER,
        since: new Date('01 January 2022').toISOString(),
      });
    });

    it('should edit the role, description, and since', async () => {
      const result = await utils.graphqlQueryV2(
        editMemberInvitationMutation,
        {
          memberAccount: { id: idEncode(invitation.MemberCollectiveId, IDENTIFIER_TYPES.ACCOUNT) },
          account: { id: idEncode(collective.id, IDENTIFIER_TYPES.ACCOUNT) },
          description: 'new user 2 with role changed from MEMBER to ADMIN',
          role: roles.ADMIN,
          since: new Date('01 February 2022').toISOString(),
        },
        collectiveAdminUser,
      );

      const editedMemberInvitation = result.data.editMemberInvitation;
      expect(result.errors).to.not.exist;
      expect(editedMemberInvitation.role).to.equal(roles.ADMIN);
      expect(editedMemberInvitation.description).to.equal('new user 2 with role changed from MEMBER to ADMIN');
      expect(editedMemberInvitation.since.toISOString()).to.equal(new Date('01 February 2022').toISOString());
    });

    it('must be authenticated as an admin of the collective', async () => {
      const randomUser = await fakeUser();
      const invitedUser = await invitation.memberCollective.getUser();
      for (const user of [randomUser, invitedUser]) {
        const result = await utils.graphqlQueryV2(
          editMemberInvitationMutation,
          {
            memberAccount: { id: idEncode(invitation.MemberCollectiveId, IDENTIFIER_TYPES.ACCOUNT) },
            account: { id: idEncode(collective.id, IDENTIFIER_TYPES.ACCOUNT) },
            description: 'role changed to MEMBER',
            role: roles.MEMBER,
            since: new Date('01 February 2022').toISOString(),
          },
          user,
        );

        expect(result.errors).to.have.length(1);
        expect(result.errors[0].message).to.equal('Only admins can edit members.');
      }
    });

    it('allows a fiscal host admin to edit an invitation when the collective has no admins', async () => {
      const hostAdminUser = await fakeUser();
      const host = await fakeActiveHost({ admin: hostAdminUser });
      const hostedCollective = await fakeCollective({ HostCollectiveId: host.id, admin: null });
      await models.Member.destroy({ where: { CollectiveId: hostedCollective.id, role: roles.ADMIN } });
      const pendingInvitation = await fakeMemberInvitation({
        CollectiveId: hostedCollective.id,
        role: roles.MEMBER,
        description: 'original description',
      });

      const result = await utils.graphqlQueryV2(
        editMemberInvitationMutation,
        {
          memberAccount: { id: idEncode(pendingInvitation.MemberCollectiveId, IDENTIFIER_TYPES.ACCOUNT) },
          account: { id: idEncode(hostedCollective.id, IDENTIFIER_TYPES.ACCOUNT) },
          description: 'updated by host admin',
          role: roles.ADMIN,
          since: new Date('01 January 2022').toISOString(),
        },
        hostAdminUser,
      );

      expect(result.errors).to.not.exist;
      expect(result.data.editMemberInvitation.role).to.equal(roles.ADMIN);
      expect(result.data.editMemberInvitation.description).to.equal('updated by host admin');
    });

    it('does not allow a fiscal host admin to edit an invitation when the collective already has an admin', async () => {
      const hostAdminUser = await fakeUser();
      const host = await fakeActiveHost({ admin: hostAdminUser });
      const existingAdminUser = await fakeUser();
      const hostedCollective = await fakeCollective({ HostCollectiveId: host.id, admin: existingAdminUser });
      const pendingInvitation = await fakeMemberInvitation({ CollectiveId: hostedCollective.id, role: roles.MEMBER });

      const result = await utils.graphqlQueryV2(
        editMemberInvitationMutation,
        {
          memberAccount: { id: idEncode(pendingInvitation.MemberCollectiveId, IDENTIFIER_TYPES.ACCOUNT) },
          account: { id: idEncode(hostedCollective.id, IDENTIFIER_TYPES.ACCOUNT) },
          description: 'should be blocked',
          role: roles.ADMIN,
          since: new Date('01 January 2022').toISOString(),
        },
        hostAdminUser,
      );

      expect(result.errors).to.have.length(1);
      expect(result.errors[0].message).to.equal('Only admins can edit members.');
    });

    it('can only update role to accountant, admin or member', async () => {
      const validRoles = [roles.ADMIN, roles.MEMBER, roles.ACCOUNTANT, roles.COMMUNITY_MANAGER];
      for (const role of validRoles) {
        const result = await utils.graphqlQueryV2(
          editMemberInvitationMutation,
          {
            memberAccount: { id: idEncode(invitation.MemberCollectiveId, IDENTIFIER_TYPES.ACCOUNT) },
            account: { id: idEncode(collective.id, IDENTIFIER_TYPES.ACCOUNT) },
            description: `role changed to ${role}`,
            since: new Date('01 February 2022').toISOString(),
            role,
          },
          collectiveAdminUser,
        );

        expect(result.errors).to.not.exist;
        const editedMemberInvitation = result.data.editMemberInvitation;
        expect(editedMemberInvitation.role).to.equal(role);
        expect(editedMemberInvitation.description).to.equal(`role changed to ${role}`);
      }

      // Throw error if updating to any other role
      const invalidRoles = Object.values(omit(roles, [...validRoles, 'CONNECTED_COLLECTIVE']));
      for (const role of invalidRoles) {
        const result = await utils.graphqlQueryV2(
          editMemberInvitationMutation,
          {
            memberAccount: { id: idEncode(invitation.MemberCollectiveId, IDENTIFIER_TYPES.ACCOUNT) },
            account: { id: idEncode(collective.id, IDENTIFIER_TYPES.ACCOUNT) },
            description: 'role changed to BACKER',
            since: new Date('01 February 2022').toISOString(),
            role,
          },
          collectiveAdminUser,
        );

        expect(result.errors).to.have.length(1);
        expect(result.errors[0].message).to.equal(
          'You can only edit accountants, admins, members, or community managers.',
        );
      }
    });
  });

  describe('cancelMemberInvitation', () => {
    const cancelByInvitationIdMutation = gql`
      mutation CancelMemberInvitationById($invitation: MemberInvitationReferenceInput!) {
        cancelMemberInvitation(invitation: $invitation)
      }
    `;

    const cancelByAccountMutation = gql`
      mutation CancelMemberInvitationByAccount(
        $account: AccountReferenceInput!
        $memberAccount: AccountReferenceInput!
        $role: MemberRole
      ) {
        cancelMemberInvitation(account: $account, memberAccount: $memberAccount, role: $role)
      }
    `;

    it('allows a collective admin to cancel an invitation by id', async () => {
      const invitation = await fakeMemberInvitation({ CollectiveId: collective.id, role: roles.MEMBER });
      const result = await utils.graphqlQueryV2(
        cancelByInvitationIdMutation,
        { invitation: { id: idEncode(invitation.id, IDENTIFIER_TYPES.MEMBER_INVITATION) } },
        collectiveAdminUser,
      );

      expect(result.errors).to.not.exist;
      expect(result.data.cancelMemberInvitation).to.equal(true);
      expect(await models.MemberInvitation.findByPk(invitation.id)).to.be.null;
    });

    it('allows a collective admin to cancel an invitation by account + memberAccount + role', async () => {
      const invitedUser = await fakeUser();
      const invitation = await fakeMemberInvitation({
        CollectiveId: collective.id,
        MemberCollectiveId: invitedUser.collective.id,
        role: roles.MEMBER,
      });
      const result = await utils.graphqlQueryV2(
        cancelByAccountMutation,
        {
          account: { id: idEncode(collective.id, IDENTIFIER_TYPES.ACCOUNT) },
          memberAccount: { id: idEncode(invitedUser.collective.id, IDENTIFIER_TYPES.ACCOUNT) },
          role: roles.MEMBER,
        },
        collectiveAdminUser,
      );

      expect(result.errors).to.not.exist;
      expect(result.data.cancelMemberInvitation).to.equal(true);
      expect(await models.MemberInvitation.findByPk(invitation.id)).to.be.null;
    });

    it('allows a collective admin to cancel an invitation by account + memberAccount without role', async () => {
      const invitedUser = await fakeUser();
      const invitation = await fakeMemberInvitation({
        CollectiveId: collective.id,
        MemberCollectiveId: invitedUser.collective.id,
        role: roles.ADMIN,
      });
      const result = await utils.graphqlQueryV2(
        cancelByAccountMutation,
        {
          account: { id: idEncode(collective.id, IDENTIFIER_TYPES.ACCOUNT) },
          memberAccount: { id: idEncode(invitedUser.collective.id, IDENTIFIER_TYPES.ACCOUNT) },
        },
        collectiveAdminUser,
      );

      expect(result.errors).to.not.exist;
      expect(result.data.cancelMemberInvitation).to.equal(true);
      expect(await models.MemberInvitation.findByPk(invitation.id)).to.be.null;
    });

    it('allows a fiscal host admin to cancel an invitation when the collective has no admins', async () => {
      const hostAdminUser = await fakeUser();
      const host = await fakeActiveHost({ admin: hostAdminUser });
      const hostedCollective = await fakeCollective({ HostCollectiveId: host.id, admin: null });
      await models.Member.destroy({ where: { CollectiveId: hostedCollective.id, role: roles.ADMIN } });
      const invitedUser = await fakeUser();
      const invitation = await fakeMemberInvitation({
        CollectiveId: hostedCollective.id,
        MemberCollectiveId: invitedUser.collective.id,
        role: roles.ADMIN,
      });

      const result = await utils.graphqlQueryV2(
        cancelByAccountMutation,
        {
          account: { id: idEncode(hostedCollective.id, IDENTIFIER_TYPES.ACCOUNT) },
          memberAccount: { id: idEncode(invitedUser.collective.id, IDENTIFIER_TYPES.ACCOUNT) },
          role: roles.ADMIN,
        },
        hostAdminUser,
      );

      expect(result.errors).to.not.exist;
      expect(result.data.cancelMemberInvitation).to.equal(true);
      expect(await models.MemberInvitation.findByPk(invitation.id)).to.be.null;
    });

    it('does not allow a fiscal host admin to cancel an invitation when the collective already has an admin', async () => {
      const hostAdminUser = await fakeUser();
      const host = await fakeActiveHost({ admin: hostAdminUser });
      const existingAdminUser = await fakeUser();
      const hostedCollective = await fakeCollective({ HostCollectiveId: host.id, admin: existingAdminUser });
      const invitation = await fakeMemberInvitation({ CollectiveId: hostedCollective.id, role: roles.ADMIN });

      const result = await utils.graphqlQueryV2(
        cancelByInvitationIdMutation,
        { invitation: { id: idEncode(invitation.id, IDENTIFIER_TYPES.MEMBER_INVITATION) } },
        hostAdminUser,
      );

      expect(result.errors).to.have.length(1);
      expect(result.errors[0].message).to.equal('Only admins can cancel an invitation.');
    });

    it('does not allow a random user to cancel an invitation', async () => {
      const invitation = await fakeMemberInvitation({ CollectiveId: collective.id, role: roles.MEMBER });
      const randomUser = await fakeUser();

      const result = await utils.graphqlQueryV2(
        cancelByInvitationIdMutation,
        { invitation: { id: idEncode(invitation.id, IDENTIFIER_TYPES.MEMBER_INVITATION) } },
        randomUser,
      );

      expect(result.errors).to.have.length(1);
      expect(result.errors[0].message).to.equal('Only admins can cancel an invitation.');
    });

    it('requires authentication', async () => {
      const invitation = await fakeMemberInvitation({ CollectiveId: collective.id, role: roles.MEMBER });

      const result = await utils.graphqlQueryV2(cancelByInvitationIdMutation, {
        invitation: { id: idEncode(invitation.id, IDENTIFIER_TYPES.MEMBER_INVITATION) },
      });

      expect(result.errors).to.have.length(1);
      expect(result.errors[0].extensions.code).to.equal('Unauthorized');
    });

    it('returns an error when neither invitation id nor account+memberAccount are provided', async () => {
      const result = await utils.graphqlQueryV2(
        gql`
          mutation CancelMemberInvitationNoArgs {
            cancelMemberInvitation
          }
        `,
        {},
        collectiveAdminUser,
      );

      expect(result.errors).to.have.length(1);
    });
  });

  describe('replyToMemberInvitation', () => {
    const replyToMemberInvitationMutation = gql`
      mutation ReplyToMemberInvitation($invitation: MemberInvitationReferenceInput!, $accept: Boolean!) {
        replyToMemberInvitation(invitation: $invitation, accept: $accept)
      }
    `;

    it('can accept the invitation and document the changes in an activity', async () => {
      const invitation = await fakeMemberInvitation({ CollectiveId: collective.id, role: roles.ADMIN });
      const invitedUser = await invitation.memberCollective.getUser();
      const result = await utils.graphqlQueryV2(
        replyToMemberInvitationMutation,
        { invitation: { id: idEncode(invitation.id, IDENTIFIER_TYPES.MEMBER_INVITATION) }, accept: true },
        invitedUser,
      );
      const activity = await models.Activity.findAll({
        where: {
          type: ActivityTypes.COLLECTIVE_CORE_MEMBER_ADDED,
          CollectiveId: collective.id,
        },
      });
      expect(activity.length).to.equal(1);
      expect(activity[0].data.memberCollective.id).to.equal(invitation.MemberCollectiveId);
      expect(result.errors).to.not.exist;
      expect(result.data.replyToMemberInvitation).to.equal(true);
    });

    it('can decline the invitation', async () => {
      const invitation = await fakeMemberInvitation({ CollectiveId: collective.id, role: roles.ADMIN });
      const invitedUser = await invitation.memberCollective.getUser();
      const result = await utils.graphqlQueryV2(
        replyToMemberInvitationMutation,
        { invitation: { id: idEncode(invitation.id, IDENTIFIER_TYPES.MEMBER_INVITATION) }, accept: false },
        invitedUser,
      );
      expect(result.errors).to.not.exist;
      expect(result.data.replyToMemberInvitation).to.equal(false);

      const activity = await models.Activity.findAll({
        where: {
          type: ActivityTypes.COLLECTIVE_CORE_MEMBER_INVITATION_DECLINED,
          CollectiveId: collective.id,
          data: { memberCollective: { id: invitation.MemberCollectiveId } },
        },
      });

      expect(activity.length).to.equal(1);
    });

    it('must be authenticated as the invited user', async () => {
      // Must be authenticated
      const invitation = await fakeMemberInvitation({ CollectiveId: collective.id, role: roles.ADMIN });
      const resultUnauthenticated = await utils.graphqlQueryV2(replyToMemberInvitationMutation, {
        invitation: { id: idEncode(invitation.id, IDENTIFIER_TYPES.MEMBER_INVITATION) },
        accept: true,
      });

      expect(resultUnauthenticated.errors).to.have.length(1);
      expect(resultUnauthenticated.errors[0].extensions.code).to.equal('Unauthorized');

      // Must be invited user
      const randomUser = await fakeUser();
      for (const user of [collectiveAdminUser, randomUser]) {
        const result = await utils.graphqlQueryV2(
          replyToMemberInvitationMutation,
          { invitation: { id: idEncode(invitation.id, IDENTIFIER_TYPES.MEMBER_INVITATION) }, accept: true },
          user,
        );

        expect(result.errors).to.have.length(1);
        expect(result.errors[0].message).to.equal('Only an admin of the invited account can reply to the invitation');
      }
    });
  });
});
