import { expect } from 'chai';
import gqlV2 from 'fake-tag';
import speakeasy from 'speakeasy';

import { roles } from '../../../../../server/constants';
import { idEncode } from '../../../../../server/graphql/v2/identifiers';
import { fakeCollective, fakeUser } from '../../../../test-helpers/fake-data';
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

describe('server/graphql/v2/mutation/AccountMutations', () => {
  let adminUser, randomUser, collective;

  before(async () => {
    adminUser = await fakeUser();
    randomUser = await fakeUser();
    collective = await fakeCollective();
    await collective.addUserWithRole(adminUser, roles.ADMIN);
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
      expect(result.errors[0].message).to.match(/You need to be authenticated to perform this action/);
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
});
