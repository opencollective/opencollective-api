import { expect } from 'chai';
import gql from 'fake-tag';
import { createSandbox } from 'sinon';
import speakeasy from 'speakeasy';

import { activities as ACTIVITY, roles } from '../../../../../server/constants';
import { CollectiveType } from '../../../../../server/constants/collectives';
import FEATURE from '../../../../../server/constants/feature';
import OrderStatuses from '../../../../../server/constants/order-status';
import POLICIES from '../../../../../server/constants/policies';
import MemberRoles from '../../../../../server/constants/roles';
import { idEncode } from '../../../../../server/graphql/v2/identifiers';
import emailLib from '../../../../../server/lib/email';
import { TwoFactorAuthenticationHeader } from '../../../../../server/lib/two-factor-authentication/lib';
import * as yubikeyOtp from '../../../../../server/lib/two-factor-authentication/yubikey-otp';
import models from '../../../../../server/models';
import {
  fakeActiveHost,
  fakeCollective,
  fakeEvent,
  fakeHost,
  fakeLocation,
  fakeOrder,
  fakeProject,
  fakeTier,
  fakeUser,
  fakeUserTwoFactorMethod,
  randStr,
} from '../../../../test-helpers/fake-data';
import { graphqlQueryV2, resetTestDB, waitForCondition } from '../../../../utils';

const editSettingsMutation = gql`
  mutation EditSettings($account: AccountReferenceInput!, $key: AccountSettingsKey!, $value: JSON!) {
    editAccountSetting(account: $account, key: $key, value: $value) {
      id
      settings
    }
  }
`;

const addTwoFactorAuthTokenMutation = gql`
  mutation AddTwoFactorAuthToIndividual($account: AccountReferenceInput!, $token: String!, $type: TwoFactorMethod) {
    addTwoFactorAuthTokenToIndividual(account: $account, token: $token, type: $type) {
      account {
        id
        ... on Individual {
          hasTwoFactorAuth
        }
      }
      recoveryCodes
    }
  }
`;

const removeTwoFactorAuthTokenMutation = gql`
  mutation RemoveTwoFactorAuthTokenFromIndividual($account: AccountReferenceInput!, $type: TwoFactorMethod) {
    removeTwoFactorAuthTokenFromIndividual(account: $account, type: $type) {
      hasTwoFactorAuth
    }
  }
`;

const editAccountFeeStructureMutation = gql`
  mutation EditAccountFeeStructure($account: AccountReferenceInput!, $hostFeePercent: Float!, $isCustomFee: Boolean!) {
    editAccountFeeStructure(account: $account, hostFeePercent: $hostFeePercent, isCustomFee: $isCustomFee) {
      id
      childrenAccounts {
        nodes {
          ... on AccountWithHost {
            hostFeePercent
            hostFeesStructure
          }
        }
      }
      ... on AccountWithHost {
        hostFeePercent
        hostFeesStructure
      }
    }
  }
`;

const createWebAuthnRegistrationOptionsMutation = gql`
  mutation AddTwoFactorAuthToIndividual($account: AccountReferenceInput!) {
    createWebAuthnRegistrationOptions(account: $account)
  }
`;

const duplicateAccountMutation = gql`
  mutation DuplicateAccount(
    $account: AccountReferenceInput!
    $newSlug: String
    $include: DuplicateAccountDataTypeInput
    $connect: Boolean
  ) {
    duplicateAccount(account: $account, newSlug: $newSlug, include: $include, connect: $connect) {
      id
      legacyId
      name
      description
      longDescription
      slug
      members {
        nodes {
          role
          account {
            id
            slug
          }
        }
      }
    }
  }
`;

describe('server/graphql/v2/mutation/AccountMutations', () => {
  let adminUser, secondAdminUser, randomUser, hostAdminUser, backerUser, collective;

  before(async () => {
    await resetTestDB();
    adminUser = await fakeUser(null, { name: 'Admin Name' });
    secondAdminUser = await fakeUser(null, { name: 'Admin Name 2' });
    randomUser = await fakeUser();
    backerUser = await fakeUser();
    hostAdminUser = await fakeUser();
    const host = await fakeHost({ admin: hostAdminUser });
    collective = await fakeCollective({
      admin: adminUser,
      HostCollectiveId: host.id,
      name: 'Bushwick',
      slug: 'bushwick',
      description: 'Doing stuff',
      longDescription: 'Doing more stuff',
      expensePolicy: 'Be reasonable',
      contributionPolicy: 'Be generous',
      currency: 'EUR',
      website: 'https://opencollective.com',
      countryISO: 'FR',
      tags: ['mutual-aid', 'meetup'],
    });
    await collective.addUserWithRole(backerUser, roles.BACKER);

    // Create some children (event + project)
    await Promise.all([
      fakeEvent({ ParentCollectiveId: collective.id, isActive: true }),
      fakeProject({ ParentCollectiveId: collective.id, isActive: true }),
      fakeProject({ ParentCollectiveId: collective.id, isActive: false }),
    ]);

    // Add some members
    await Promise.all([
      collective.addUserWithRole(secondAdminUser, roles.ADMIN),
      collective.addUserWithRole(backerUser, roles.BACKER),
    ]);

    // Add some tiers
    await fakeTier({ CollectiveId: collective.id, description: 'Tier 1 to be copied' });

    // Add a location
    await fakeLocation({ CollectiveId: collective.id });
  });

  describe('editAccountSetting', () => {
    beforeEach(async () => {
      await collective.update({ settings: {} });
    });

    it('must be authenticated', async () => {
      const result = await graphqlQueryV2(editSettingsMutation, {
        account: { legacyId: collective.id },
        key: 'tos',
        value: 'https://opencollective.com/tos',
      });
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.match(/You need to be authenticated to perform this action/);
    });

    it('must be admin', async () => {
      const result = await graphqlQueryV2(
        editSettingsMutation,
        {
          account: { legacyId: collective.id },
          key: 'tos',
          value: 'https://opencollective.com/tos',
        },
        randomUser,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.match(/You are authenticated but forbidden to perform this action/);
    });

    it('edits the settings', async () => {
      const result = await graphqlQueryV2(
        editSettingsMutation,
        {
          account: { legacyId: collective.id },
          key: 'tos',
          value: 'https://opencollective.com/tos',
        },
        adminUser,
      );

      expect(result.errors).to.not.exist;
      expect(result.data.editAccountSetting.settings).to.deep.eq({ tos: 'https://opencollective.com/tos' });

      // Check activity
      const activity = await models.Activity.findOne({
        where: { UserId: adminUser.id, type: ACTIVITY.COLLECTIVE_EDITED },
      });

      expect(activity).to.exist;
      expect(activity.CollectiveId).to.equal(collective.id);
      expect(activity.data).to.containSubset({
        previousData: { settings: {} },
        newData: { settings: { tos: 'https://opencollective.com/tos' } },
      });
    });

    it('asynchronous mutations are properly supported', async () => {
      const keys = ['lang', 'apply'];
      const baseParams = { account: { legacyId: collective.id } };
      const results = await Promise.all(
        keys.map(key => {
          return graphqlQueryV2(editSettingsMutation, { ...baseParams, key, value: 'New value!' }, adminUser);
        }),
      );

      // Ensure all queries ran fine
      results.forEach(result => {
        expect(result.errors).to.not.exist;
      });

      // Make sure settings were updated correctly
      await collective.reload();
      keys.forEach(key => {
        expect(collective.settings[key]).to.eq('New value!');
      });
    });

    it('refuses unknown settings keys', async () => {
      const result = await graphqlQueryV2(
        editSettingsMutation,
        {
          account: { legacyId: collective.id },
          key: 'anInvalidKey!',
          value: 'https://opencollective.com/tos',
        },
        adminUser,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.match(/Variable "\$key" got invalid value "anInvalidKey\!"/);
    });

    it('can set nested values', async () => {
      const result = await graphqlQueryV2(
        editSettingsMutation,
        {
          account: { legacyId: collective.id },
          key: 'collectivePage.background.zoom',
          value: 0.5,
        },
        adminUser,
      );

      expect(result.errors).to.not.exist;
      expect(result.data.editAccountSetting.settings).to.deep.eq({ collectivePage: { background: { zoom: 0.5 } } });

      const result2 = await graphqlQueryV2(
        editSettingsMutation,
        {
          account: { legacyId: collective.id },
          key: 'collectivePage.background.crop',
          value: { x: 0, y: 0 },
        },
        adminUser,
      );

      expect(result2.errors).to.not.exist;
      expect(result2.data.editAccountSetting.settings).to.deep.eq({
        collectivePage: { background: { zoom: 0.5, crop: { x: 0, y: 0 } } },
      });
    });

    it('validates settings and refuses bad values for specific keys', async () => {
      const result = await graphqlQueryV2(
        editSettingsMutation,
        {
          account: { legacyId: collective.id },
          key: 'moderation',
          value: { rejectedCategories: ['ADULT', 'NOT_A_MODERATION_CATEGORY'] },
        },
        adminUser,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.match(/Invalid filtering category/);
    });

    it('validates that the terms of service is a proper url address', async () => {
      const result = await graphqlQueryV2(
        editSettingsMutation,
        {
          account: { legacyId: collective.id },
          key: 'tos',
          value: 'This is not a url.',
        },
        adminUser,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.match(
        /Enter a valid URL. The URL should have the format https:\/\/opencollective.com\//,
      );
    });
  });

  describe('addTwoFactorAuthTokenToIndividual', () => {
    const sandbox = createSandbox();
    afterEach(sandbox.restore);

    const secret = speakeasy.generateSecret({ length: 64 });
    it('must be authenticated', async () => {
      const result = await graphqlQueryV2(addTwoFactorAuthTokenMutation, {
        account: { id: idEncode(adminUser.collective.id, 'account') },
        token: secret.base32,
      });
      expect(result.errors).to.exist;
      expect(result.errors[0].extensions.code).to.equal('Unauthorized');
    });

    it('must be admin', async () => {
      const result = await graphqlQueryV2(
        addTwoFactorAuthTokenMutation,
        {
          account: { id: idEncode(adminUser.collective.id, 'account') },
          token: secret.base32,
        },
        randomUser,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.match(/You are authenticated but forbidden to perform this action/);
    });

    it('adds 2FA to the user', async () => {
      const result = await graphqlQueryV2(
        addTwoFactorAuthTokenMutation,
        {
          account: { id: idEncode(adminUser.collective.id, 'account') },
          token: secret.base32,
        },
        adminUser,
      );
      expect(result.errors).to.not.exist;
      expect(result.data.addTwoFactorAuthTokenToIndividual.account.hasTwoFactorAuth).to.eq(true);
      expect(result.data.addTwoFactorAuthTokenToIndividual.recoveryCodes).to.have.lengthOf(6);

      // Check activity
      const activity = await models.Activity.findOne({
        where: { UserId: adminUser.id, type: ACTIVITY.TWO_FACTOR_METHOD_ADDED },
      });

      expect(activity).to.exist;
      expect(activity.CollectiveId).to.equal(adminUser.collective.id);
    });

    it('asks for 2FA if user already has 2FA', async () => {
      const result = await graphqlQueryV2(
        addTwoFactorAuthTokenMutation,
        {
          account: { id: idEncode(adminUser.collective.id, 'account') },
          token: secret.base32,
        },
        adminUser,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.match(/Two-factor authentication required/);
    });

    it('Adds multiple methods', async () => {
      sandbox.stub(yubikeyOtp, 'validateYubikeyOTP').resolves(true);
      sandbox.stub(yubikeyOtp.default, 'validateToken').resolves(true);
      const user = await fakeUser();
      let result = await graphqlQueryV2(
        addTwoFactorAuthTokenMutation,
        {
          account: { id: idEncode(user.collective.id, 'account') },
          token: 'cccc....',
          type: 'YUBIKEY_OTP',
        },
        user,
      );

      expect(result.errors).to.not.exist;
      expect(result.data.addTwoFactorAuthTokenToIndividual.account.hasTwoFactorAuth).to.eq(true);
      expect(result.data.addTwoFactorAuthTokenToIndividual.recoveryCodes).to.have.lengthOf(6);

      result = await graphqlQueryV2(
        addTwoFactorAuthTokenMutation,
        {
          account: { id: idEncode(user.collective.id, 'account') },
          token: secret.base32,
          type: 'TOTP',
        },
        user,
        null,
        {
          [TwoFactorAuthenticationHeader]: 'yubikey_otp 1234',
        },
      );

      expect(result.errors).to.not.exist;
      expect(result.data.addTwoFactorAuthTokenToIndividual.account.hasTwoFactorAuth).to.eq(true);
      expect(result.data.addTwoFactorAuthTokenToIndividual.recoveryCodes).to.be.null;
    });
  });

  describe('removeTwoFactorAuthTokenFromIndividual', () => {
    const sandbox = createSandbox();
    afterEach(sandbox.restore);

    let user;
    const secret = speakeasy.generateSecret({ length: 64 });

    beforeEach(async () => {
      sandbox.stub(yubikeyOtp, 'validateYubikeyOTP').resolves(true);
      sandbox.stub(yubikeyOtp.default, 'validateToken').resolves(true);
      user = await fakeUser();
      let result = await graphqlQueryV2(
        addTwoFactorAuthTokenMutation,
        {
          account: { id: idEncode(user.collective.id, 'account') },
          token: 'cccc....',
          type: 'YUBIKEY_OTP',
        },
        user,
      );

      expect(result.errors).to.not.exist;
      expect(result.data.addTwoFactorAuthTokenToIndividual.account.hasTwoFactorAuth).to.eq(true);
      expect(result.data.addTwoFactorAuthTokenToIndividual.recoveryCodes).to.have.lengthOf(6);

      result = await graphqlQueryV2(
        addTwoFactorAuthTokenMutation,
        {
          account: { id: idEncode(user.collective.id, 'account') },
          token: secret.base32,
          type: 'TOTP',
        },
        user,
        null,
        {
          [TwoFactorAuthenticationHeader]: `yubikey_otp 1234`,
        },
      );

      expect(result.errors).to.not.exist;
      expect(result.data.addTwoFactorAuthTokenToIndividual.account.hasTwoFactorAuth).to.eq(true);
      expect(result.data.addTwoFactorAuthTokenToIndividual.recoveryCodes).to.be.null;
      await user.reload();
    });

    it('removes totp', async () => {
      const result = await graphqlQueryV2(
        removeTwoFactorAuthTokenMutation,
        {
          account: { id: idEncode(user.collective.id, 'account') },
          type: 'TOTP',
        },
        user,
        null,
        {
          [TwoFactorAuthenticationHeader]: `yubikey_otp 1234`,
        },
      );

      expect(result.errors).to.not.exist;
      expect(result.data.removeTwoFactorAuthTokenFromIndividual.hasTwoFactorAuth).to.eq(true);
    });

    it('removes yubikey', async () => {
      const result = await graphqlQueryV2(
        removeTwoFactorAuthTokenMutation,
        {
          account: { id: idEncode(user.collective.id, 'account') },
          type: 'YUBIKEY_OTP',
        },
        user,
        null,
        {
          [TwoFactorAuthenticationHeader]: `yubikey_otp 1234`,
        },
      );

      expect(result.errors).to.not.exist;
      expect(result.data.removeTwoFactorAuthTokenFromIndividual.hasTwoFactorAuth).to.eq(true);
    });

    it('removes all methods', async () => {
      let result = await graphqlQueryV2(
        removeTwoFactorAuthTokenMutation,
        {
          account: { id: idEncode(user.collective.id, 'account') },
          type: 'TOTP',
        },
        user,
        null,
        {
          [TwoFactorAuthenticationHeader]: `yubikey_otp 1234`,
        },
      );

      expect(result.errors).to.not.exist;
      expect(result.data.removeTwoFactorAuthTokenFromIndividual.hasTwoFactorAuth).to.eq(true);

      result = await graphqlQueryV2(
        removeTwoFactorAuthTokenMutation,
        {
          account: { id: idEncode(user.collective.id, 'account') },
          type: 'YUBIKEY_OTP',
        },
        user,
        null,
        {
          [TwoFactorAuthenticationHeader]: `yubikey_otp 1234`,
        },
      );

      expect(result.errors).to.not.exist;
      expect(result.data.removeTwoFactorAuthTokenFromIndividual.hasTwoFactorAuth).to.eq(false);
    });

    it('removes all methods once', async () => {
      const result = await graphqlQueryV2(
        removeTwoFactorAuthTokenMutation,
        {
          account: { id: idEncode(user.collective.id, 'account') },
        },
        user,
        null,
        {
          [TwoFactorAuthenticationHeader]: `yubikey_otp 1234`,
        },
      );

      expect(result.errors).to.not.exist;
      expect(result.data.removeTwoFactorAuthTokenFromIndividual.hasTwoFactorAuth).to.eq(false);
    });
  });

  describe('editAccountFeeStructure', () => {
    it('must be a host admin', async () => {
      const mutationParams = { account: { legacyId: collective.id }, hostFeePercent: 8.88, isCustomFee: true };
      const resultUnauthenticated = await graphqlQueryV2(editAccountFeeStructureMutation, mutationParams);
      expect(resultUnauthenticated.errors).to.exist;
      expect(resultUnauthenticated.errors[0].extensions.code).to.equal('Unauthorized');

      const resultRandomUser = await graphqlQueryV2(editAccountFeeStructureMutation, mutationParams, randomUser);
      expect(resultRandomUser.errors).to.exist;
      expect(resultUnauthenticated.errors[0].extensions.code).to.equal('Unauthorized');

      const resultBacker = await graphqlQueryV2(editAccountFeeStructureMutation, mutationParams, backerUser);
      expect(resultBacker.errors).to.exist;
      expect(resultUnauthenticated.errors[0].extensions.code).to.equal('Unauthorized');

      const resultCollectiveAdmin = await graphqlQueryV2(editAccountFeeStructureMutation, mutationParams, adminUser);
      expect(resultCollectiveAdmin.errors).to.exist;
      expect(resultUnauthenticated.errors[0].extensions.code).to.equal('Unauthorized');
    });

    it('updates the main account and all its children', async () => {
      const mutationParams = { account: { legacyId: collective.id }, hostFeePercent: 9.99, isCustomFee: true };
      const result = await graphqlQueryV2(editAccountFeeStructureMutation, mutationParams, hostAdminUser);
      const editedAccount = result.data.editAccountFeeStructure;
      const children = editedAccount.childrenAccounts.nodes;
      expect(editedAccount.hostFeePercent).to.eq(9.99);
      expect(editedAccount.hostFeesStructure).to.eq('CUSTOM_FEE');
      expect(children.length).to.eq(3);
      children.forEach(child => {
        expect(child.hostFeePercent).to.eq(9.99);
        expect(child.hostFeesStructure).to.eq('CUSTOM_FEE');
      });

      // Check activity
      const activity = await models.Activity.findOne({
        where: { UserId: hostAdminUser.id, type: ACTIVITY.COLLECTIVE_EDITED },
      });

      expect(activity).to.exist;
      expect(activity.CollectiveId).to.equal(collective.id);
      expect(activity.data).to.containSubset({
        previousData: { hostFeePercent: 10 },
        newData: { hostFeePercent: 9.99, useCustomHostFee: true },
      });
    });
  });

  describe('editAccountFreezeStatus', () => {
    let sandbox, sendEmailSpy;
    const editAccountFreezeStatusMutation = gql`
      mutation EditAccountFreezeStatus(
        $account: AccountReferenceInput!
        $action: AccountFreezeAction!
        $messageForAccountAdmins: String
        $messageForContributors: String
        $pauseExistingRecurringContributions: Boolean
      ) {
        editAccountFreezeStatus(
          account: $account
          action: $action
          messageForAccountAdmins: $messageForAccountAdmins
          messageForContributors: $messageForContributors
          pauseExistingRecurringContributions: $pauseExistingRecurringContributions
        ) {
          id
          isFrozen
          features {
            ALL
            RECEIVE_FINANCIAL_CONTRIBUTIONS
            USE_EXPENSES
          }
          childrenAccounts {
            nodes {
              id
              isFrozen
              type
              features {
                ALL
                RECEIVE_FINANCIAL_CONTRIBUTIONS
                USE_EXPENSES
              }
            }
          }
        }
      }
    `;

    before(() => {
      sandbox = createSandbox();
      sendEmailSpy = sandbox.spy(emailLib, 'sendMessage');
    });

    after(() => {
      sandbox.restore();
    });

    afterEach(() => {
      sendEmailSpy.resetHistory();
    });

    const expectAllFeaturesDisabled = features =>
      Object.values(features).forEach(value => expect(value).to.equal('DISABLED'));

    it('must have a fiscal host', async () => {
      const collectiveAdmin = await fakeUser();
      const collective = await fakeCollective({ HostCollectiveId: null, admin: collectiveAdmin });
      const mutationParams = { account: { legacyId: collective.id }, action: 'FREEZE' };
      const result = await graphqlQueryV2(editAccountFreezeStatusMutation, mutationParams, collectiveAdmin);
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('Cannot find the host of this account');
    });

    it("must be a host admin of the collective's fiscal host", async () => {
      const collectiveAdmin = await fakeUser();
      const collective = await fakeCollective({ admin: collectiveAdmin });
      const mutationParams = { account: { legacyId: collective.id }, action: 'FREEZE' };
      const resultUnauthenticated = await graphqlQueryV2(editAccountFreezeStatusMutation, mutationParams);
      expect(resultUnauthenticated.errors).to.exist;
      expect(resultUnauthenticated.errors[0].extensions.code).to.equal('Unauthorized');

      const resultRandomUser = await graphqlQueryV2(editAccountFreezeStatusMutation, mutationParams, randomUser);
      expect(resultRandomUser.errors).to.exist;
      expect(resultRandomUser.errors[0].extensions.code).to.equal('Unauthorized');

      const resultCollectiveAdmin = await graphqlQueryV2(
        editAccountFreezeStatusMutation,
        mutationParams,
        collectiveAdmin,
      );
      expect(resultCollectiveAdmin.errors).to.exist;
      expect(resultCollectiveAdmin.errors[0].extensions.code).to.equal('Unauthorized');
    });

    it('must be a COLLECTIVE or FUND (no children)', async () => {
      const hostAdmin = await fakeUser();
      const host = await fakeActiveHost({ admin: hostAdmin });
      const collective = await fakeCollective({ HostCollectiveId: host.id });

      const event = await fakeEvent({ ParentCollectiveId: collective.id });
      const mutationParams = { account: { legacyId: event.id }, action: 'FREEZE' };
      let result = await graphqlQueryV2(editAccountFreezeStatusMutation, mutationParams, hostAdmin);
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal(
        'Only collective and funds can be frozen. To freeze children accounts (projects, events) you need to freeze the parent account.',
      );

      const project = await fakeProject({ ParentCollectiveId: collective.id });
      mutationParams.account.legacyId = project.id;
      result = await graphqlQueryV2(editAccountFreezeStatusMutation, mutationParams, hostAdmin);
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal(
        'Only collective and funds can be frozen. To freeze children accounts (projects, events) you need to freeze the parent account.',
      );
    });

    it('throws if already frozen', async () => {
      const hostAdmin = await fakeUser();
      const host = await fakeActiveHost({ admin: hostAdmin });
      const collective = await fakeCollective({ HostCollectiveId: host.id });
      await collective.disableFeature(FEATURE.ALL);

      const mutationParams = { account: { legacyId: collective.id }, action: 'FREEZE' };
      const result = await graphqlQueryV2(editAccountFreezeStatusMutation, mutationParams, hostAdmin);
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('This account is already frozen');
    });

    describe('when not pausing existing subscriptions (default)', () => {
      it('freezes the account and its children', async () => {
        const hostAdmin = await fakeUser();
        const host = await fakeActiveHost({ admin: hostAdmin });
        const collectiveAdmin = await fakeUser();
        const collective = await fakeCollective({ admin: collectiveAdmin, HostCollectiveId: host.id });
        const existingOrder = await fakeOrder(
          { status: OrderStatuses.ACTIVE, CollectiveId: collective.id },
          { withSubscription: true },
        );
        await fakeEvent({ ParentCollectiveId: collective.id });
        await fakeProject({ ParentCollectiveId: collective.id });

        const messageForAccountAdmins = 'This is <strong>unacceptable</strong>!';
        const mutationParams = { action: 'FREEZE', account: { legacyId: collective.id }, messageForAccountAdmins };
        const result = await graphqlQueryV2(editAccountFreezeStatusMutation, mutationParams, hostAdmin);
        result.errors && console.error(result.errors);
        expect(result.errors).to.not.exist;

        // Make sure all accounts are frozen, features marked as disabled
        expect(result.data.editAccountFreezeStatus.isFrozen).to.be.true;
        expect(result.data.editAccountFreezeStatus.childrenAccounts.nodes).to.have.length(2);
        expect(result.data.editAccountFreezeStatus.childrenAccounts.nodes[0].isFrozen).to.be.true;
        expect(result.data.editAccountFreezeStatus.childrenAccounts.nodes[1].isFrozen).to.be.true;
        expectAllFeaturesDisabled(result.data.editAccountFreezeStatus.features);
        expectAllFeaturesDisabled(result.data.editAccountFreezeStatus.childrenAccounts.nodes[0].features);
        expectAllFeaturesDisabled(result.data.editAccountFreezeStatus.childrenAccounts.nodes[1].features);

        // Order should not be affected
        await existingOrder.reload();
        expect(existingOrder.status).to.equal(OrderStatuses.ACTIVE);
        expect(existingOrder.data?.needsAsyncPause).to.be.undefined;

        // Check activity
        const activity = await models.Activity.findOne({
          where: {
            type: ACTIVITY.COLLECTIVE_FROZEN,
            UserId: hostAdmin.id,
            CollectiveId: collective.id,
            HostCollectiveId: host.id,
          },
        });

        expect(activity).to.exist;
        expect(activity.data.pauseExistingRecurringContributions).to.equal(false);

        // Check email
        await waitForCondition(() => sendEmailSpy.callCount === 1);
        expect(sendEmailSpy.args[0][0]).to.equal(collectiveAdmin.email);
        expect(sendEmailSpy.args[0][1]).to.equal(`Important: ${collective.name} has been frozen by ${host.name}`);
        expect(sendEmailSpy.args[0][2]).to.include(
          'the Collective will still continue to receive recurring donations that were started before this freeze',
        );
        expect(sendEmailSpy.args[0][2]).to.include(`This is &lt;strong&gt;unacceptable&lt;/strong&gt;!`); // HTML is not supported (it's a simple textarea). Make sure it's escaped.
      });

      it('unfreezes the account and its children', async () => {
        const hostAdmin = await fakeUser();
        const host = await fakeActiveHost({ admin: hostAdmin });
        const collectiveAdmin = await fakeUser();
        const collective = await fakeCollective({ HostCollectiveId: host.id, admin: collectiveAdmin });
        await collective.disableFeature(FEATURE.ALL);
        await fakeEvent({ ParentCollectiveId: collective.id });
        await fakeProject({ ParentCollectiveId: collective.id });

        const messageForAccountAdmins = 'Ok, this is <strong>acceptable</strong>...';
        const mutationParams = { action: 'UNFREEZE', account: { legacyId: collective.id }, messageForAccountAdmins };
        const { data, errors } = await graphqlQueryV2(editAccountFreezeStatusMutation, mutationParams, hostAdmin);
        expect(errors).to.not.exist;

        // Make sure all accounts are unfrozen, features marked as enabled
        expect(data.editAccountFreezeStatus.isFrozen).to.be.false;
        expect(data.editAccountFreezeStatus.childrenAccounts.nodes).to.have.length(2);
        expect(data.editAccountFreezeStatus.features.ALL).to.equal('ACTIVE');
        expect(data.editAccountFreezeStatus.features.RECEIVE_FINANCIAL_CONTRIBUTIONS).to.equal('AVAILABLE');
        expect(data.editAccountFreezeStatus.features.USE_EXPENSES).to.equal('ACTIVE');

        const returnedProject = data.editAccountFreezeStatus.childrenAccounts.nodes.find(a => a.type === 'PROJECT');
        expect(returnedProject.isFrozen).to.be.false;
        expect(returnedProject.features.ALL).to.equal('ACTIVE');
        expect(returnedProject.features.RECEIVE_FINANCIAL_CONTRIBUTIONS).to.equal('AVAILABLE');
        expect(returnedProject.features.USE_EXPENSES).to.equal('ACTIVE');

        const returnedEvent = data.editAccountFreezeStatus.childrenAccounts.nodes.find(a => a.type === 'EVENT');
        expect(returnedEvent.isFrozen).to.be.false;
        expect(returnedEvent.features.ALL).to.equal('ACTIVE');
        expect(returnedEvent.features.RECEIVE_FINANCIAL_CONTRIBUTIONS).to.equal('AVAILABLE');
        expect(returnedEvent.features.USE_EXPENSES).to.equal('ACTIVE');

        // Check activity
        const activity = await models.Activity.findOne({
          where: {
            type: ACTIVITY.COLLECTIVE_UNFROZEN,
            UserId: hostAdmin.id,
            CollectiveId: collective.id,
            HostCollectiveId: host.id,
          },
        });

        expect(activity).to.exist;

        // Check email
        await waitForCondition(() => sendEmailSpy.callCount === 1);
        expect(sendEmailSpy.args[0][0]).to.equal(collectiveAdmin.email);
        expect(sendEmailSpy.args[0][1]).to.equal(`Important: ${collective.name} has been unfrozen by ${host.name}`);
        expect(sendEmailSpy.args[0][2]).to.include('has unfrozen your Collective');
        expect(sendEmailSpy.args[0][2]).to.include(`Ok, this is &lt;strong&gt;acceptable&lt;/strong&gt;...`); // HTML is not supported (it's a simple textarea). Make sure it's escaped.
      });
    });

    describe('when pausing existing subscriptions', () => {
      it('must provide a message for contributors (PayPal requirement)', async () => {
        const hostAdmin = await fakeUser();
        const host = await fakeActiveHost({ admin: hostAdmin });
        const collectiveAdmin = await fakeUser();
        const collective = await fakeCollective({ HostCollectiveId: host.id, admin: collectiveAdmin });
        const mutationParams = {
          action: 'FREEZE',
          account: { legacyId: collective.id },
          messageForAccountAdmins: 'This is <strong>unacceptable</strong>!',
          pauseExistingRecurringContributions: true,
        };
        const result = await graphqlQueryV2(editAccountFreezeStatusMutation, mutationParams, hostAdmin);
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.equal(
          'You must provide a message for contributors when pausing recurring contributions',
        );
      });

      it('freezes the account and its children and pauses contributions', async () => {
        const hostAdmin = await fakeUser();
        const host = await fakeActiveHost({ admin: hostAdmin });
        const collectiveAdmin = await fakeUser();
        const collective = await fakeCollective({ HostCollectiveId: host.id, admin: collectiveAdmin });
        const event = await fakeEvent({ ParentCollectiveId: collective.id });
        await fakeProject({ ParentCollectiveId: collective.id });
        const existingOrder = await fakeOrder(
          { status: OrderStatuses.ACTIVE, CollectiveId: collective.id },
          { withSubscription: true },
        );
        const childOrder = await fakeOrder(
          { status: OrderStatuses.ACTIVE, CollectiveId: event.id },
          { withSubscription: true },
        );

        const mutationParams = {
          action: 'FREEZE',
          account: { legacyId: collective.id },
          messageForAccountAdmins: 'This is <strong>unacceptable</strong>!',
          pauseExistingRecurringContributions: true,
          messageForContributors:
            'Dear contributors, we are freezing the account for a while. We will let you know when it is back to normal.',
        };
        const result = await graphqlQueryV2(editAccountFreezeStatusMutation, mutationParams, hostAdmin);
        result.errors && console.error(result.errors);
        expect(result.errors).to.not.exist;

        // Make sure all accounts are frozen, features marked as disabled
        expect(result.data.editAccountFreezeStatus.isFrozen).to.be.true;
        expect(result.data.editAccountFreezeStatus.childrenAccounts.nodes).to.have.length(2);
        expect(result.data.editAccountFreezeStatus.childrenAccounts.nodes[0].isFrozen).to.be.true;
        expect(result.data.editAccountFreezeStatus.childrenAccounts.nodes[1].isFrozen).to.be.true;
        expectAllFeaturesDisabled(result.data.editAccountFreezeStatus.features);
        expectAllFeaturesDisabled(result.data.editAccountFreezeStatus.childrenAccounts.nodes[0].features);
        expectAllFeaturesDisabled(result.data.editAccountFreezeStatus.childrenAccounts.nodes[1].features);

        // Orders should be paused
        await existingOrder.reload();
        expect(existingOrder.status).to.equal(OrderStatuses.PAUSED);
        expect(existingOrder.data?.needsAsyncPause).to.be.true;
        await childOrder.reload();
        expect(childOrder.status).to.equal(OrderStatuses.PAUSED);
        expect(childOrder.data?.needsAsyncPause).to.be.true;

        // Check activity
        const activity = await models.Activity.findOne({
          where: {
            type: ACTIVITY.COLLECTIVE_FROZEN,
            UserId: hostAdmin.id,
            CollectiveId: collective.id,
            HostCollectiveId: host.id,
          },
        });

        expect(activity).to.exist;
        expect(activity.data.messageForContributors).to.equal(mutationParams.messageForContributors);
        expect(activity.data.pauseExistingRecurringContributions).to.equal(true);

        // Check email
        await waitForCondition(() => sendEmailSpy.callCount === 1);
        expect(sendEmailSpy.args[0][0]).to.equal(collectiveAdmin.email);
        expect(sendEmailSpy.args[0][1]).to.equal(`Important: ${collective.name} has been frozen by ${host.name}`);
        expect(sendEmailSpy.args[0][2]).to.include(
          'All existing recurring contributions have been paused, and will not be processed until the Collective is unfrozen',
        );
        expect(sendEmailSpy.args[0][2]).to.include(`This is &lt;strong&gt;unacceptable&lt;/strong&gt;!`); // HTML is not supported (it's a simple textarea). Make sure it's escaped.
      });

      it('unfreezes the account and its children and resumes contributions', async () => {
        const hostAdmin = await fakeUser();
        const host = await fakeActiveHost({ admin: hostAdmin });
        const collectiveAdmin = await fakeUser();
        const collective = await fakeCollective({ HostCollectiveId: host.id, admin: collectiveAdmin });
        await collective.disableFeature(FEATURE.ALL);
        await fakeEvent({ ParentCollectiveId: collective.id });
        const project = await fakeProject({ ParentCollectiveId: collective.id });
        const existingOrder = await fakeOrder(
          { status: OrderStatuses.PAUSED, CollectiveId: project.id },
          { withSubscription: true },
        );

        const mutationParams = {
          action: 'UNFREEZE',
          account: { legacyId: collective.id },
          messageForAccountAdmins: 'Ok, this is <strong>acceptable</strong>...',
          pauseExistingRecurringContributions: true,
          messageForContributors:
            'Dear contributors, we have unfrozen the account. Your recurring contributions will resume shortly.',
        };
        const { data, errors } = await graphqlQueryV2(editAccountFreezeStatusMutation, mutationParams, hostAdmin);
        expect(errors).to.not.exist;

        // Make sure all accounts are unfrozen, features marked as enabled
        expect(data.editAccountFreezeStatus.isFrozen).to.be.false;
        expect(data.editAccountFreezeStatus.features.ALL).to.equal('ACTIVE');
        expect(data.editAccountFreezeStatus.features.RECEIVE_FINANCIAL_CONTRIBUTIONS).to.equal('AVAILABLE');
        expect(data.editAccountFreezeStatus.features.USE_EXPENSES).to.equal('ACTIVE');

        const returnedProject = data.editAccountFreezeStatus.childrenAccounts.nodes.find(a => a.type === 'PROJECT');
        expect(data.editAccountFreezeStatus.childrenAccounts.nodes).to.have.length(2);
        expect(returnedProject.isFrozen).to.be.false;
        expect(returnedProject.features.ALL).to.equal('ACTIVE');
        expect(returnedProject.features.RECEIVE_FINANCIAL_CONTRIBUTIONS).to.equal('AVAILABLE');
        expect(returnedProject.features.USE_EXPENSES).to.equal('ACTIVE');

        const returnedEvent = data.editAccountFreezeStatus.childrenAccounts.nodes.find(a => a.type === 'EVENT');
        expect(returnedEvent.isFrozen).to.be.false;
        expect(returnedEvent.features.ALL).to.equal('ACTIVE');
        expect(returnedEvent.features.RECEIVE_FINANCIAL_CONTRIBUTIONS).to.equal('AVAILABLE');
        expect(returnedEvent.features.USE_EXPENSES).to.equal('ACTIVE');

        // Check order
        await existingOrder.reload();
        expect(existingOrder.status).to.equal(OrderStatuses.PAUSED);
        expect(existingOrder.data?.needsAsyncReactivation).to.be.true;

        // Check activity
        const activity = await models.Activity.findOne({
          where: {
            type: ACTIVITY.COLLECTIVE_UNFROZEN,
            UserId: hostAdmin.id,
            CollectiveId: collective.id,
            HostCollectiveId: host.id,
          },
        });

        expect(activity).to.exist;
        expect(activity.data.messageForContributors).to.equal(mutationParams.messageForContributors);

        // Check email
        await waitForCondition(() => sendEmailSpy.callCount === 1);
        expect(sendEmailSpy.args[0][0]).to.equal(collectiveAdmin.email);
        expect(sendEmailSpy.args[0][1]).to.equal(`Important: ${collective.name} has been unfrozen by ${host.name}`);
        expect(sendEmailSpy.args[0][2]).to.include('has unfrozen your Collective');
        expect(sendEmailSpy.args[0][2]).to.include(`Ok, this is &lt;strong&gt;acceptable&lt;/strong&gt;...`); // HTML is not supported (it's a simple textarea). Make sure it's escaped.
      });
    });
  });

  describe('setPolicies', () => {
    const setPoliciesMutation = gql`
      mutation SetPolicies($account: AccountReferenceInput!, $policies: PoliciesInput!) {
        setPolicies(account: $account, policies: $policies) {
          id
          settings
          policies {
            EXPENSE_AUTHOR_CANNOT_APPROVE {
              enabled
            }
          }
        }
      }
    `;

    it('should enable policy', async () => {
      const mutationParams = {
        account: { legacyId: collective.id },
        policies: { [POLICIES.EXPENSE_AUTHOR_CANNOT_APPROVE]: { enabled: true } },
      };
      const result = await graphqlQueryV2(setPoliciesMutation, mutationParams, adminUser);
      expect(result.errors).to.not.exist;

      await collective.reload();
      expect(collective.data.policies).to.deep.equal({
        [POLICIES.EXPENSE_AUTHOR_CANNOT_APPROVE]: { enabled: true },
        // Expense policies from `expensePolicy` field set at account creation
        [POLICIES.EXPENSE_POLICIES]: {
          grantPolicy: 'Be reasonable',
          invoicePolicy: 'Be reasonable',
          receiptPolicy: 'Be reasonable',
          titlePolicy: '',
        },
      });

      // Check activity
      const activity = await models.Activity.findOne({
        where: { UserId: adminUser.id, type: ACTIVITY.COLLECTIVE_EDITED },
        order: [['createdAt', 'DESC']],
      });

      expect(activity).to.exist;
      expect(activity.CollectiveId).to.equal(collective.id);
      expect(activity.data).to.containSubset({
        previousData: {
          policies: {
            [POLICIES.EXPENSE_POLICIES]: {
              grantPolicy: 'Be reasonable',
              invoicePolicy: 'Be reasonable',
              receiptPolicy: 'Be reasonable',
              titlePolicy: '',
            },
          },
        },
        newData: {
          policies: {
            [POLICIES.EXPENSE_AUTHOR_CANNOT_APPROVE]: { enabled: true },
            [POLICIES.EXPENSE_POLICIES]: {
              grantPolicy: 'Be reasonable',
              invoicePolicy: 'Be reasonable',
              receiptPolicy: 'Be reasonable',
              titlePolicy: '',
            },
          },
        },
      });
    });

    it('should merge with existing policies', async () => {
      const mutationParams = {
        account: { legacyId: collective.id },
        policies: { [POLICIES.COLLECTIVE_MINIMUM_ADMINS]: { numberOfAdmins: 42 } },
      };
      const result = await graphqlQueryV2(setPoliciesMutation, mutationParams, adminUser);
      expect(result.errors).to.not.exist;

      await collective.reload();
      expect(collective.data.policies).to.deep.eq({
        [POLICIES.EXPENSE_AUTHOR_CANNOT_APPROVE]: { enabled: true },
        [POLICIES.COLLECTIVE_MINIMUM_ADMINS]: { numberOfAdmins: 42 },
        [POLICIES.EXPENSE_POLICIES]: {
          grantPolicy: 'Be reasonable',
          invoicePolicy: 'Be reasonable',
          receiptPolicy: 'Be reasonable',
          titlePolicy: '',
        },
      });

      // Check activity
      const activity = await models.Activity.findOne({
        where: { UserId: adminUser.id, type: ACTIVITY.COLLECTIVE_EDITED },
        order: [['createdAt', 'DESC']],
      });

      expect(activity).to.exist;
      expect(activity.CollectiveId).to.equal(collective.id);
      expect(activity.data).to.containSubset({
        previousData: {
          policies: {
            [POLICIES.EXPENSE_AUTHOR_CANNOT_APPROVE]: { enabled: true },
            [POLICIES.EXPENSE_POLICIES]: {
              grantPolicy: 'Be reasonable',
              invoicePolicy: 'Be reasonable',
              receiptPolicy: 'Be reasonable',
              titlePolicy: '',
            },
          },
        },
        newData: {
          policies: {
            [POLICIES.EXPENSE_AUTHOR_CANNOT_APPROVE]: { enabled: true },
            [POLICIES.COLLECTIVE_MINIMUM_ADMINS]: { numberOfAdmins: 42 },
            [POLICIES.EXPENSE_POLICIES]: {
              grantPolicy: 'Be reasonable',
              invoicePolicy: 'Be reasonable',
              receiptPolicy: 'Be reasonable',
              titlePolicy: '',
            },
          },
        },
      });
    });

    it('should disable policy', async () => {
      const mutationParams = {
        account: { legacyId: collective.id },
        policies: { [POLICIES.EXPENSE_AUTHOR_CANNOT_APPROVE]: null, [POLICIES.COLLECTIVE_MINIMUM_ADMINS]: null },
      };
      const result = await graphqlQueryV2(setPoliciesMutation, mutationParams, adminUser);
      expect(result.errors).to.not.exist;

      await collective.reload();
      expect(collective.data.policies).to.deep.equal({
        [POLICIES.EXPENSE_POLICIES]: {
          grantPolicy: 'Be reasonable',
          invoicePolicy: 'Be reasonable',
          receiptPolicy: 'Be reasonable',
          titlePolicy: '',
        },
      });

      // Check activity
      const activity = await models.Activity.findOne({
        where: { UserId: adminUser.id, type: ACTIVITY.COLLECTIVE_EDITED },
        order: [['createdAt', 'DESC']],
      });

      expect(activity).to.exist;
      expect(activity.CollectiveId).to.equal(collective.id);
      expect(activity.data).to.containSubset({
        newData: {
          policies: {
            [POLICIES.EXPENSE_POLICIES]: {
              grantPolicy: 'Be reasonable',
              invoicePolicy: 'Be reasonable',
              receiptPolicy: 'Be reasonable',
              titlePolicy: '',
            },
          },
        },
        previousData: {
          policies: {
            [POLICIES.EXPENSE_AUTHOR_CANNOT_APPROVE]: { enabled: true },
            [POLICIES.COLLECTIVE_MINIMUM_ADMINS]: { numberOfAdmins: 42 },
            [POLICIES.EXPENSE_POLICIES]: {
              grantPolicy: 'Be reasonable',
              invoicePolicy: 'Be reasonable',
              receiptPolicy: 'Be reasonable',
              titlePolicy: '',
            },
          },
        },
      });
    });

    it('should fail if user is not authorized', async () => {
      const mutationParams = {
        account: { legacyId: collective.id },
        policies: { [POLICIES.EXPENSE_AUTHOR_CANNOT_APPROVE]: { enabled: true } },
      };
      const result = await graphqlQueryV2(setPoliciesMutation, mutationParams, hostAdminUser);
      expect(result.errors).to.have.lengthOf(1);

      await collective.reload();
      expect(collective.data.policies).to.deep.equal({
        [POLICIES.EXPENSE_POLICIES]: {
          grantPolicy: 'Be reasonable',
          invoicePolicy: 'Be reasonable',
          receiptPolicy: 'Be reasonable',
          titlePolicy: '',
        },
      });
    });
  });

  describe('sendMessage', () => {
    const sendMessageMutation = gql`
      mutation SendMessage($account: AccountReferenceInput!, $message: NonEmptyString!, $subject: String) {
        sendMessage(account: $account, message: $message, subject: $subject) {
          success
        }
      }
    `;

    const message = 'Hello collective, I am reaching out to you for testing purposes.';

    let sandbox, sendEmailSpy, collectiveWithContact, collectiveWithoutContact;

    before(async () => {
      sandbox = createSandbox();
      collectiveWithContact = await fakeCollective({
        name: 'Test Collective',
        slug: 'test-collective-with-contact',
        admin: adminUser,
        settings: { features: { contactForm: true } },
      });
      collectiveWithoutContact = await fakeCollective({
        admin: adminUser,
        settings: { features: { contactForm: false } },
      });

      sendEmailSpy = sandbox.spy(emailLib, 'sendMessage');
    });

    after(() => sandbox.restore());

    afterEach(() => {
      sendEmailSpy.resetHistory();
    });

    it('sends the message by email', async () => {
      const result = await graphqlQueryV2(
        sendMessageMutation,
        {
          account: { id: idEncode(collectiveWithContact.id, 'account') },
          message,
          subject: 'Testing',
        },
        randomUser,
      );

      expect(result.errors).to.not.exist;
      expect(result.data.sendMessage.success).to.equal(true);

      await waitForCondition(() => sendEmailSpy.callCount === 1);
      expect(sendEmailSpy.callCount).to.equal(1);
      expect(sendEmailSpy.args[0][1]).to.equal(
        `New message from ${randomUser.collective.name} on Open Collective: Testing`,
      );
      expect(sendEmailSpy.args[0][2]).to.include(message);
    });

    it('cannot inject code in the email (XSS)', async () => {
      const code = '<script>console.log("XSS")</script>';
      const xssUser = await fakeUser(null, { name: 'Tester', slug: 'tester' });
      const result = await graphqlQueryV2(
        sendMessageMutation,
        {
          account: { id: idEncode(collectiveWithContact.id, 'account') },
          message: message + code,
          subject: 'Testing',
        },
        xssUser,
      );

      expect(result.errors).to.not.exist;
      expect(result.data.sendMessage.success).to.equal(true);

      await waitForCondition(() => sendEmailSpy.callCount === 1);

      const expectedMessage = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta http-equiv="Content-Type" content="text/html; charset=UTF-8">
  <title></title>
  <style>
@media only screen and (min-device-width: 601px) {
  .content {
    width: 600px !important;
  }
}
.btn.blue:hover {
  background: linear-gradient(180deg,#297EFF 0%,#1869F5 100%);
  background-color: #297EFF;
  border-color: #297EFF;
  color: #FFFFFF;
}
</style>
</head>
<body margin="0" padding="0" yahoo style="margin: 0; padding: 0; min-width: 100%;">

<table bgcolor="white" border="0" cellpadding="0" cellspacing="0" width="100%" style="font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;box-sizing:border-box;font-size:14px;"><tr><td align="center" valign="top">
  <!--[if (gte mso 9)|(IE)]>
    <table width="600" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td>
  <![endif]-->
  <table class="content" border="0" width="100%" cellpadding="0" cellspacing="0" style="width: 100%; max-width: 600px; padding: 0 10px;">
    <tr>
      <td></td>
      <td>

<p style="color: #494B4D; font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; line-height: 18px; font-size: 17px; padding: 1em;">
  Hi Test Collective,
  <br><br>
  <a href="http://localhost:3000/tester" style="text-decoration: none; color: #297EFF;">Tester</a> just sent a message to <a href="http://localhost:3000/test-collective-with-contact" style="text-decoration: none; color: #297EFF;">Test Collective</a> on Open
  Collective. Simply reply to this email to reply to the sender.
</p>

<table style="width: 100%;">
  <tbody>
    <tr>
      <td style="border: 1px solid #e8edee; border-radius: 6px; padding: 1em;">
        <br>
          <p style="color: #494B4D; font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; line-height: 18px; font-size: 18px; font-weight: bold;">Subject</p>
          <blockquote style="color: #6a737d;font-size: 16px;text-align: left;padding: 0.5em 0.75em;margin: 1em 0;border-left: 3px solid #e4e4e4;white-space: pre-line;">Testing</blockquote>
          <br>
        <p style="color: #494B4D; font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; line-height: 18px; font-size: 18px; font-weight: bold;">Message</p>
        <blockquote style="color: #6a737d;font-size: 16px;text-align: left;padding: 0.5em 0.75em;margin: 1em 0;border-left: 3px solid #e4e4e4;white-space: pre-line;">Hello collective, I am reaching out to you for testing purposes.</blockquote>
      </td>
    </tr>
  </tbody>
</table>

<p style="color: #494B4D; font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; font-size: 14px; line-height: 18px;">If this message is spam, please forward it to <a href="mailto:support@opencollective.com" style="text-decoration: none; color: #297EFF;">support@opencollective.com</a>.</p>

</td>
</tr>
<tr>
  <td colspan="3" height="40"></td>
</tr>
<tr>
  <td colspan="3" align="center">
    <table width="100%">
      <tr>
        <td></td>
        <td width="200">
          <a href="http://localhost:3000" style="text-decoration: none; color: #297EFF;">
            <img width="220" height="28" src="http://localhost:3000/static/images/email/logo-email-footer@2x.png" style="max-width: 100%;">
          </a>
        </td>
        <td></td>
      </tr>
    </table>
  </td>
</tr>
<tr>
  <td colspan="3" align="center" style="font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;box-sizing:border-box;font-size:12px;color:#999;">
    We can do great things together<br><br>

    Come chat with us on our public
    <a href="https://discord.opencollective.com" style="text-decoration: none; color: #297EFF;">Discord</a>.
    <br><br>
    Made with ❤️ from <a href="https://docs.opencollective.com/help/about/team" style="text-decoration: none; color: #297EFF;">all over the world</a>
  </td>
</tr>
<tr>
  <td colspan="3" height="10"></td>
</tr>
</table><!-- 600px width content table -->

<!--[if (gte mso 9)|(IE)]>
  </td></tr></table>
<![endif]-->

</td>
</tr>
</table><!-- 100% width table -->
<!-- OpenCollective.com -->
</body>

</html>`;

      expect(sendEmailSpy.callCount).to.equal(1);
      expect(sendEmailSpy.args[0][1]).to.equal(`New message from Tester on Open Collective: Testing`);
      expect(sendEmailSpy.args[0][2]).to.equal(expectedMessage);
    });

    it('returns an error if not authenticated', async () => {
      const result = await graphqlQueryV2(sendMessageMutation, {
        account: { id: idEncode(collectiveWithContact.id, 'account') },
        message,
      });
      expect(result.errors).to.have.length(1);
      expect(result.errors[0].message).to.equal('You need to be logged in to manage account.');
    });

    it('returns an error if collective cannot be contacted', async () => {
      const result = await graphqlQueryV2(
        sendMessageMutation,
        {
          account: { id: idEncode(collectiveWithoutContact.id, 'account') },
          message,
        },
        randomUser,
      );
      expect(result.errors).to.have.length(1);
      expect(result.errors[0].message).to.equal(`You can't contact this account`);
    });

    it('returns an error if the feature is blocked for user', async () => {
      const userWithoutContact = await fakeUser();
      await userWithoutContact.limitFeature(FEATURE.CONTACT_COLLECTIVE, 'Sent spam');

      const result = await graphqlQueryV2(
        sendMessageMutation,
        {
          account: { id: idEncode(collectiveWithContact.id, 'account') },
          message,
        },
        userWithoutContact,
      );

      expect(result.errors).to.have.length(1);
      expect(result.errors[0].message).to.equal(
        'You are not authorized to contact Collectives. Please contact support@opencollective.com if you think this is an error.',
      );

      // Stores the reason
      await userWithoutContact.reload();
      const limitReasons = userWithoutContact.data.limitReasons as Array<Record<string, unknown>>;
      expect(limitReasons.length).to.eq(1);
      expect(limitReasons[0].reason).to.eq('Sent spam');
      expect(limitReasons[0].feature).to.eq('CONTACT_COLLECTIVE');
    });

    it('returns an error if the message is invalid', async () => {
      const result = await graphqlQueryV2(
        sendMessageMutation,
        {
          account: { id: idEncode(collectiveWithContact.id, 'account') },
          message: 'short',
        },
        randomUser,
      );
      expect(result.errors).to.have.length(1);
      expect(result.errors[0].message).to.equal('Message is too short');
    });
  });

  describe('createWebAuthnRegistrationOptions', () => {
    it('must be authenticated', async () => {
      const result = await graphqlQueryV2(createWebAuthnRegistrationOptionsMutation, {
        account: { id: idEncode(adminUser.collective.id, 'account') },
      });
      expect(result.errors).to.exist;
      expect(result.errors[0].extensions.code).to.equal('Unauthorized');
    });

    it('must be admin', async () => {
      const result = await graphqlQueryV2(
        createWebAuthnRegistrationOptionsMutation,
        {
          account: { id: idEncode(adminUser.collective.id, 'account') },
        },
        randomUser,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.match(/You are authenticated but forbidden to perform this action/);
    });

    it('creates a public key request options', async () => {
      const result = await graphqlQueryV2(
        createWebAuthnRegistrationOptionsMutation,
        {
          account: { id: idEncode(adminUser.collective.id, 'account') },
        },
        adminUser,
      );

      expect(result.errors).to.not.exist;
      expect(result.data.createWebAuthnRegistrationOptions).to.containSubset({
        attestation: 'direct',
        excludeCredentials: [],
        pubKeyCredParams: [
          {
            alg: -7,
            type: 'public-key',
          },
          {
            alg: -8,
            type: 'public-key',
          },
          {
            alg: -257,
            type: 'public-key',
          },
        ],
        rp: {
          id: 'localhost',
          name: '[Test] Open Collective',
        },
        user: {
          displayName: 'Admin Name',
          name: adminUser.collective.slug,
        },
      });
    });
  });

  describe('duplicateAccount', () => {
    it('must be authenticated', async () => {
      const result = await graphqlQueryV2(duplicateAccountMutation, { account: { legacyId: collective.id } });
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('You need to be logged in to manage account.');
    });

    it('must be an admin of the collective to duplicate', async () => {
      const result = await graphqlQueryV2(
        duplicateAccountMutation,
        { account: { legacyId: collective.id } },
        randomUser,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('You need to be logged in as an Admin of the account to duplicate it.');
    });

    it('only works with certain types', async () => {
      const vendor = await fakeCollective({ type: CollectiveType.VENDOR, admin: adminUser });
      const result = await graphqlQueryV2(duplicateAccountMutation, { account: { legacyId: vendor.id } }, adminUser);
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('VENDOR accounts cannot be duplicated.');
    });

    it('duplicates the account with the requested slug', async () => {
      const newSlug = randStr();
      const result = await graphqlQueryV2(
        duplicateAccountMutation,
        { account: { legacyId: collective.id }, newSlug },
        adminUser,
      );
      expect(result.errors).to.not.exist;
      expect(result.data.duplicateAccount.legacyId).to.not.equal(collective.id);
      expect(result.data.duplicateAccount.slug).to.equal(newSlug);
    });

    it('duplicates the account with an auto-generated slug based on the existing one', async () => {
      const result = await graphqlQueryV2(
        duplicateAccountMutation,
        { account: { legacyId: collective.id } },
        adminUser,
      );
      expect(result.errors).to.not.exist;
      expect(result.data.duplicateAccount.legacyId).to.not.equal(collective.id);
      expect(result.data.duplicateAccount.slug).to.match(/^bushwick.*/);
    });

    it('duplicates the account and its basic information', async () => {
      const result = await graphqlQueryV2(
        duplicateAccountMutation,
        { account: { legacyId: collective.id } },
        adminUser,
      );
      expect(result.errors).to.not.exist;
      const duplicate = await models.Collective.findByPk(result.data.duplicateAccount.legacyId);
      expect(duplicate.dataValues).to.containSubset({
        name: collective.name,
        description: collective.description,
        longDescription: collective.longDescription,
        website: collective.website,
        countryISO: collective.countryISO,
        tags: collective.tags,
        type: collective.type,
        data: { duplicatedFromCollectiveId: collective.id },
      });

      // Admins should not be copied by default
      const admins = await duplicate.getAdminUsers();
      expect(admins).to.have.length(1); // Remote user should be carried over in any case
      expect(admins[0].id).to.equal(adminUser.id);

      // Tiers should not be copied by default
      expect(await duplicate.getTiers()).to.be.empty;

      // Location should always be copied
      const location = await collective.getLocation();
      const duplicateLocation = await duplicate.getLocation();
      expect(duplicateLocation).to.exist;
      expect(duplicateLocation.address).to.equal(location.address);
      expect(duplicateLocation.country).to.equal(location.country);
      expect(duplicateLocation.lat).to.equal(location.lat);
      expect(duplicateLocation.long).to.equal(location.long);
    });

    it('connects the accounts', async () => {
      const result = await graphqlQueryV2(
        duplicateAccountMutation,
        { account: { legacyId: collective.id }, connect: true },
        adminUser,
      );

      expect(result.errors).to.not.exist;
      const duplicate = await models.Collective.findByPk(result.data.duplicateAccount.legacyId);
      const member = await models.Member.findOne({
        where: {
          role: MemberRoles.CONNECTED_COLLECTIVE,
          MemberCollectiveId: collective.id,
          CollectiveId: duplicate.id,
        },
      });

      expect(member).to.exist;
    });

    it('duplicates the account and its requested associations', async () => {
      const result = await graphqlQueryV2(
        duplicateAccountMutation,
        {
          account: { legacyId: collective.id },
          include: {
            admins: true,
            tiers: true,
          },
        },
        adminUser,
      );

      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      const duplicate = await models.Collective.findByPk(result.data.duplicateAccount.legacyId);
      const admins = await duplicate.getAdminUsers();
      expect(admins).to.have.length(2);
      expect(admins.map(u => u.id)).to.include(adminUser.id);
      expect(admins.map(u => u.id)).to.include(secondAdminUser.id);
      const tiers = await duplicate.getTiers();
      expect(tiers.map(t => t.description)).to.include('Tier 1 to be copied');
    });

    it('duplicates children events and projects', async () => {
      const result = await graphqlQueryV2(
        duplicateAccountMutation,
        {
          account: { legacyId: collective.id },
          include: {
            events: true,
            projects: true,
          },
        },
        adminUser,
      );

      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      const duplicate = await models.Collective.findByPk(result.data.duplicateAccount.legacyId);
      const newChildren = await duplicate.getChildren();
      expect(newChildren).to.have.length(2);
      expect(newChildren.map(c => c.type)).to.include(CollectiveType.EVENT);
      expect(newChildren.map(c => c.type)).to.include(CollectiveType.PROJECT);
      expect(newChildren.map(c => c.isActive)).to.deep.eq([false, false]); // We're not marking the projects as active by default to prevent bypassing the host process
      const duplicatedEvent = newChildren.find(c => c.type === CollectiveType.EVENT);
      const originalEventId = duplicatedEvent.data.duplicatedFromCollectiveId as number;
      const originalEvent = await models.Collective.findByPk(originalEventId);

      // The slug for duplicated event should be the same expect for the last part of each (random string)
      expect(duplicatedEvent.slug).to.not.equal(originalEvent.slug);
      const getSlugWithoutRandom = (slug: string) => slug.split('-').slice(0, -1).join('-');
      expect(getSlugWithoutRandom(duplicatedEvent.slug)).to.equal(getSlugWithoutRandom(originalEvent.slug));
    });
  });

  describe('editTwoFactorAuthenticationMethod', () => {
    const editTwoFactorAuthenticationMethodMutation = gql`
      mutation EditTwoFactorAuthenticationMethod(
        $userTwoFactorMethod: UserTwoFactorMethodReferenceInput!
        $name: String!
      ) {
        editTwoFactorAuthenticationMethod(userTwoFactorMethod: $userTwoFactorMethod, name: $name) {
          id
          hasTwoFactorAuth
          twoFactorMethods {
            id
            method
            name
            createdAt
            description
            icon
          }
        }
      }
    `;

    it('needs to be a valid ID', async () => {
      const result = await graphqlQueryV2(
        editTwoFactorAuthenticationMethodMutation,
        {
          userTwoFactorMethod: { id: 'invalid' },
          name: 'New name',
        },
        randomUser,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('Invalid user-two-factor-method id: invalid');
    });

    it('must be authenticated', async () => {
      const twoFactorMethod = await fakeUserTwoFactorMethod();
      const result = await graphqlQueryV2(editTwoFactorAuthenticationMethodMutation, {
        userTwoFactorMethod: { id: idEncode(twoFactorMethod.id, 'user-two-factor-method') },
        name: 'New name',
      });

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('You need to be logged in to manage account.');
    });

    it('must be an admin of the account', async () => {
      const twoFactorMethod = await fakeUserTwoFactorMethod();
      const result = await graphqlQueryV2(
        editTwoFactorAuthenticationMethodMutation,
        {
          userTwoFactorMethod: { id: idEncode(twoFactorMethod.id, 'user-two-factor-method') },
          name: 'New name',
        },
        randomUser,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('You are authenticated but forbidden to perform this action');
    });

    it('edits the name of the method', async () => {
      const user = await fakeUser();
      const method = await fakeUserTwoFactorMethod({ UserId: user.id });
      const result = await graphqlQueryV2(
        editTwoFactorAuthenticationMethodMutation,
        {
          userTwoFactorMethod: { id: idEncode(method.id, 'user-two-factor-method') },
          name: 'New name',
        },
        user,
      );
      expect(result.errors).to.not.exist;
      expect(result.data.editTwoFactorAuthenticationMethod.hasTwoFactorAuth).to.eq(true);
      expect(result.data.editTwoFactorAuthenticationMethod.twoFactorMethods).to.have.lengthOf(1);
      expect(result.data.editTwoFactorAuthenticationMethod.twoFactorMethods[0].name).to.equal('New name');
    });
  });
});
