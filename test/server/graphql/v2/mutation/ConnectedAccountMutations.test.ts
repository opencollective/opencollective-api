import { expect } from 'chai';
import { graphqlQueryV2 } from '../../../../utils';
import { fakeCollective, fakeUser } from '../../../../test-helpers/fake-data';
import models from '../../../../../server/models';

const createConnectedAccountMutation = `
mutation createConnectedAccount($connectedAccount: ConnectedAccountCreateInput!, $account: AccountReferenceInput!) {
  createConnectedAccount(connectedAccount: $connectedAccount, account: $account) {
    id
    settings
    service
  }
}`;

describe('server/graphql/v2/mutation/ConnectedAccountMutations', () => {
  describe('createConnectedAccount', () => {
    let user, collective;
    beforeEach(async () => {
      user = await fakeUser();
      collective = await fakeCollective({ admin: user.collective });
    });

    it('creates the connected account with the linked attachments', async () => {
      const connectedAccount = {
        refreshToken: 'fakeRefreshToken',
        settings: { a: true },
        token: 'fakeToken',
        service: 'transferwise',
        username: 'kewitz',
        data: { secret: true },
      };

      const result = await graphqlQueryV2(
        createConnectedAccountMutation,
        { connectedAccount, account: { legacyId: collective.id } },
        user,
      );

      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data).to.exist;
      expect(result.data.createConnectedAccount).to.exist;

      const createdConnectedAccount = await models.ConnectedAccount.findByPk(result.data.createConnectedAccount.id);
      expect(createdConnectedAccount.toJSON()).to.deep.include(connectedAccount);
    });
  });
});
