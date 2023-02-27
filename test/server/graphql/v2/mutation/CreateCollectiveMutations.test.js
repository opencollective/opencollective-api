import { expect } from 'chai';
import gqlV2 from 'fake-tag';

import { activities } from '../../../../../server/constants';
import models from '../../../../../server/models';
import { randEmail } from '../../../../stores';
import { fakeUser } from '../../../../test-helpers/fake-data';
import * as utils from '../../../../utils';

const createCollectiveMutation = gqlV2/* GraphQL */ `
  mutation CreateCollective(
    $collective: CollectiveCreateInput!
    $host: AccountReferenceInput
    $inviteMembers: [InviteMemberInput]
  ) {
    createCollective(collective: $collective, host: $host, inviteMembers: $inviteMembers) {
      name
      slug
      tags
      isActive
      ... on AccountWithHost {
        isApproved
        host {
          id
          slug
        }
      }
    }
  }
`;

const newCollectiveData = {
  name: 'My New Collective',
  slug: 'my-new-collective-slug',
  description: 'The description of my new collective',
  tags: ['community'],
};

describe('server/graphql/v2/mutation/CreateCollectiveMutations', () => {
  beforeEach('reset db', async () => {
    await utils.resetTestDB();
  });

  describe('simple case', async () => {
    it('fails if not authenticated', async () => {
      const result = await utils.graphqlQueryV2(createCollectiveMutation, {
        collective: newCollectiveData,
      });
      expect(result.errors).to.have.length(1);
      expect(result.errors[0].message).to.equal('You need to be logged in to create a collective');
    });

    it('succeeds if all parameters are right', async () => {
      const user = await models.User.createUserWithCollective(utils.data('user2'));
      const result = await utils.graphqlQueryV2(createCollectiveMutation, { collective: newCollectiveData }, user);
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.createCollective.name).to.equal(newCollectiveData.name);
      expect(result.data.createCollective.slug).to.equal(newCollectiveData.slug);
      expect(result.data.createCollective.tags).to.deep.equal(newCollectiveData.tags);
    });

    it('invite members', async () => {
      const user = await models.User.createUserWithCollective(utils.data('user2'));
      const existingUserToInvite = await fakeUser();
      const result = await utils.graphqlQueryV2(
        createCollectiveMutation,
        {
          collective: newCollectiveData,
          inviteMembers: [
            // Existing user
            {
              memberAccount: { slug: existingUserToInvite.collective.slug },
              role: 'ADMIN',
              description: 'An admin with existing account',
            },
            // New user
            {
              memberInfo: { name: 'Another admin', email: randEmail() },
              role: 'ADMIN',
              description: 'An admin with a new account',
            },
          ],
        },
        user,
      );
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;

      const resultAccount = result.data.createCollective;
      expect(resultAccount.name).to.equal(newCollectiveData.name);
      expect(resultAccount.slug).to.equal(newCollectiveData.slug);
      expect(resultAccount.tags).to.deep.equal(newCollectiveData.tags);

      const collective = await models.Collective.findOne({ where: { slug: resultAccount.slug } });

      // Check that no-one was added directly as an admin
      const admins = await collective.getAdmins();
      expect(admins).to.have.length(1);
      expect(admins[0].id).to.eq(user.CollectiveId);

      // Check that the other admins were invited
      const invitedAdmins = await models.MemberInvitation.findAll({
        order: [['id', 'ASC']],
        where: { CollectiveId: collective.id },
        include: [{ association: 'memberCollective' }],
      });

      expect(invitedAdmins).to.have.length(2);
      expect(invitedAdmins[0].memberCollective.slug).to.eq(existingUserToInvite.collective.slug);
      expect(invitedAdmins[1].memberCollective.name).to.eq('Another admin');
      const memberInvitationActivities = await models.Activity.findAll({
        order: [['id', 'ASC']],
        where: { type: activities.COLLECTIVE_CORE_MEMBER_INVITED, CollectiveId: collective.id },
      });

      expect(memberInvitationActivities).to.have.length(2);
      expect(memberInvitationActivities[0].data.memberCollective.slug).to.eq(existingUserToInvite.collective.slug);
      expect(memberInvitationActivities[1].data.memberCollective.name).to.eq('Another admin');
    });
  });
});
