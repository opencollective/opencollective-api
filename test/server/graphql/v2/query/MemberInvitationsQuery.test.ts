import { expect } from 'chai';
import gql from 'fake-tag';

import { roles } from '../../../../../server/constants';
import { idEncode, IDENTIFIER_TYPES } from '../../../../../server/graphql/v2/identifiers';
import { fakeCollective, fakeHost, fakeMemberInvitation, fakeUser } from '../../../../test-helpers/fake-data';
import { graphqlQueryV2, resetTestDB } from '../../../../utils';

const memberInvitationsQuery = gql`
  query MemberInvitations(
    $memberAccount: AccountReferenceInput
    $account: AccountReferenceInput
    $role: [MemberRole!]
  ) {
    memberInvitations(memberAccount: $memberAccount, account: $account, role: $role) {
      id
      role
      description
      createdAt
      since
      account {
        id
        slug
        name
      }
      memberAccount {
        id
        slug
        name
      }
      inviter {
        id
        slug
        name
      }
      tier {
        id
        name
      }
    }
  }
`;

describe('server/graphql/v2/query/MemberInvitationsQuery', () => {
  before(resetTestDB);

  let collectiveAdminUser, hostAdminUser, randomUser, collective, host;

  before(async () => {
    // Create users
    collectiveAdminUser = await fakeUser();
    hostAdminUser = await fakeUser();
    randomUser = await fakeUser();

    // Create host and collective
    host = await fakeHost({ admin: hostAdminUser });
    collective = await fakeCollective({ admin: collectiveAdminUser, HostCollectiveId: host.id });

    // Create member invitations
    await fakeMemberInvitation({
      CollectiveId: collective.id,
      role: roles.ADMIN,
      description: 'Admin invitation',
    });

    await fakeMemberInvitation({
      CollectiveId: collective.id,
      role: roles.MEMBER,
      description: 'Member invitation',
    });
  });

  describe('permissions', () => {
    it('allows collective admin to see invitations for their collective', async () => {
      const result = await graphqlQueryV2(
        memberInvitationsQuery,
        { account: { slug: collective.slug } },
        collectiveAdminUser,
      );

      expect(result.errors).to.be.undefined;
      expect(result.data.memberInvitations).to.have.length(2);
      expect(result.data.memberInvitations.map(inv => inv.role)).to.include.members([roles.ADMIN, roles.MEMBER]);
    });

    it('allows host admin to see invitations for hosted collectives', async () => {
      const result = await graphqlQueryV2(
        memberInvitationsQuery,
        { account: { slug: collective.slug } },
        hostAdminUser,
      );

      expect(result.errors).to.be.undefined;
      expect(result.data.memberInvitations).to.have.length(2);
    });

    it('allows host admin to see invitations for collectives with a pending application', async () => {
      const pendingCollective = await fakeCollective({
        HostCollectiveId: host.id,
        isActive: false,
        approvedAt: null,
      });

      const invitation = await fakeMemberInvitation({
        CollectiveId: pendingCollective.id,
        role: roles.ADMIN,
        description: 'Admin invitation',
      });

      const result = await graphqlQueryV2(
        memberInvitationsQuery,
        { account: { slug: pendingCollective.slug } },
        hostAdminUser,
      );

      expect(result.errors).to.be.undefined;
      expect(result.data.memberInvitations).to.have.length(1);
      expect(result.data.memberInvitations[0].id).to.equal(idEncode(invitation.id, IDENTIFIER_TYPES.MEMBER_INVITATION));
      expect(result.data.memberInvitations[0].account.slug).to.equal(pendingCollective.slug);
    });

    it('allows users to see invitations sent to their account', async () => {
      const invitedUser = await fakeUser();
      const invitationToUser = await fakeMemberInvitation({
        MemberCollectiveId: invitedUser.collective.id,
        CollectiveId: collective.id,
        role: roles.ADMIN,
      });

      const result = await graphqlQueryV2(
        memberInvitationsQuery,
        { memberAccount: { slug: invitedUser.collective.slug } },
        invitedUser,
      );

      expect(result.errors).to.be.undefined;
      expect(result.data.memberInvitations).to.have.length(1);
      expect(result.data.memberInvitations[0].id).to.equal(
        idEncode(invitationToUser.id, IDENTIFIER_TYPES.MEMBER_INVITATION),
      );
      expect(result.data.memberInvitations[0].memberAccount.slug).to.equal(invitedUser.collective.slug);
    });

    it('denies access to random users', async () => {
      const result = await graphqlQueryV2(memberInvitationsQuery, { account: { slug: collective.slug } }, randomUser);

      expect(result.errors).to.be.undefined;
      expect(result.data.memberInvitations).to.be.null;
    });

    it('denies access to unauthenticated users', async () => {
      const result = await graphqlQueryV2(memberInvitationsQuery, { account: { slug: collective.slug } }, null);

      expect(result.errors).to.be.undefined;
      expect(result.data.memberInvitations).to.be.null;
    });
  });

  describe('filtering', () => {
    it('filters by account', async () => {
      const otherCollective = await fakeCollective({ admin: await fakeUser() });
      await fakeMemberInvitation({
        CollectiveId: otherCollective.id,
        role: roles.ADMIN,
      });

      const result = await graphqlQueryV2(
        memberInvitationsQuery,
        { account: { slug: collective.slug } },
        collectiveAdminUser,
      );

      expect(result.errors).to.be.undefined;
      expect(result.data.memberInvitations.length).to.be.at.least(2);
      expect(result.data.memberInvitations.map(inv => inv.account.slug)).to.not.include(otherCollective.slug);
      expect(result.data.memberInvitations.map(inv => inv.account.slug)).to.include(collective.slug);
    });

    it('filters by member account', async () => {
      const invitedUser = await fakeUser();
      const invitationToUser = await fakeMemberInvitation({
        MemberCollectiveId: invitedUser.collective.id,
        CollectiveId: collective.id,
        role: roles.ADMIN,
      });

      const result = await graphqlQueryV2(
        memberInvitationsQuery,
        { memberAccount: { slug: invitedUser.collective.slug } },
        invitedUser,
      );

      expect(result.errors).to.be.undefined;
      expect(result.data.memberInvitations).to.have.length(1);
      expect(result.data.memberInvitations[0].id).to.equal(
        idEncode(invitationToUser.id, IDENTIFIER_TYPES.MEMBER_INVITATION),
      );
      expect(result.data.memberInvitations[0].memberAccount.slug).to.equal(invitedUser.collective.slug);
    });

    it('filters by role', async () => {
      const result = await graphqlQueryV2(
        memberInvitationsQuery,
        { account: { slug: collective.slug }, role: [roles.ADMIN] },
        collectiveAdminUser,
      );

      expect(result.errors).to.be.undefined;
      expect(result.data.memberInvitations.length).to.be.at.least(1);
      expect(result.data.memberInvitations.every(inv => inv.role === roles.ADMIN)).to.be.true;
      expect(result.data.memberInvitations.every(inv => inv.account.slug === collective.slug)).to.be.true;
    });

    it('filters by multiple roles', async () => {
      const result = await graphqlQueryV2(
        memberInvitationsQuery,
        { account: { slug: collective.slug }, role: [roles.ADMIN, roles.MEMBER] },
        collectiveAdminUser,
      );

      expect(result.errors).to.be.undefined;
      expect(result.data.memberInvitations.length).to.be.at.least(2);
      expect(result.data.memberInvitations.every(inv => [roles.ADMIN, roles.MEMBER].includes(inv.role))).to.be.true;
      expect(result.data.memberInvitations.every(inv => inv.account.slug === collective.slug)).to.be.true;
    });
  });

  describe('validation', () => {
    it('requires at least one account reference', async () => {
      const result = await graphqlQueryV2(memberInvitationsQuery, {}, collectiveAdminUser);

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal(
        'You must provide a reference either for collective or member collective',
      );
    });

    it('handles non-existent account gracefully', async () => {
      const result = await graphqlQueryV2(
        memberInvitationsQuery,
        { account: { slug: 'non-existent-collective' } },
        collectiveAdminUser,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.include('Account Not Found');
    });

    it('handles non-existent member account gracefully', async () => {
      const result = await graphqlQueryV2(
        memberInvitationsQuery,
        { memberAccount: { slug: 'non-existent-member' } },
        collectiveAdminUser,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.include('Account Not Found');
    });
  });

  describe('edge cases', () => {
    it('handles collective with no invitations', async () => {
      const emptyCollectiveAdmin = await fakeUser();
      const emptyCollective = await fakeCollective({ admin: emptyCollectiveAdmin });

      const result = await graphqlQueryV2(
        memberInvitationsQuery,
        { account: { slug: emptyCollective.slug } },
        emptyCollectiveAdmin,
      );

      expect(result.errors).to.be.undefined;
      expect(result.data.memberInvitations).to.have.length(0);
    });

    it('handles user with no invitations', async () => {
      const userWithNoInvitations = await fakeUser();

      const result = await graphqlQueryV2(
        memberInvitationsQuery,
        { memberAccount: { slug: userWithNoInvitations.collective.slug } },
        userWithNoInvitations,
      );

      expect(result.errors).to.be.undefined;
      expect(result.data.memberInvitations).to.have.length(0);
    });

    it('handles collective without host', async () => {
      const independentCollectiveAdmin = await fakeUser();
      const independentCollective = await fakeCollective({
        admin: independentCollectiveAdmin,
        HostCollectiveId: null,
      });
      const invitation = await fakeMemberInvitation({
        CollectiveId: independentCollective.id,
        role: roles.ADMIN,
      });

      const result = await graphqlQueryV2(
        memberInvitationsQuery,
        { account: { slug: independentCollective.slug } },
        independentCollectiveAdmin,
      );

      expect(result.errors).to.be.undefined;
      expect(result.data.memberInvitations).to.have.length(1);
      expect(result.data.memberInvitations[0].id).to.equal(idEncode(invitation.id, IDENTIFIER_TYPES.MEMBER_INVITATION));
      expect(result.data.memberInvitations[0].account.slug).to.equal(independentCollective.slug);
    });
  });
});
