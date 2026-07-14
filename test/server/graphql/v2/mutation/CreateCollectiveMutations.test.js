import { expect } from 'chai';
import gql from 'fake-tag';
import nock from 'nock';
import { createSandbox } from 'sinon';

import { activities } from '../../../../../server/constants';
import roles from '../../../../../server/constants/roles';
import emailLib from '../../../../../server/lib/email';
import models from '../../../../../server/models';
import { randEmail } from '../../../../stores';
import { fakeActiveHost, fakeUser } from '../../../../test-helpers/fake-data';
import * as utils from '../../../../utils';

const createCollectiveMutation = gql`
  mutation CreateCollective(
    $collective: CollectiveCreateInput!
    $host: AccountReferenceInput
    $inviteMembers: [InviteMemberInput]
    $applicationData: JSON
    $skipDefaultAdmin: Boolean
  ) {
    createCollective(
      collective: $collective
      host: $host
      inviteMembers: $inviteMembers
      applicationData: $applicationData
      skipDefaultAdmin: $skipDefaultAdmin
    ) {
      name
      slug
      tags
      isActive
      isPrivate
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
  let sandbox, sendEmailSpy;
  let host;

  beforeEach(async () => {
    await utils.resetTestDB();
    host = await fakeActiveHost({
      name: 'Open Source Collective',
      slug: 'opensource',
      type: 'ORGANIZATION',
      settings: { apply: true },
      hasMoneyManagement: true,
      hasHosting: true,
    });
  });

  beforeEach('setup email spy', () => {
    sandbox = createSandbox();
    sendEmailSpy = sandbox.spy(emailLib, 'sendMessage');
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('simple case', async () => {
    let user;

    beforeEach('create user', async () => {
      user = await fakeUser();
    });

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

    it('collective created with host argument but the user is not a host admin', async () => {
      const result = await utils.graphqlQueryV2(
        createCollectiveMutation,
        { collective: newCollectiveData, host: { slug: host.slug } },
        user,
      );
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;

      const resultAccount = result.data.createCollective;
      expect(resultAccount.name).to.equal(newCollectiveData.name);
      expect(resultAccount.slug).to.equal(newCollectiveData.slug);
      expect(resultAccount.host.slug).to.equal(host.slug);
      expect(resultAccount.isActive).to.be.false;
      expect(resultAccount.isApproved).to.be.false;
    });

    it('collective created with host argument by a user that is a host admin', async () => {
      await host.addUserWithRole(user, roles.ADMIN);
      await user.populateRoles();

      const result = await utils.graphqlQueryV2(
        createCollectiveMutation,
        { collective: newCollectiveData, host: { slug: host.slug } },
        user,
      );
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;

      const resultAccount = result.data.createCollective;
      expect(resultAccount.name).to.equal(newCollectiveData.name);
      expect(resultAccount.slug).to.equal(newCollectiveData.slug);
      expect(resultAccount.host.slug).to.equal(host.slug);
      expect(resultAccount.isActive).to.be.true;
      expect(resultAccount.isApproved).to.be.true;
    });

    it('collective created with host argument by a user that is a host admin and the host has isPrivate flag set to true', async () => {
      await host.update({ isPrivate: true });
      await host.addUserWithRole(user, roles.ADMIN);
      await user.populateRoles();

      const result = await utils.graphqlQueryV2(
        createCollectiveMutation,
        { collective: newCollectiveData, host: { slug: host.slug } },
        user,
      );
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;

      const resultAccount = result.data.createCollective;
      expect(resultAccount.name).to.equal(newCollectiveData.name);
      // When the host is private, slug is auto-generated and must NOT equal the user-supplied slug
      expect(resultAccount.slug).to.not.equal(newCollectiveData.slug);
      // The auto-generated private slug is a 16-character url-safe random string
      expect(resultAccount.slug).to.match(/^[a-zA-Z0-9_~-]{16}$/);
      expect(resultAccount.host.slug).to.equal(host.slug);
      expect(resultAccount.isActive).to.be.true;
      expect(resultAccount.isApproved).to.be.true;
      expect(resultAccount.isPrivate).to.be.true;

      // A new user invited via memberInfo on a private collective must also get a private profile
      const invitedNewUserEmail = 'private-invited@oc-example.com';
      const resultWithInvite = await utils.graphqlQueryV2(
        createCollectiveMutation,
        {
          collective: { ...newCollectiveData, slug: 'another-private-slug' },
          host: { slug: host.slug },
          skipDefaultAdmin: true,
          inviteMembers: [
            {
              memberInfo: { email: invitedNewUserEmail, name: 'Private Invitee' },
              role: 'ADMIN',
            },
          ],
        },
        user,
      );
      resultWithInvite.errors && console.error(resultWithInvite.errors);
      expect(resultWithInvite.errors).to.not.exist;

      const invitedUser = await models.User.findOne({ where: { email: invitedNewUserEmail } });
      expect(invitedUser).to.exist;
      const invitedUserCollective = await models.Collective.findByPk(invitedUser.CollectiveId);
      expect(invitedUserCollective.isPrivate).to.be.true;
    });

    it('collective created with a non-private host uses the user-supplied slug', async () => {
      const result = await utils.graphqlQueryV2(
        createCollectiveMutation,
        { collective: newCollectiveData, host: { slug: host.slug } },
        user,
      );
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;

      const resultAccount = result.data.createCollective;
      // When host.isPrivate is false (default), slug comes directly from the user input
      expect(resultAccount.slug).to.equal(newCollectiveData.slug);
      expect(resultAccount.isPrivate).to.be.false;
    });

    it('host admin invites a member using skipDefaultAdmin: the invitation email omits the inviter name', async () => {
      const hostAdmin = user;
      await host.addUserWithRole(hostAdmin, roles.ADMIN);
      await hostAdmin.populateRoles();

      const invitedUser = await fakeUser();

      const result = await utils.graphqlQueryV2(
        createCollectiveMutation,
        {
          collective: { ...newCollectiveData, slug: 'skip-admin-collective' },
          host: { slug: host.slug },
          skipDefaultAdmin: true,
          inviteMembers: [
            {
              memberAccount: { slug: invitedUser.collective.slug },
              role: 'ADMIN',
              description: 'Invited by host admin without default admin',
            },
          ],
        },
        hostAdmin,
      );
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;

      await utils.waitForCondition(() => sendEmailSpy.callCount === 1);
      expect(sendEmailSpy.callCount).to.equal(1);

      const [recipient, subject, html] = sendEmailSpy.args[0];
      expect(recipient).to.equal(invitedUser.email);
      expect(subject).to.equal(`Invitation to join ${newCollectiveData.name} on Open Collective`);
      // skipDefaultAdmin branch: no inviter name
      expect(html).to.include('You were just invited to the role of');
      // normal branch must not appear
      expect(html).to.not.include('just invited you to the role of');

      const collective = await models.Collective.findOne({ where: { slug: 'skip-admin-collective' } });

      // With skipDefaultAdmin: true, no one should be directly added as admin
      const admins = await collective.getAdmins();
      expect(admins).to.have.length(0);

      // The invited user should have a pending MemberInvitation
      const invitations = await models.MemberInvitation.findAll({
        where: { CollectiveId: collective.id },
        include: [{ association: 'memberCollective' }],
      });
      expect(invitations).to.have.length(1);
      expect(invitations[0].memberCollective.slug).to.eq(invitedUser.collective.slug);
      expect(invitations[0].role).to.eq(roles.ADMIN);
      expect(invitations[0].description).to.eq('Invited by host admin without default admin');
    });

    it('invites a new user via memberInfo: flags requiresProfileCompletion and surfaces the complete-profile CTA in the email', async () => {
      const user = await models.User.createUserWithCollective(utils.data('user2'));
      const newInviteeEmail = randEmail();

      const result = await utils.graphqlQueryV2(
        createCollectiveMutation,
        {
          collective: { ...newCollectiveData, slug: 'new-invitee-collective' },
          inviteMembers: [
            {
              memberInfo: { name: 'Brand New Admin', email: newInviteeEmail },
              role: 'ADMIN',
              description: 'A brand new admin',
            },
          ],
        },
        user,
      );
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;

      const collective = await models.Collective.findOne({ where: { slug: 'new-invitee-collective' } });

      // The freshly-created invitee must be flagged for profile completion
      const invitedUser = await models.User.findOne({
        where: { email: newInviteeEmail },
        include: [{ model: models.Collective, as: 'collective' }],
      });
      expect(invitedUser).to.exist;
      expect(invitedUser.collective.data?.requiresProfileCompletion).to.equal(true);

      // The invitation activity must carry the isNewUser flag so the email template renders the right CTA
      const invitationActivity = await models.Activity.findOne({
        where: { type: activities.COLLECTIVE_MEMBER_INVITED, CollectiveId: collective.id },
      });
      expect(invitationActivity).to.exist;
      expect(invitationActivity.data.isNewUser).to.equal(true);

      // The email sent to the invitee should link to /signup/profile with a `next` redirect back to the invitation
      await utils.waitForCondition(() => sendEmailSpy.args.some(([to]) => to === newInviteeEmail));
      const inviteeCall = sendEmailSpy.args.find(([to]) => to === newInviteeEmail);
      expect(inviteeCall).to.exist;
      const [, subject, html] = inviteeCall;
      expect(subject).to.equal(`Invitation to join ${newCollectiveData.name} on Open Collective`);
      expect(html).to.include('Sign up and view invitation');
      expect(html).to.include('/signin?next=%2Fsignup%2Fprofile?next=%2Fmember-invitations%23invitation-');
      // The plain "View invitation" CTA must not be rendered for new users
      expect(html).to.not.match(/>\s*View invitation\s*</);
    });

    it('invites an existing user via memberAccount: the email keeps the regular View invitation CTA', async () => {
      const user = await models.User.createUserWithCollective(utils.data('user2'));
      const existingUserToInvite = await fakeUser();

      const result = await utils.graphqlQueryV2(
        createCollectiveMutation,
        {
          collective: { ...newCollectiveData, slug: 'existing-invitee-collective' },
          inviteMembers: [
            {
              memberAccount: { slug: existingUserToInvite.collective.slug },
              role: 'ADMIN',
              description: 'An admin with existing account',
            },
          ],
        },
        user,
      );
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;

      const collective = await models.Collective.findOne({ where: { slug: 'existing-invitee-collective' } });

      // Existing user's collective must not be re-flagged for profile completion
      await existingUserToInvite.collective.reload();
      expect(existingUserToInvite.collective.data?.requiresProfileCompletion).to.not.equal(true);

      const invitationActivity = await models.Activity.findOne({
        where: { type: activities.COLLECTIVE_MEMBER_INVITED, CollectiveId: collective.id },
      });
      expect(invitationActivity).to.exist;
      expect(invitationActivity.data.isNewUser).to.equal(false);

      await utils.waitForCondition(() => sendEmailSpy.args.some(([to]) => to === existingUserToInvite.email));
      const inviteeCall = sendEmailSpy.args.find(([to]) => to === existingUserToInvite.email);
      expect(inviteeCall).to.exist;
      const [, , html] = inviteeCall;
      expect(html).to.include('View invitation');
      expect(html).to.include('/member-invitations#invitation-');
      expect(html).to.not.include('Sign up and view invitation');
      expect(html).to.not.include('/signin?next=/signup/profile');
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
