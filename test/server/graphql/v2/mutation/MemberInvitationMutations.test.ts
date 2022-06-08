import { expect } from 'chai';
import gqlV2 from 'fake-tag';
import { describe, it } from 'mocha';
import { createSandbox } from 'sinon';

import ActivityTypes from '../../../../../server/constants/activities';
import roles from '../../../../../server/constants/roles';
import { idEncode, IDENTIFIER_TYPES } from '../../../../../server/graphql/v2/identifiers';
import emailLib from '../../../../../server/lib/email';
import models from '../../../../../server/models';
import { fakeCollective, fakeUser } from '../../../../test-helpers/fake-data';
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

  const inviteMemberMutation = gqlV2/* GraphQL */ `
    mutation InviteMember(
      $memberAccount: AccountReferenceInput!
      $account: AccountReferenceInput!
      $role: MemberRole!
      $description: String
      $since: DateTime
    ) {
      inviteMember(
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

  describe('inviteMember', () => {
    it('should create a new member invitation and its related activity', async () => {
      sendEmailSpy.resetHistory();
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
    it('must be authenticated as an admin of the collective', async () => {
      sendEmailSpy.resetHistory();
      const randomUser = await fakeUser();
      const anotherRandomUser = await fakeUser();
      const result = await utils.graphqlQueryV2(
        inviteMemberMutation,
        {
          memberAccount: { id: idEncode(anotherRandomUser.id, IDENTIFIER_TYPES.ACCOUNT) },
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
    it('can only add with role accountant, admin, or member', async () => {
      // Able to add ACCOUNTANT Role
      sendEmailSpy.resetHistory();
      const randomUserToInviteAsAccountant = await fakeUser();
      const result1 = await utils.graphqlQueryV2(
        inviteMemberMutation,
        {
          memberAccount: { id: idEncode(randomUserToInviteAsAccountant.id, IDENTIFIER_TYPES.ACCOUNT) },
          account: { id: idEncode(collective.id, IDENTIFIER_TYPES.ACCOUNT) },
          description: 'new user 3 as ACCOUNTANT',
          role: roles.ACCOUNTANT,
          since: new Date('01 January 2022').toISOString(),
        },
        collectiveAdminUser,
      );
      expect(result1.errors).to.not.exist;
      expect(result1.data.inviteMember.role).to.equal(roles.ACCOUNTANT);
      expect(result1.data.inviteMember.description).to.equal('new user 3 as ACCOUNTANT');
      expect(sendEmailSpy.callCount).to.equal(1);
      expect(sendEmailSpy.args[0][1]).to.equal('Invitation to join webpack test collective on Open Collective');

      // Able to add ADMIN Role
      sendEmailSpy.resetHistory();
      const randomUserToInviteAsAdmin = await fakeUser();
      const result2 = await utils.graphqlQueryV2(
        inviteMemberMutation,
        {
          memberAccount: { id: idEncode(randomUserToInviteAsAdmin.id, IDENTIFIER_TYPES.ACCOUNT) },
          account: { id: idEncode(collective.id, IDENTIFIER_TYPES.ACCOUNT) },
          description: 'new user 4 as ADMIN',
          role: roles.ADMIN,
          since: new Date('01 January 2022').toISOString(),
        },
        collectiveAdminUser,
      );
      expect(result2.errors).to.not.exist;
      expect(result2.data.inviteMember.role).to.equal(roles.ADMIN);
      expect(result2.data.inviteMember.description).to.equal('new user 4 as ADMIN');
      expect(sendEmailSpy.callCount).to.equal(1);
      expect(sendEmailSpy.args[0][1]).to.equal('Invitation to join webpack test collective on Open Collective');

      // Able to add MEMBER Role
      sendEmailSpy.resetHistory();
      const randomUserToInviteAsMember = await fakeUser();
      const result3 = await utils.graphqlQueryV2(
        inviteMemberMutation,
        {
          memberAccount: { id: idEncode(randomUserToInviteAsMember.id, IDENTIFIER_TYPES.ACCOUNT) },
          account: { id: idEncode(collective.id, IDENTIFIER_TYPES.ACCOUNT) },
          description: 'new user 5 as MEMBER',
          role: roles.MEMBER,
          since: new Date('01 January 2022').toISOString(),
        },
        collectiveAdminUser,
      );
      expect(result3.errors).to.not.exist;
      expect(result3.data.inviteMember.role).to.equal(roles.MEMBER);
      expect(result3.data.inviteMember.description).to.equal('new user 5 as MEMBER');
      expect(sendEmailSpy.callCount).to.equal(1);
      expect(sendEmailSpy.args[0][1]).to.equal('Invitation to join webpack test collective on Open Collective');

      // Throw error wihle adding other roles
      sendEmailSpy.resetHistory();
      const randomUserToInviteAsBacker = await fakeUser();
      const result4 = await utils.graphqlQueryV2(
        inviteMemberMutation,
        {
          memberAccount: { id: idEncode(randomUserToInviteAsBacker.id, IDENTIFIER_TYPES.ACCOUNT) },
          account: { id: idEncode(collective.id, IDENTIFIER_TYPES.ACCOUNT) },
          description: 'new user 6 as BACKER',
          role: roles.BACKER,
          since: new Date('01 January 2022').toISOString(),
        },
        collectiveAdminUser,
      );
      expect(sendEmailSpy.callCount).to.equal(0);
      expect(result4.errors).to.have.length(1);
      expect(result4.errors[0].message).to.equal('You can only invite accountants, admins, or members.');
    });
    it('can only add with a user account', async () => {
      sendEmailSpy.resetHistory();
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

  describe('editMemberInvitation', async () => {
    const editMemberInvitationMutation = gqlV2/* GraphQL */ `
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

    let randomUserToInvite;
    before(async () => {
      randomUserToInvite = await fakeUser();
      await utils.graphqlQueryV2(
        inviteMemberMutation,
        {
          memberAccount: { id: idEncode(randomUserToInvite.id, IDENTIFIER_TYPES.ACCOUNT) },
          account: { id: idEncode(collective.id, IDENTIFIER_TYPES.ACCOUNT) },
          description: 'new user as MEMBER',
          role: roles.MEMBER,
          since: new Date('01 January 2022').toISOString(),
        },
        collectiveAdminUser,
      );
    });

    it('should edit the role, description, and since', async () => {
      const result = await utils.graphqlQueryV2(
        editMemberInvitationMutation,
        {
          memberAccount: { id: idEncode(randomUserToInvite.id, IDENTIFIER_TYPES.ACCOUNT) },
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
      const result = await utils.graphqlQueryV2(
        editMemberInvitationMutation,
        {
          memberAccount: { id: idEncode(randomUserToInvite.id, IDENTIFIER_TYPES.ACCOUNT) },
          account: { id: idEncode(collective.id, IDENTIFIER_TYPES.ACCOUNT) },
          description: 'role changed to MEMBER',
          role: roles.MEMBER,
          since: new Date('01 February 2022').toISOString(),
        },
        randomUser,
      );

      expect(result.errors).to.have.length(1);
      expect(result.errors[0].message).to.equal('Only admins can edit members.');
    });
    it('can only update role to accountant, admin or member', async () => {
      // update role to ACCOUNTANT
      const result1 = await utils.graphqlQueryV2(
        editMemberInvitationMutation,
        {
          memberAccount: { id: idEncode(randomUserToInvite.id, IDENTIFIER_TYPES.ACCOUNT) },
          account: { id: idEncode(collective.id, IDENTIFIER_TYPES.ACCOUNT) },
          description: 'role changed to ACCOUNTANT',
          role: roles.ACCOUNTANT,
          since: new Date('01 February 2022').toISOString(),
        },
        collectiveAdminUser,
      );

      const editedMemberInvitation1 = result1.data.editMemberInvitation;
      expect(result1.errors).to.not.exist;
      expect(editedMemberInvitation1.role).to.equal(roles.ACCOUNTANT);
      expect(editedMemberInvitation1.description).to.equal('role changed to ACCOUNTANT');

      // update role to ADMIN
      const result2 = await utils.graphqlQueryV2(
        editMemberInvitationMutation,
        {
          memberAccount: { id: idEncode(randomUserToInvite.id, IDENTIFIER_TYPES.ACCOUNT) },
          account: { id: idEncode(collective.id, IDENTIFIER_TYPES.ACCOUNT) },
          description: 'role changed to ADMIN',
          role: roles.ADMIN,
          since: new Date('01 February 2022').toISOString(),
        },
        collectiveAdminUser,
      );

      const editedMemberInvitation2 = result2.data.editMemberInvitation;
      expect(result2.errors).to.not.exist;
      expect(editedMemberInvitation2.role).to.equal(roles.ADMIN);
      expect(editedMemberInvitation2.description).to.equal('role changed to ADMIN');

      // update role to MEMBER
      const result3 = await utils.graphqlQueryV2(
        editMemberInvitationMutation,
        {
          memberAccount: { id: idEncode(randomUserToInvite.id, IDENTIFIER_TYPES.ACCOUNT) },
          account: { id: idEncode(collective.id, IDENTIFIER_TYPES.ACCOUNT) },
          description: 'role changed to MEMBER',
          role: roles.MEMBER,
          since: new Date('01 February 2022').toISOString(),
        },
        collectiveAdminUser,
      );

      const editedMemberInvitation3 = result3.data.editMemberInvitation;
      expect(result3.errors).to.not.exist;
      expect(editedMemberInvitation3.role).to.equal(roles.MEMBER);
      expect(editedMemberInvitation3.description).to.equal('role changed to MEMBER');

      // Throw error if updating to any other role
      const result4 = await utils.graphqlQueryV2(
        editMemberInvitationMutation,
        {
          memberAccount: { id: idEncode(randomUserToInvite.id, IDENTIFIER_TYPES.ACCOUNT) },
          account: { id: idEncode(collective.id, IDENTIFIER_TYPES.ACCOUNT) },
          description: 'role changed to BACKER',
          role: roles.BACKER,
          since: new Date('01 February 2022').toISOString(),
        },
        collectiveAdminUser,
      );

      expect(result4.errors).to.have.length(1);
      expect(result4.errors[0].message).to.equal('You can only edit accountants, admins, or members.');
    });
  });

  describe('replyToMemberInvitation', () => {
    const replyToMemberInvitationMutation = gqlV2`
            mutation ReplyToMemberInvitation($invitation: MemberInvitationReferenceInput!, $accept: Boolean!) {
                replyToMemberInvitation(invitation: $invitation, accept: $accept)
            }
        `;

    let randomUserToAcceptInvite, randomUserToDeclineInvite;
    let createdInvitationToAccept,
      createdInvitationToAcceptId,
      createdInvitationToDecline,
      createdInvitationToDeclineId;

    before(async () => {
      randomUserToAcceptInvite = await fakeUser();
      randomUserToDeclineInvite = await fakeUser();
      createdInvitationToAccept = await utils.graphqlQueryV2(
        inviteMemberMutation,
        {
          memberAccount: { id: idEncode(randomUserToAcceptInvite.collective.id, IDENTIFIER_TYPES.ACCOUNT) },
          account: { id: idEncode(collective.id, IDENTIFIER_TYPES.ACCOUNT) },
          description: 'new user as ACCOUNTANT',
          role: roles.ACCOUNTANT,
          since: new Date('01 January 2022').toISOString(),
        },
        collectiveAdminUser,
      );
      createdInvitationToAcceptId = createdInvitationToAccept.data.inviteMember.id;
      createdInvitationToDecline = await utils.graphqlQueryV2(
        inviteMemberMutation,
        {
          memberAccount: { id: idEncode(randomUserToDeclineInvite.collective.id, IDENTIFIER_TYPES.ACCOUNT) },
          account: { id: idEncode(collective.id, IDENTIFIER_TYPES.ACCOUNT) },
          description: 'new user as ACCOUNTANT',
          role: roles.ACCOUNTANT,
          since: new Date('01 January 2022').toISOString(),
        },
        collectiveAdminUser,
      );
      createdInvitationToDeclineId = createdInvitationToDecline.data.inviteMember.id;
    });

    it('can accept the invitation and document the changes in an activity', async () => {
      const result = await utils.graphqlQueryV2(
        replyToMemberInvitationMutation,
        {
          invitation: { id: createdInvitationToAcceptId },
          accept: true,
        },
        randomUserToAcceptInvite,
      );
      const activity = await models.Activity.findAll({
        where: {
          type: ActivityTypes.COLLECTIVE_CORE_MEMBER_ADDED,
          CollectiveId: collective.id,
        },
      });
      expect(activity.length).to.equal(1);
      expect(activity[0].data.memberCollective.id).to.equal(randomUserToAcceptInvite.collective.id);
      expect(result.errors).to.not.exist;
      expect(result.data.replyToMemberInvitation).to.equal(true);
    });
    it('must be authenticated as the invited user', async () => {
      const result = await utils.graphqlQueryV2(
        replyToMemberInvitationMutation,
        {
          invitation: { id: createdInvitationToDeclineId },
          accept: true,
        },
        randomUserToAcceptInvite,
      );
      expect(result.errors).to.have.length(1);
      expect(result.errors[0].message).to.equal('Only an admin of the invited account can reply to the invitation');
    });
    it('can decline the invitation', async () => {
      const result = await utils.graphqlQueryV2(
        replyToMemberInvitationMutation,
        {
          invitation: { id: createdInvitationToDeclineId },
          accept: false,
        },
        randomUserToDeclineInvite,
      );
      expect(result.errors).to.not.exist;
      expect(result.data.replyToMemberInvitation).to.equal(false);
    });
  });
});
