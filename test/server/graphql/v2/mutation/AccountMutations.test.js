import { expect } from 'chai';
import gqlV2 from 'fake-tag';
import speakeasy from 'speakeasy';

import { roles } from '../../../../../server/constants';
import POLICIES from '../../../../../server/constants/policies';
import { idEncode } from '../../../../../server/graphql/v2/identifiers';
import { fakeCollective, fakeEvent, fakeHost, fakeProject, fakeUser } from '../../../../test-helpers/fake-data';
import { graphqlQueryV2 } from '../../../../utils';

const editSettingsMutation = gqlV2/* GraphQL */ `
  mutation EditSettings($account: AccountReferenceInput!, $key: AccountSettingsKey!, $value: JSON!) {
    editAccountSetting(account: $account, key: $key, value: $value) {
      id
      settings
    }
  }
`;

const addTwoFactorAuthTokenMutation = gqlV2/* GraphQL */ `
  mutation AddTwoFactorAuthToIndividual($account: AccountReferenceInput!, $token: String!) {
    addTwoFactorAuthTokenToIndividual(account: $account, token: $token) {
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

const editAccountFeeStructureMutation = gqlV2/* GraphQL */ `
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

describe('server/graphql/v2/mutation/AccountMutations', () => {
  let adminUser, randomUser, hostAdminUser, backerUser, collective;

  before(async () => {
    adminUser = await fakeUser();
    randomUser = await fakeUser();
    backerUser = await fakeUser();
    hostAdminUser = await fakeUser();
    const host = await fakeHost({ admin: hostAdminUser });
    collective = await fakeCollective({ admin: adminUser, HostCollectiveId: host.id });
    await collective.addUserWithRole(backerUser, roles.BACKER);

    // Create some children (event + project)
    await Promise.all([
      fakeEvent({ ParentCollectiveId: collective.id }),
      fakeProject({ ParentCollectiveId: collective.id }),
    ]);
  });

  beforeEach(async () => {
    await collective.update({ settings: {} });
  });

  describe('editAccountSetting', () => {
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
    const secret = speakeasy.generateSecret({ length: 64 });
    it('must be authenticated', async () => {
      const result = await graphqlQueryV2(addTwoFactorAuthTokenMutation, {
        account: { id: idEncode(adminUser.collective.id, 'account') },
        token: secret.base32,
      });
      expect(result.errors).to.exist;
      // expect(result.errors[0].message).to.match(/You need to be authenticated to perform this action/);
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
    });

    it('fails if user already enabled 2FA', async () => {
      const result = await graphqlQueryV2(
        addTwoFactorAuthTokenMutation,
        {
          account: { id: idEncode(adminUser.collective.id, 'account') },
          token: secret.base32,
        },
        adminUser,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.match(/This account already has 2FA enabled/);
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
      expect(children.length).to.eq(2);
      children.forEach(child => {
        expect(child.hostFeePercent).to.eq(9.99);
        expect(child.hostFeesStructure).to.eq('CUSTOM_FEE');
      });
    });
  });

  describe('setPolicies', () => {
    const setPoliciesMutation = gqlV2/* GraphQL */ `
      mutation setPoliciesMutation($account: AccountReferenceInput!, $policies: JSON!) {
        setPolicies(account: $account, policies: $policies) {
          id
          settings
          policies {
            EXPENSE_AUTHOR_CANNOT_APPROVE
          }
        }
      }
    `;

    it('should enable policy', async () => {
      const mutationParams = {
        account: { legacyId: collective.id },
        policies: { [POLICIES.EXPENSE_AUTHOR_CANNOT_APPROVE]: true },
      };
      await graphqlQueryV2(setPoliciesMutation, mutationParams, adminUser);

      await collective.reload();
      expect(collective.data.policies).to.deep.equal({ [POLICIES.EXPENSE_AUTHOR_CANNOT_APPROVE]: true });
    });

    it('should disable policy', async () => {
      const mutationParams = {
        account: { legacyId: collective.id },
        policies: {},
      };
      await graphqlQueryV2(setPoliciesMutation, mutationParams, adminUser);

      await collective.reload();
      expect(collective.data.policies).to.be.empty;
    });

    it('should fail if user is not authorized', async () => {
      const mutationParams = {
        account: { legacyId: collective.id },
        policies: { [POLICIES.EXPENSE_AUTHOR_CANNOT_APPROVE]: true },
      };
      const result = await graphqlQueryV2(setPoliciesMutation, mutationParams, hostAdminUser);
      expect(result.errors).to.have.lengthOf(1);

      await collective.reload();
      expect(collective.data.policies).to.be.empty;
    });
  });
});
