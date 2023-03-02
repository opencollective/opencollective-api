import { expect } from 'chai';
import gqlV2 from 'fake-tag';
import nock from 'nock';

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
    $applicationData: JSON
  ) {
    createCollective(
      collective: $collective
      host: $host
      inviteMembers: $inviteMembers
      applicationData: $applicationData
    ) {
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

const backYourStackCollectiveData = {
  name: 'BackYourStack',
  slug: 'backyourstack',
  description: 'The description of BackYourStack collective',
  repositoryUrl: 'https://github.com/backyourstack/backyourstack',
};

describe('server/graphql/v2/mutation/CreateCollectiveMutations', () => {
  beforeEach('reset db', async () => {
    await utils.resetTestDB();
  });

  let host;

  beforeEach('create host', async () => {
    host = await models.Collective.create({
      name: 'Open Source Collective',
      slug: 'opensource',
      type: 'ORGANIZATION',
      settings: { apply: true },
      isHostAccount: true,
    });
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

  describe('with GitHub repository', async () => {
    it('fail if user is not admin', async () => {
      const user = await models.User.createUserWithCollective(utils.data('user2'));
      await models.ConnectedAccount.create({
        service: 'github',
        token: 'faketoken',
        CreatedByUserId: user.id,
        CollectiveId: user.CollectiveId,
      });

      nock('https://api.github.com:443')
        .get('/repos/backyourstack/backyourstack')
        .reply(200, {
          name: 'backyourstack',
          stargazers_count: 102, // eslint-disable-line camelcase
          permissions: { admin: false, push: true, pull: true },
        });

      const result = await utils.graphqlQueryV2(
        createCollectiveMutation,
        {
          collective: backYourStackCollectiveData,
          host: { slug: host.slug },
          applicationData: {
            useGithubValidation: true,
          },
        },
        user,
      );
      expect(result.errors).to.have.length(1);
      expect(result.errors[0].message).to.equal("We could not verify that you're admin of the GitHub repository");
    });

    it('succeeds if user is admin', async () => {
      const user = await models.User.createUserWithCollective(utils.data('user2'));
      await models.ConnectedAccount.create({
        service: 'github',
        token: 'faketoken',
        CreatedByUserId: user.id,
        CollectiveId: user.CollectiveId,
      });

      nock('https://api.github.com:443')
        .get('/repos/backyourstack/backyourstack')
        .times(2)
        .reply(200, {
          name: 'backyourstack',
          permissions: { admin: true, push: true, pull: true },
        });

      nock('https://api.github.com:443')
        .post('/graphql')
        .reply(200, {
          data: {
            repository: {
              isFork: false,
              stargazerCount: 2,
              viewerCanAdminister: true,
              owner: {
                login: 'backyourstack',
              },
              licenseInfo: {
                name: 'MIT',
                spdxId: 'MIT',
              },
              defaultBranchRef: {
                target: {
                  comittedDate: new Date().toString(),
                },
              },
              collaborators: {
                totalCount: 10,
              },
            },
          },
        });

      const result = await utils.graphqlQueryV2(
        createCollectiveMutation,
        {
          collective: backYourStackCollectiveData,
          host: { slug: host.slug },
          applicationData: {
            useGithubValidation: true,
          },
        },
        user,
      );

      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;

      expect(result.data.createCollective.name).to.equal(backYourStackCollectiveData.name);
      expect(result.data.createCollective.slug).to.equal(backYourStackCollectiveData.slug);
      expect(result.data.createCollective.tags).to.include('open source');
    });
  });

  describe('with GitHub organization', async () => {
    it('fail if user is not admin', async () => {
      const user = await models.User.createUserWithCollective(utils.data('user2'));
      await models.ConnectedAccount.create({
        service: 'github',
        token: 'faketoken',
        CreatedByUserId: user.id,
        CollectiveId: user.CollectiveId,
      });

      nock('https://api.github.com:443', { encodedQueryParams: true })
        .get('/user/memberships/orgs')
        .query({ page: '1', per_page: '100' }) // eslint-disable-line camelcase
        .reply(200, [{ organization: { login: 'backyourstack' }, state: 'active', role: 'member' }]);

      const result = await utils.graphqlQueryV2(
        createCollectiveMutation,
        {
          collective: { ...backYourStackCollectiveData, repositoryUrl: 'https://github.com/backyourstack' },
          host: { slug: host.slug },
          applicationData: {
            useGithubValidation: true,
          },
        },
        user,
      );
      expect(result.errors).to.have.length(1);
      expect(result.errors[0].message).to.equal("We could not verify that you're admin of the GitHub organization");
    });

    it('succeeds if user is admin', async () => {
      const user = await models.User.createUserWithCollective(utils.data('user2'));
      await models.ConnectedAccount.create({
        service: 'github',
        token: 'faketoken',
        CreatedByUserId: user.id,
        CollectiveId: user.CollectiveId,
      });

      nock('https://api.github.com:443', { encodedQueryParams: true })
        .get('/user/memberships/orgs')
        .query(true)
        .reply(200, [{ organization: { login: 'backyourstack' }, state: 'active', role: 'admin' }]);

      nock('https://api.github.com:443', { encodedQueryParams: true })
        .get('/orgs/backyourstack/repos')
        .query(true)
        .reply(200, [{ name: 'backyourstack', stargazers_count: 102 }]); // eslint-disable-line camelcase

      const result = await utils.graphqlQueryV2(
        createCollectiveMutation,
        {
          collective: { ...backYourStackCollectiveData, repositoryUrl: 'https://github.com/backyourstack' },
          host: { slug: host.slug },
          applicationData: {
            useGithubValidation: true,
          },
        },
        user,
      );

      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;

      expect(result.data.createCollective.name).to.equal(backYourStackCollectiveData.name);
      expect(result.data.createCollective.slug).to.equal(backYourStackCollectiveData.slug);
      expect(result.data.createCollective.tags).to.include('open source');
    });
  });
});
