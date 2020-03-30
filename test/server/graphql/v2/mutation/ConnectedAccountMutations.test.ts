import { expect } from 'chai';
import sinon from 'sinon';

import * as transferwise from '../../../../../server/lib/transferwise';
import models from '../../../../../server/models';
import { fakeCollective, fakeUser, fakeConnectedAccount } from '../../../../test-helpers/fake-data';
import { graphqlQueryV2 } from '../../../../utils';
import * as utils from '../../../../utils';

describe('server/graphql/v2/mutation/ConnectedAccountMutations', () => {
  const sandbox = sinon.createSandbox();
  beforeEach(() => {
    sandbox.restore();
    sandbox.stub(transferwise, 'getProfiles').resolves();
  });
  beforeEach(utils.resetTestDB);

  describe('createConnectedAccount', () => {
    const createConnectedAccountMutation = `
      mutation createConnectedAccount($connectedAccount: ConnectedAccountCreateInput!, $account: AccountReferenceInput!) {
        createConnectedAccount(connectedAccount: $connectedAccount, account: $account) {
          id
          settings
          service
        }
      }
    `;
    let user, collective;
    beforeEach(async () => {
      user = await fakeUser();
      collective = await fakeCollective({
        admin: user.collective,
      });
    });

    it('should create a new connected account', async () => {
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
        {
          connectedAccount,
          account: { legacyId: collective.id },
        },
        user,
      );

      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data).to.exist;
      expect(result.data.createConnectedAccount).to.exist;

      const createdConnectedAccount = await models.ConnectedAccount.findByPk(result.data.createConnectedAccount.id);
      expect(createdConnectedAccount.toJSON()).to.deep.include(connectedAccount);
    });

    it('should fail if token already exists', async () => {
      const connectedAccount = {
        token: 'fakeToken',
        service: 'transferwise',
      };

      await graphqlQueryV2(
        createConnectedAccountMutation,
        {
          connectedAccount,
          account: { legacyId: collective.id },
        },
        user,
      );

      const result = await graphqlQueryV2(
        createConnectedAccountMutation,
        {
          connectedAccount,
          account: { legacyId: collective.id },
        },
        user,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].originalError.name).to.equal('ValidationFailed');
      expect(result.errors[0].message).to.include('This token is already being used');
    });

    it('should fail if token is not valid', async () => {
      const connectedAccount = {
        token: 'fakeToken',
        service: 'transferwise',
      };

      (transferwise.getProfiles as sinon.stub).rejects();

      const result = await graphqlQueryV2(
        createConnectedAccountMutation,
        {
          connectedAccount,
          account: { legacyId: collective.id },
        },
        user,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].originalError.name).to.equal('ValidationFailed');
      expect(result.errors[0].message).to.include('The token is not a valid TransferWise token');
    });
  });

  describe('deleteConnectedAccount', () => {
    const deleteConnectedAccountMutation = `
      mutation deleteConnectedAccount($connectedAccount: ConnectedAccountReferenceInput!) {
        deleteConnectedAccount(connectedAccount: $connectedAccount) {
          id
        }
      }
    `;

    let user, collective, connectedAccount;
    beforeEach(async () => {
      user = await fakeUser();
      collective = await fakeCollective({
        admin: user.collective,
      });
      connectedAccount = await fakeConnectedAccount({ CollectiveId: collective.id });
    });

    it('should force delete the connected account', async () => {
      const result = await graphqlQueryV2(
        deleteConnectedAccountMutation,
        {
          connectedAccount: {
            legacyId: connectedAccount.id,
          },
        },
        user,
      );

      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data).to.exist;

      const createdConnectedAccount = await models.ConnectedAccount.findByPk(connectedAccount.id, { paranoid: false });
      expect(createdConnectedAccount).to.be.null;
    });
  });
});
