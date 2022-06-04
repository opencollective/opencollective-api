import { expect } from 'chai';
import gqlV2 from 'fake-tag';
import { describe, it } from 'mocha';
import { createSandbox } from 'sinon';

import roles from '../../../../../server/constants/roles';
import { idEncode, IDENTIFIER_TYPES } from '../../../../../server/graphql/v2/identifiers';
import emailLib from '../../../../../server/lib/email';
import models from '../../../../../server/models';
import * as utils from '../../../../utils';

let host, user1, user2, user3, user4, user5, user6, collective1, collective2;
let createdMemberInvitationId1, createdMemberInvitationId2, createdMemberInvitationId3;
let sandbox, sendEmailSpy;

describe('MemberInvitationMutations', () => {
  /* SETUP
    - collective1: host, user1 as admin
    - user2
    - user3
  */
  before(() => {
    sandbox = createSandbox();
    sendEmailSpy = sandbox.spy(emailLib, 'sendMessage');
  });

  after(() => sandbox.restore());
  before(() => utils.resetTestDB());
  before(async () => {
    user1 = await models.User.createUserWithCollective(utils.data('user1'));
  });
  before(async () => {
    host = await models.User.createUserWithCollective(utils.data('host1'));
  });
  before(async () => {
    user2 = await models.User.createUserWithCollective(utils.data('user2'));
  });
  before(async () => {
    user3 = await models.User.createUserWithCollective(utils.data('user3'));
  });
  before(async () => {
    user4 = await models.User.createUserWithCollective(utils.data('user4'));
  });
  before(async () => {
    user5 = await models.User.createUserWithCollective(utils.data('user5'));
  });
  before(async () => {
    user6 = await models.User.createUserWithCollective(utils.data('user6'));
  });
  before(async () => {
    collective1 = await models.Collective.create(utils.data('collective1'));
  });
  before(async () => {
    collective2 = await models.Collective.create(utils.data('collective2'));
  });
  before(() => collective1.addUserWithRole(host, roles.HOST));
  before(() => collective1.addUserWithRole(user1, roles.ADMIN));

  describe('inviteMember', () => {
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
    it('should create a new member invitation and its related activity', async () => {
      sendEmailSpy.resetHistory();
      const result = await utils.graphqlQueryV2(
        inviteMemberMutation,
        {
          memberAccount: { id: idEncode(user2.id, IDENTIFIER_TYPES.ACCOUNT) },
          account: { id: idEncode(collective1.id, IDENTIFIER_TYPES.ACCOUNT) },
          description: 'new user 2 as MEMBER',
          role: roles.MEMBER,
          since: new Date('01 January 2022').toISOString(),
        },
        user1,
      );

      const createdMemberInvitation = result.data.inviteMember;
      expect(result.errors).to.not.exist;
      expect(createdMemberInvitation.role).to.equal(roles.MEMBER);
      expect(createdMemberInvitation.description).to.equal('new user 2 as MEMBER');
      expect(createdMemberInvitation.since.toISOString()).to.equal(new Date('01 January 2022').toISOString());
      expect(sendEmailSpy.callCount).to.equal(1);
      expect(sendEmailSpy.args[0][0]).to.equal(user2.email);
      expect(sendEmailSpy.args[0][1]).to.equal("Invitation to join Scouts d'Arlon on Open Collective");
    });
    it('must be authenticated as an admin of the collective', async () => {
      sendEmailSpy.resetHistory();
      const result = await utils.graphqlQueryV2(
        inviteMemberMutation,
        {
          memberAccount: { id: idEncode(user3.id, IDENTIFIER_TYPES.ACCOUNT) },
          account: { id: idEncode(collective1.id, IDENTIFIER_TYPES.ACCOUNT) },
          description: 'new user 2 as ADMIN',
          role: roles.MEMBER,
          since: new Date('01 January 2022').toISOString(),
        },
        user2,
      );
      expect(sendEmailSpy.callCount).to.equal(0);
      expect(result.errors).to.have.length(1);
      expect(result.errors[0].message).to.equal('Only admins can send an invitation.');
    });
    it('can only add with role accountant, admin, or member', async () => {
      // Able to add ACCOUNTANT Role
      sendEmailSpy.resetHistory();
      const result1 = await utils.graphqlQueryV2(
        inviteMemberMutation,
        {
          memberAccount: { id: idEncode(user3.id, IDENTIFIER_TYPES.ACCOUNT) },
          account: { id: idEncode(collective1.id, IDENTIFIER_TYPES.ACCOUNT) },
          description: 'new user 3 as ACCOUNTANT',
          role: roles.ACCOUNTANT,
          since: new Date('01 January 2022').toISOString(),
        },
        user1,
      );
      createdMemberInvitationId1 = result1.data.inviteMember.id;
      expect(result1.errors).to.not.exist;
      expect(result1.data.inviteMember.role).to.equal(roles.ACCOUNTANT);
      expect(result1.data.inviteMember.description).to.equal('new user 3 as ACCOUNTANT');
      expect(sendEmailSpy.callCount).to.equal(1);
      expect(sendEmailSpy.args[0][0]).to.equal(user3.email);

      // Able to add ADMIN Role
      sendEmailSpy.resetHistory();
      const result2 = await utils.graphqlQueryV2(
        inviteMemberMutation,
        {
          memberAccount: { id: idEncode(user4.id, IDENTIFIER_TYPES.ACCOUNT) },
          account: { id: idEncode(collective1.id, IDENTIFIER_TYPES.ACCOUNT) },
          description: 'new user 4 as ADMIN',
          role: roles.ADMIN,
          since: new Date('01 January 2022').toISOString(),
        },
        user1,
      );
      createdMemberInvitationId2 = result2.data.inviteMember.id;
      expect(result2.errors).to.not.exist;
      expect(result2.data.inviteMember.role).to.equal(roles.ADMIN);
      expect(result2.data.inviteMember.description).to.equal('new user 4 as ADMIN');
      expect(sendEmailSpy.callCount).to.equal(1);
      expect(sendEmailSpy.args[0][0]).to.equal(user4.email);

      // Able to add MEMBER Role
      sendEmailSpy.resetHistory();
      const result3 = await utils.graphqlQueryV2(
        inviteMemberMutation,
        {
          memberAccount: { id: idEncode(user5.id, IDENTIFIER_TYPES.ACCOUNT) },
          account: { id: idEncode(collective1.id, IDENTIFIER_TYPES.ACCOUNT) },
          description: 'new user 5 as MEMBER',
          role: roles.MEMBER,
          since: new Date('01 January 2022').toISOString(),
        },
        user1,
      );
      createdMemberInvitationId3 = result3.data.inviteMember.id;
      expect(result3.errors).to.not.exist;
      expect(result3.data.inviteMember.role).to.equal(roles.MEMBER);
      expect(result3.data.inviteMember.description).to.equal('new user 5 as MEMBER');
      expect(sendEmailSpy.callCount).to.equal(1);
      expect(sendEmailSpy.args[0][0]).to.equal(user5.email);

      // Throw error wihle adding other roles
      sendEmailSpy.resetHistory();
      const result4 = await utils.graphqlQueryV2(
        inviteMemberMutation,
        {
          memberAccount: { id: idEncode(user6.id, IDENTIFIER_TYPES.ACCOUNT) },
          account: { id: idEncode(collective1.id, IDENTIFIER_TYPES.ACCOUNT) },
          description: 'new user 6 as BACKER',
          role: roles.BACKER,
          since: new Date('01 January 2022').toISOString(),
        },
        user1,
      );
      expect(sendEmailSpy.callCount).to.equal(0);
      expect(result4.errors).to.have.length(1);
      expect(result4.errors[0].message).to.equal('You can only invite accountants, admins, or members.');
    });
    it('can only add with a user account', async () => {
      sendEmailSpy.resetHistory();
      const result = await utils.graphqlQueryV2(
        inviteMemberMutation,
        {
          memberAccount: { id: idEncode(collective2.id, IDENTIFIER_TYPES.ACCOUNT) },
          account: { id: idEncode(collective1.id, IDENTIFIER_TYPES.ACCOUNT) },
          description: 'not a user acccount',
          role: roles.MEMBER,
          since: new Date('01 January 2022').toISOString(),
        },
        user1,
      );
      expect(sendEmailSpy.callCount).to.equal(0);
      expect(result.errors).to.have.length(1);
      expect(result.errors[0].message).to.equal('You can only invite users.');
    });
  });

  describe('editMemberInvitation', () => {
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
    it('should edit the role, description, and since and document the changes in an activity', async () => {
      const result = await utils.graphqlQueryV2(
        editMemberInvitationMutation,
        {
          memberAccount: { id: idEncode(user2.id, IDENTIFIER_TYPES.ACCOUNT) },
          account: { id: idEncode(collective1.id, IDENTIFIER_TYPES.ACCOUNT) },
          description: 'new user 2 with role changed from MEMBER to ADMIN',
          role: roles.ADMIN,
          since: new Date('01 February 2022').toISOString(),
        },
        user1,
      );

      const editedMemberInvitation = result.data.editMemberInvitation;
      expect(result.errors).to.not.exist;
      expect(editedMemberInvitation.role).to.equal(roles.ADMIN);
      expect(editedMemberInvitation.description).to.equal('new user 2 with role changed from MEMBER to ADMIN');
      expect(editedMemberInvitation.since.toISOString()).to.equal(new Date('01 February 2022').toISOString());
    });
    it('must be authenticated as an admin of the collective', async () => {
      const result = await utils.graphqlQueryV2(
        editMemberInvitationMutation,
        {
          memberAccount: { id: idEncode(user2.id, IDENTIFIER_TYPES.ACCOUNT) },
          account: { id: idEncode(collective1.id, IDENTIFIER_TYPES.ACCOUNT) },
          description: 'role changed to MEMBER',
          role: roles.MEMBER,
          since: new Date('01 February 2022').toISOString(),
        },
        user3,
      );

      expect(result.errors).to.have.length(1);
      expect(result.errors[0].message).to.equal('Only admins can edit members.');
    });
    it('can only update role to accountant, admin or member', async () => {
      // update role to ACCOUNTANT
      const result1 = await utils.graphqlQueryV2(
        editMemberInvitationMutation,
        {
          memberAccount: { id: idEncode(user2.id, IDENTIFIER_TYPES.ACCOUNT) },
          account: { id: idEncode(collective1.id, IDENTIFIER_TYPES.ACCOUNT) },
          description: 'role changed to ACCOUNTANT',
          role: roles.ACCOUNTANT,
          since: new Date('01 February 2022').toISOString(),
        },
        user1,
      );

      const editedMemberInvitation1 = result1.data.editMemberInvitation;
      expect(result1.errors).to.not.exist;
      expect(editedMemberInvitation1.role).to.equal(roles.ACCOUNTANT);
      expect(editedMemberInvitation1.description).to.equal('role changed to ACCOUNTANT');

      // update role to ADMIN
      const result2 = await utils.graphqlQueryV2(
        editMemberInvitationMutation,
        {
          memberAccount: { id: idEncode(user2.id, IDENTIFIER_TYPES.ACCOUNT) },
          account: { id: idEncode(collective1.id, IDENTIFIER_TYPES.ACCOUNT) },
          description: 'role changed to ADMIN',
          role: roles.ADMIN,
          since: new Date('01 February 2022').toISOString(),
        },
        user1,
      );

      const editedMemberInvitation2 = result2.data.editMemberInvitation;
      expect(result2.errors).to.not.exist;
      expect(editedMemberInvitation2.role).to.equal(roles.ADMIN);
      expect(editedMemberInvitation2.description).to.equal('role changed to ADMIN');

      // update role to MEMBER
      const result3 = await utils.graphqlQueryV2(
        editMemberInvitationMutation,
        {
          memberAccount: { id: idEncode(user2.id, IDENTIFIER_TYPES.ACCOUNT) },
          account: { id: idEncode(collective1.id, IDENTIFIER_TYPES.ACCOUNT) },
          description: 'role changed to MEMBER',
          role: roles.MEMBER,
          since: new Date('01 February 2022').toISOString(),
        },
        user1,
      );

      const editedMemberInvitation3 = result3.data.editMemberInvitation;
      expect(result3.errors).to.not.exist;
      expect(editedMemberInvitation3.role).to.equal(roles.MEMBER);
      expect(editedMemberInvitation3.description).to.equal('role changed to MEMBER');

      // Throw error if updating to any other role
      const result4 = await utils.graphqlQueryV2(
        editMemberInvitationMutation,
        {
          memberAccount: { id: idEncode(user2.id, IDENTIFIER_TYPES.ACCOUNT) },
          account: { id: idEncode(collective1.id, IDENTIFIER_TYPES.ACCOUNT) },
          description: 'role changed to BACKER',
          role: roles.BACKER,
          since: new Date('01 February 2022').toISOString(),
        },
        user1,
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
    it('can accept the invitation and document the changes in an activity', async () => {
      const result = await utils.graphqlQueryV2(
        replyToMemberInvitationMutation,
        {
          invitation: { id: createdMemberInvitationId1 },
          accept: true,
        },
        user3,
      );
      expect(result.errors).to.not.exist;
      expect(result.data.replyToMemberInvitation).to.equal(true);
    });
    it('can decline the invitation and document the changes in an activity', async () => {
      const result = await utils.graphqlQueryV2(
        replyToMemberInvitationMutation,
        {
          invitation: { id: createdMemberInvitationId2 },
          accept: false,
        },
        user4,
      );
      expect(result.errors).to.not.exist;
      expect(result.data.replyToMemberInvitation).to.equal(false);
    });
    it('must be authenticated as the invited user', async () => {
      const result = await utils.graphqlQueryV2(
        replyToMemberInvitationMutation,
        {
          invitation: { id: createdMemberInvitationId3 },
          accept: true,
        },
        user2,
      );
      expect(result.errors).to.have.length(1);
      expect(result.errors[0].message).to.equal('Only an admin of the invited account can reply to the invitation');
    });
  });
});
