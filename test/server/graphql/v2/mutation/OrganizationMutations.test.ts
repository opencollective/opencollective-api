import { expect } from 'chai';
import gql from 'fake-tag';
import sinon from 'sinon';

import emailLib from '../../../../../server/lib/email';
import models from '../../../../../server/models';
import { randEmail } from '../../../../stores';
import { fakeUser, randStr } from '../../../../test-helpers/fake-data';
import * as utils from '../../../../utils';

const createOrgMutation = gql`
  mutation CreateOrganization(
    $individual: IndividualCreateInput
    $organization: OrganizationCreateInput!
    $inviteMembers: [InviteMemberInput]
    $captcha: CaptchaInputType
    $roleDescription: String
  ) {
    createOrganization(
      individual: $individual
      organization: $organization
      inviteMembers: $inviteMembers
      captcha: $captcha
      roleDescription: $roleDescription
    ) {
      id
      name
      slug
      description
      website
      legacyId
    }
  }
`;

describe('server/graphql/v2/mutation/OrganizationMutations', () => {
  before('reset db', async () => {
    await utils.resetTestDB();
  });

  describe('createOrganization', () => {
    it('creates an organization using existing logged-in user', async () => {
      const user = await fakeUser();

      const variables = {
        organization: {
          name: 'Test Organization',
          slug: randStr('test-org-'),
          description: 'This is a test organization',
          website: 'https://test.org',
        },
        roleDescription: 'President',
      };

      const result = await utils.graphqlQueryV2(createOrgMutation, variables, user);
      result.errors && console.error(result.errors);
      expect(result.data.createOrganization).to.exist;

      const createdOrg = await models.Collective.findByPk(result.data.createOrganization.legacyId);
      expect(createdOrg.name).to.equal(variables.organization.name);
      expect(createdOrg.slug).to.equal(variables.organization.slug);
      expect(createdOrg.description).to.equal(variables.organization.description);
      expect(createdOrg.CreatedByUserId).to.equal(user.id);

      const [admin] = await createdOrg.getMembers({ where: { role: 'ADMIN' } });
      expect(admin).to.exist;
      expect(admin.MemberCollectiveId).to.equal(user.collective.id);
      expect(admin.description).to.equal(variables.roleDescription);
      expect(admin.role).to.equal('ADMIN');
    });

    it('fails if user is not logged in and no individual is provided', async () => {
      const variables = {
        organization: {
          name: 'Test Organization',
          slug: randStr('test-org-'),
          description: 'This is a test organization',
          website: 'https://test.org',
        },
      };

      const result = await utils.graphqlQueryV2(createOrgMutation, variables);
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal(
        'You must provide an individual to create an organization without a logged-in user',
      );
    });

    it('creates a new user and its organization', async () => {
      const variables = {
        individual: {
          name: randStr('New User'),
          legalName: randStr('New User Legal'),
          email: randEmail(),
        },
        organization: {
          name: 'New Organization',
          slug: randStr('new-org-'),
          description: 'This is a new organization',
          website: 'https://new.org',
        },
        roleDescription: 'Founder',
      };

      const result = await utils.graphqlQueryV2(createOrgMutation, variables);
      result.errors && console.error(result.errors);
      expect(result.data.createOrganization).to.exist;

      const createdOrg = await models.Collective.findByPk(result.data.createOrganization.legacyId);
      expect(createdOrg.name).to.equal(variables.organization.name);
      expect(createdOrg.slug).to.equal(variables.organization.slug);
      expect(createdOrg.description).to.equal(variables.organization.description);

      const user = await models.User.findOne({
        where: { email: variables.individual.email },
        include: [{ model: models.Collective, as: 'collective' }],
      });
      expect(user).to.exist;
      expect(user.collective.name).to.equal(variables.individual.name);
      expect(user.collective.legalName).to.equal(variables.individual.legalName);

      const [admin] = await createdOrg.getMembers({ where: { role: 'ADMIN' } });
      expect(admin).to.exist;
      expect(admin.MemberCollectiveId).to.equal(user.CollectiveId);
      expect(admin.description).to.equal(variables.roleDescription);
      expect(admin.role).to.equal('ADMIN');
    });

    it('creates resends the activation email if the same user tries to create the same org again', async () => {
      const sendEmailspy = sinon.spy(emailLib, 'send');
      const variables = {
        individual: {
          name: randStr('New User'),
          legalName: randStr('New User Legal'),
          email: randEmail(),
        },
        organization: {
          name: 'New Organization',
          slug: randStr('new-org-'),
          description: 'This is a new organization',
          website: 'https://new.org',
        },
        roleDescription: 'Founder',
      };

      let result = await utils.graphqlQueryV2(createOrgMutation, variables);
      result.errors && console.error(result.errors);
      expect(result.data.createOrganization).to.exist;

      const createdOrg = await models.Collective.findByPk(result.data.createOrganization.legacyId);
      expect(createdOrg.name).to.equal(variables.organization.name);
      expect(createdOrg.slug).to.equal(variables.organization.slug);
      expect(createdOrg.description).to.equal(variables.organization.description);

      const firstCall = sendEmailspy.getCall(0);
      expect(firstCall).to.exist;
      expect(firstCall.args[1]).to.equal(variables.individual.email);
      expect(firstCall.args[2].loginLink).to.include(`next=/dashboard/${createdOrg.slug}`);

      result = await utils.graphqlQueryV2(createOrgMutation, variables);
      result.errors && console.error(result.errors);
      const secondCall = sendEmailspy.getCall(1);
      expect(secondCall).to.exist;
      expect(secondCall.args[1]).to.equal(variables.individual.email);
      expect(secondCall.args[2].loginLink).to.include(`next=/dashboard/${createdOrg.slug}`);

      sendEmailspy.restore();
    });
  });
});
