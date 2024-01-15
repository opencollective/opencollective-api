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
import { fakeCollective, fakeMemberInvitation, fakeUser } from '../../../../test-helpers/fake-data';
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

    it('can only add with role accountant, admin, or member', async () => {
      const validRoles = [roles.ADMIN, roles.MEMBER, roles.ACCOUNTANT];
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

    it('can only update role to accountant, admin or member', async () => {
      const validRoles = [roles.ADMIN, roles.MEMBER, roles.ACCOUNTANT];
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
        expect(result.errors[0].message).to.equal('You can only edit accountants, admins, or members.');
      }
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
