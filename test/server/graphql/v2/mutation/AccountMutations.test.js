import { expect } from 'chai';
import { graphqlQueryV2 } from '../../../../utils';
import { fakeCollective, fakeUser } from '../../../../test-helpers/fake-data';
import { roles } from '../../../../../server/constants';

const editSettingsMutation = `
  mutation EditUserSettings($account: AccountReferenceInput!, $settings: JSON!) {
    editAccountSettings(account: $account, settings: $settings) {
      id
      settings
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

  describe('editAccountSettings', () => {
    it('must be authenticated', async () => {
      const result = await graphqlQueryV2(editSettingsMutation, { account: { legacyId: collective.id }, settings: {} });
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.match(/You need to be authenticated to perform this action/);
    });

    it('must be admin', async () => {
      const result = await graphqlQueryV2(
        editSettingsMutation,
        { account: { legacyId: collective.id }, settings: {} },
        randomUser,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.match(/You are authenticated but forbidden to perform this action/);
    });

    it('edits the settings', async () => {
      const settings = { hello: 'world' };
      const result = await graphqlQueryV2(
        editSettingsMutation,
        { account: { legacyId: collective.id }, settings },
        adminUser,
      );

      expect(result.errors).to.not.exist;
      expect(result.data.editAccountSettings.settings).to.deep.eq(settings);
    });
  });
});
