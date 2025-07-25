import { expect } from 'chai';
import gql from 'fake-tag';
import { createSandbox, stub } from 'sinon';

import * as GoCardlessConnect from '../../../../../server/lib/gocardless/connect';
import * as PlaidConnect from '../../../../../server/lib/plaid/connect';
import * as transferwise from '../../../../../server/lib/transferwise';
import models from '../../../../../server/models';
import { fakeCollective, fakeConnectedAccount, fakeUser } from '../../../../test-helpers/fake-data';
import { graphqlQueryV2 } from '../../../../utils';
import * as utils from '../../../../utils';

describe('server/graphql/v2/mutation/ConnectedAccountMutations', () => {
  const sandbox = createSandbox();
  beforeEach(async () => {
    sandbox.stub(transferwise, 'getProfiles').resolves();
    await utils.resetTestDB();
  });

  afterEach(() => sandbox.restore());

  describe('createConnectedAccount', () => {
    const createConnectedAccountMutation = gql`
      mutation CreateConnectedAccount(
        $connectedAccount: ConnectedAccountCreateInput!
        $account: AccountReferenceInput!
      ) {
        createConnectedAccount(connectedAccount: $connectedAccount, account: $account) {
          id
          legacyId
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

      const createdConnectedAccount = await models.ConnectedAccount.findByPk(
        result.data.createConnectedAccount.legacyId,
      );
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
      expect(result.errors[0].extensions.code).to.equal('ValidationFailed');
      expect(result.errors[0].message).to.include('This token is already being used');
    });

    it('should fail if token is not valid', async () => {
      const connectedAccount = {
        token: 'fakeToken',
        service: 'transferwise',
      };

      (transferwise.getProfiles as stub).rejects();

      const result = await graphqlQueryV2(
        createConnectedAccountMutation,
        {
          connectedAccount,
          account: { legacyId: collective.id },
        },
        user,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].extensions.code).to.equal('ValidationFailed');
      expect(result.errors[0].message).to.include('The token is not a valid TransferWise token');
    });
  });

  describe('deleteConnectedAccount', () => {
    const deleteConnectedAccountMutation = gql`
      mutation DeleteConnectedAccount($connectedAccount: ConnectedAccountReferenceInput!) {
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

    it('should soft delete the connected account', async () => {
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
      expect(createdConnectedAccount).to.not.be.null;
      expect(createdConnectedAccount.deletedAt).to.not.be.null;
    });

    describe('should disconnect on 3rd party services', () => {
      it('with Plaid', async () => {
        sandbox.stub(PlaidConnect, 'disconnectPlaidAccount').resolves();
        const connectedAccount = await fakeConnectedAccount({ service: 'plaid' });
        await connectedAccount.collective.addUserWithRole(user, 'ADMIN');
        const result = await graphqlQueryV2(
          deleteConnectedAccountMutation,
          { connectedAccount: { legacyId: connectedAccount.id } },
          user,
        );

        result.errors && console.error(result.errors);
        expect(result.errors).to.not.exist;
        expect(PlaidConnect.disconnectPlaidAccount).to.have.been.calledOnce;
        const deletedAccount = await models.ConnectedAccount.findByPk(connectedAccount.id);
        expect(deletedAccount).to.be.null;
      });

      it('with GoCardless', async () => {
        sandbox.stub(GoCardlessConnect, 'disconnectGoCardlessAccount').resolves();
        const connectedAccount = await fakeConnectedAccount({ service: 'gocardless' });
        await connectedAccount.collective.addUserWithRole(user, 'ADMIN');
        const result = await graphqlQueryV2(
          deleteConnectedAccountMutation,
          { connectedAccount: { legacyId: connectedAccount.id } },
          user,
        );

        result.errors && console.error(result.errors);
        expect(result.errors).to.not.exist;
        expect(GoCardlessConnect.disconnectGoCardlessAccount).to.have.been.calledOnce;
        const deletedAccount = await models.ConnectedAccount.findByPk(connectedAccount.id);
        expect(deletedAccount).to.be.null;
      });
    });
  });
});
