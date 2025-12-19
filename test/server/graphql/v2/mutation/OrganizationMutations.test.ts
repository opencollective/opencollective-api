import { expect } from 'chai';
import gql from 'fake-tag';
import sinon from 'sinon';
import speakeasy from 'speakeasy';

import { CollectiveType } from '../../../../../server/constants/collectives';
import OrderStatuses from '../../../../../server/constants/order-status';
import MemberRoles from '../../../../../server/constants/roles';
import { TransactionKind } from '../../../../../server/constants/transaction-kind';
import emailLib from '../../../../../server/lib/email';
import { crypto } from '../../../../../server/lib/encryption';
import { TwoFactorAuthenticationHeader } from '../../../../../server/lib/two-factor-authentication/lib';
import models from '../../../../../server/models';
import { randEmail } from '../../../../stores';
import { fakeCollective, fakeUser, randStr } from '../../../../test-helpers/fake-data';
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

  describe('editOrganizationMoneyManagementAndHosting', () => {
    const mutation = gql`
      mutation EditOrganizationMoneyManagementAndHosting(
        $organization: AccountReferenceInput!
        $hasMoneyManagement: Boolean
        $hasHosting: Boolean
      ) {
        editOrganizationMoneyManagementAndHosting(
          organization: $organization
          hasMoneyManagement: $hasMoneyManagement
          hasHosting: $hasHosting
        ) {
          id
          legacyId
          hasMoneyManagement
          hasHosting
        }
      }
    `;

    let adminUser, orgWithAdmin, twoFAUser, orgFor2FA, secretFor2FA;

    beforeEach(async () => {
      adminUser = await fakeUser();
      orgWithAdmin = await fakeCollective({
        type: CollectiveType.ORGANIZATION,
        admin: adminUser,
        HostCollectiveId: null,
        hasHosting: false,
      });

      // User with 2FA enabled
      twoFAUser = await fakeUser({}, {}, { enable2FA: true });
      orgFor2FA = await fakeCollective({
        type: CollectiveType.ORGANIZATION,
        admin: twoFAUser,
        HostCollectiveId: null,
        hasHosting: false,
      });
      secretFor2FA = crypto.decrypt(twoFAUser.twoFactorAuthToken);
    });

    it('requires authentication', async () => {
      const result = await utils.graphqlQueryV2(mutation, {
        organization: { legacyId: orgWithAdmin.id },
        hasMoneyManagement: true,
      });
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.match(/You need to be logged in/);
    });

    it('requires admin privileges', async () => {
      const randomUser = await fakeUser();
      const result = await utils.graphqlQueryV2(
        mutation,
        { organization: { legacyId: orgWithAdmin.id }, hasMoneyManagement: true },
        randomUser,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.match(/You are authenticated but forbidden to perform this action/);
    });

    it('activates money management with 2FA', async () => {
      const totp = speakeasy.totp({ secret: secretFor2FA, encoding: 'base32' });
      const result = await utils.graphqlQueryV2(
        mutation,
        { organization: { legacyId: orgFor2FA.id }, hasMoneyManagement: true },
        twoFAUser,
        null,
        { [TwoFactorAuthenticationHeader]: `totp ${totp}` },
      );
      expect(result.errors).to.not.exist;
      expect(result.data.editOrganizationMoneyManagementAndHosting.hasMoneyManagement).to.be.true;
      const org = await models.Collective.findByPk(orgFor2FA.id);
      expect(org.hasMoneyManagement).to.be.true;
      // Activity logged
      const activity = await models.Activity.findOne({
        where: { CollectiveId: org.id, type: 'activated.moneyManagement' },
      });
      expect(activity).to.exist;
    });

    it('requires 2FA when enabled on user', async () => {
      const result = await utils.graphqlQueryV2(
        mutation,
        { organization: { legacyId: orgFor2FA.id }, hasMoneyManagement: true },
        twoFAUser,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('Two-factor authentication required');
      expect(result.errors[0].extensions.code).to.equal('2FA_REQUIRED');
    });

    it('deactivates money management (only when hosting not active)', async () => {
      // First activate money management
      const totp1 = speakeasy.totp({ secret: secretFor2FA, encoding: 'base32' });
      await utils.graphqlQueryV2(
        mutation,
        { organization: { legacyId: orgFor2FA.id }, hasMoneyManagement: true },
        twoFAUser,
        null,
        { [TwoFactorAuthenticationHeader]: `totp ${totp1}` },
      );
      const totp2 = speakeasy.totp({ secret: secretFor2FA, encoding: 'base32' });
      const result = await utils.graphqlQueryV2(
        mutation,
        { organization: { legacyId: orgFor2FA.id }, hasMoneyManagement: false },
        twoFAUser,
        null,
        { [TwoFactorAuthenticationHeader]: `totp ${totp2}` },
      );
      expect(result.errors).to.not.exist;
      expect(result.data.editOrganizationMoneyManagementAndHosting.hasMoneyManagement).to.be.false;
      const org = await models.Collective.findByPk(orgFor2FA.id);
      expect(org.hasMoneyManagement).to.be.false;
      const activity = await models.Activity.findOne({
        where: { CollectiveId: org.id, type: 'deactivated.moneyManagement' },
      });
      expect(activity).to.exist;
    });

    it('does not activate hosting if money management is disabled', async () => {
      const totp = speakeasy.totp({ secret: secretFor2FA, encoding: 'base32' });
      const result = await utils.graphqlQueryV2(
        mutation,
        { organization: { legacyId: orgFor2FA.id }, hasHosting: true },
        twoFAUser,
        null,
        { [TwoFactorAuthenticationHeader]: `totp ${totp}` },
      );
      expect(result.errors).to.not.exist;
      expect(result.data.editOrganizationMoneyManagementAndHosting.hasHosting).to.be.false;
      const org = await models.Collective.findByPk(orgFor2FA.id);
      expect(org.hasHosting).to.be.false;
    });

    it('activates hosting only after money management active', async () => {
      // Activate money management
      const totp1 = speakeasy.totp({ secret: secretFor2FA, encoding: 'base32' });
      await utils.graphqlQueryV2(
        mutation,
        { organization: { legacyId: orgFor2FA.id }, hasMoneyManagement: true },
        twoFAUser,
        null,
        { [TwoFactorAuthenticationHeader]: `totp ${totp1}` },
      );
      // Activate hosting
      const totp2 = speakeasy.totp({ secret: secretFor2FA, encoding: 'base32' });
      const result = await utils.graphqlQueryV2(
        mutation,
        { organization: { legacyId: orgFor2FA.id }, hasHosting: true },
        twoFAUser,
        null,
        { [TwoFactorAuthenticationHeader]: `totp ${totp2}` },
      );
      expect(result.errors).to.not.exist;
      expect(result.data.editOrganizationMoneyManagementAndHosting.hasHosting).to.be.true;
      const org = await models.Collective.findByPk(orgFor2FA.id);
      expect(org.hasHosting).to.be.true;
      const activity = await models.Activity.findOne({
        where: { CollectiveId: org.id, type: 'activated.hosting' },
      });
      expect(activity).to.exist;
    });

    it('fails to deactivate money management while hosting active', async () => {
      // Activate money management & hosting
      const totp1 = speakeasy.totp({ secret: secretFor2FA, encoding: 'base32' });
      await utils.graphqlQueryV2(
        mutation,
        { organization: { legacyId: orgFor2FA.id }, hasMoneyManagement: true },
        twoFAUser,
        null,
        { [TwoFactorAuthenticationHeader]: `totp ${totp1}` },
      );
      const totp2 = speakeasy.totp({ secret: secretFor2FA, encoding: 'base32' });
      await utils.graphqlQueryV2(
        mutation,
        { organization: { legacyId: orgFor2FA.id }, hasHosting: true },
        twoFAUser,
        null,
        { [TwoFactorAuthenticationHeader]: `totp ${totp2}` },
      );
      const totp3 = speakeasy.totp({ secret: secretFor2FA, encoding: 'base32' });
      const result = await utils.graphqlQueryV2(
        mutation,
        { organization: { legacyId: orgFor2FA.id }, hasMoneyManagement: false },
        twoFAUser,
        null,
        { [TwoFactorAuthenticationHeader]: `totp ${totp3}` },
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.match(/Can't deactive money management/);
    });

    it('fails to deactivate hosting while still hosting collectives', async () => {
      // Activate money management & hosting
      const totp1 = speakeasy.totp({ secret: secretFor2FA, encoding: 'base32' });
      await utils.graphqlQueryV2(
        mutation,
        { organization: { legacyId: orgFor2FA.id }, hasMoneyManagement: true },
        twoFAUser,
        null,
        { [TwoFactorAuthenticationHeader]: `totp ${totp1}` },
      );
      const totp2 = speakeasy.totp({ secret: secretFor2FA, encoding: 'base32' });
      await utils.graphqlQueryV2(
        mutation,
        { organization: { legacyId: orgFor2FA.id }, hasHosting: true },
        twoFAUser,
        null,
        { [TwoFactorAuthenticationHeader]: `totp ${totp2}` },
      );
      // Create a hosted collective
      await fakeCollective({ HostCollectiveId: orgFor2FA.id });
      const totp3 = speakeasy.totp({ secret: secretFor2FA, encoding: 'base32' });
      const result = await utils.graphqlQueryV2(
        mutation,
        { organization: { legacyId: orgFor2FA.id }, hasHosting: false },
        twoFAUser,
        null,
        { [TwoFactorAuthenticationHeader]: `totp ${totp3}` },
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.match(/You can't deactivate hosting while still hosting/);
    });
  });

  describe('convertOrganizationToCollective', () => {
    const convertOrganizationToCollectiveMutation = gql`
      mutation ConvertOrganizationToCollective($organization: AccountReferenceInput!) {
        convertOrganizationToCollective(organization: $organization) {
          id
          legacyId
          type
          slug
          name
        }
      }
    `;

    it('requires authentication', async () => {
      const organization = await fakeCollective({ type: CollectiveType.ORGANIZATION });

      const result = await utils.graphqlQueryV2(convertOrganizationToCollectiveMutation, {
        organization: { legacyId: organization.id },
      });

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.match(/You need to be logged in/);
    });

    it('requires admin privileges', async () => {
      const adminUser = await fakeUser();
      const randomUser = await fakeUser();
      const organization = await fakeCollective({ type: CollectiveType.ORGANIZATION, admin: adminUser });

      const result = await utils.graphqlQueryV2(
        convertOrganizationToCollectiveMutation,
        { organization: { legacyId: organization.id } },
        randomUser,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.match(/forbidden/);
    });

    it('successfully converts an organization to a collective', async () => {
      const user = await fakeUser();
      const organization = await fakeCollective({ type: CollectiveType.ORGANIZATION, admin: user });

      expect(organization.type).to.equal(CollectiveType.ORGANIZATION);

      const result = await utils.graphqlQueryV2(
        convertOrganizationToCollectiveMutation,
        { organization: { legacyId: organization.id } },
        user,
      );

      expect(result.errors).to.not.exist;
      expect(result.data.convertOrganizationToCollective.type).to.equal('COLLECTIVE');

      // Verify in database
      await organization.reload();
      expect(organization.type).to.equal(CollectiveType.COLLECTIVE);

      // Check activity
      const activity = await models.Activity.findOne({
        where: {
          UserId: user.id,
          type: 'organization.convertedToCollective',
          CollectiveId: organization.id,
        },
      });

      expect(activity).to.exist;
      expect(activity.data.collective).to.exist;
    });

    it('allows root users to convert any organization', async () => {
      const adminUser = await fakeUser();
      const organization = await fakeCollective({ type: CollectiveType.ORGANIZATION, admin: adminUser });
      const rootUser = await fakeUser({ data: { isRoot: true } });

      const platform = await models.Collective.findByPk(1);
      await models.Member.create({
        MemberCollectiveId: rootUser.CollectiveId,
        CollectiveId: platform.id,
        role: MemberRoles.ADMIN,
        CreatedByUserId: rootUser.id,
      });

      const result = await utils.graphqlQueryV2(
        convertOrganizationToCollectiveMutation,
        { organization: { legacyId: organization.id } },
        rootUser,
      );

      expect(result.errors).to.not.exist;
      expect(result.data.convertOrganizationToCollective.type).to.equal('COLLECTIVE');

      await organization.reload();
      expect(organization.type).to.equal(CollectiveType.COLLECTIVE);
    });

    it('rejects conversion if account is not an organization', async () => {
      const user = await fakeUser();
      const collective = await fakeCollective({ type: CollectiveType.COLLECTIVE, admin: user });

      const result = await utils.graphqlQueryV2(
        convertOrganizationToCollectiveMutation,
        { organization: { legacyId: collective.id } },
        user,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.match(/Mutation only available to ORGANIZATION/);
    });

    it('rejects conversion if organization has hosting activated', async () => {
      const user = await fakeUser();
      const organization = await fakeCollective({
        type: CollectiveType.ORGANIZATION,
        admin: user,
        HostCollectiveId: null,
      });

      // Activate money management and hosting
      await organization.activateMoneyManagement(user);
      await organization.activateHosting();

      const result = await utils.graphqlQueryV2(
        convertOrganizationToCollectiveMutation,
        { organization: { legacyId: organization.id } },
        user,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.match(/Organization should not have Hosting activated/);
    });

    it('rejects conversion if organization has a non-zero balance', async () => {
      const user = await fakeUser();
      const organization = await fakeCollective({
        type: CollectiveType.ORGANIZATION,
        admin: user,
        HostCollectiveId: null,
      });

      // Create a transaction to give the organization a non-zero balance
      const host = await fakeCollective({ type: CollectiveType.ORGANIZATION });
      const order = await models.Order.create({
        CollectiveId: organization.id,
        FromCollectiveId: user.CollectiveId,
        CreatedByUserId: user.id,
        totalAmount: 1000,
        currency: 'USD',
        status: OrderStatuses.PAID,
      });
      await models.Transaction.create({
        CollectiveId: organization.id,
        HostCollectiveId: host.id,
        OrderId: order.id,
        amount: 1000, // cents
        currency: 'USD',
        type: 'CREDIT',
        CreatedByUserId: user.id,
        description: 'Test deposit',
        isRefund: false,
        kind: TransactionKind.CONTRIBUTION,
        amountInHostCurrency: 1000,
        netAmountInCollectiveCurrency: 0,
        netAmountInHostCurrency: 0,
        platformFeeInHostCurrency: 0,
        hostFeeInHostCurrency: 0,
        paymentProcessorFeeInHostCurrency: 0,
        hostCurrency: 'USD',
      });

      await organization.reload();

      // Assert the balance is exactly 1000
      const balance = await organization.getBalance();
      expect(balance).to.equal(1000);

      const result = await utils.graphqlQueryV2(
        convertOrganizationToCollectiveMutation,
        { organization: { legacyId: organization.id } },
        user,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.match(/Organization should have a zero balance/);
    });

    it('rejects conversion if organization has money management activated', async () => {
      const user = await fakeUser();
      const organization = await fakeCollective({
        type: CollectiveType.ORGANIZATION,
        admin: user,
        HostCollectiveId: null,
      });

      // Activate money management only
      await organization.activateMoneyManagement(user);

      const result = await utils.graphqlQueryV2(
        convertOrganizationToCollectiveMutation,
        { organization: { legacyId: organization.id } },
        user,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.match(/Organization should not have Money Management activated/);
    });

    it('enforces 2FA when enabled on account', async () => {
      const secret = speakeasy.generateSecret({ length: 64 });
      const encryptedToken = crypto.encrypt(secret.base32).toString();
      const user = await fakeUser({ twoFactorAuthToken: encryptedToken });

      const organization = await fakeCollective({ type: CollectiveType.ORGANIZATION, admin: user });

      // Try without 2FA token
      const resultWithout2FA = await utils.graphqlQueryV2(
        convertOrganizationToCollectiveMutation,
        { organization: { legacyId: organization.id } },
        user,
      );

      expect(resultWithout2FA.errors).to.exist;
      expect(resultWithout2FA.errors[0].extensions.code).to.equal('2FA_REQUIRED');

      // Try with valid 2FA token
      const twoFactorAuthenticatorCode = speakeasy.totp({
        algorithm: 'SHA1',
        encoding: 'base32',
        secret: secret.base32,
      });

      const resultWith2FA = await utils.graphqlQueryV2(
        convertOrganizationToCollectiveMutation,
        { organization: { legacyId: organization.id } },
        user,
        null,
        {
          [TwoFactorAuthenticationHeader]: `totp ${twoFactorAuthenticatorCode}`,
        },
      );

      expect(resultWith2FA.errors).to.not.exist;
      expect(resultWith2FA.data.convertOrganizationToCollective.type).to.equal('COLLECTIVE');
    });
  });
});
