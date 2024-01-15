import { expect } from 'chai';
import gqlV1 from 'fake-tag';

import models from '../../../../server/models';
import { randEmail } from '../../../stores';
import * as utils from '../../../utils';

describe('server/graphql/v1/connectedAccounts', () => {
  let user, admin, backer, collective, connectedAccount, connectedAccountData;
  const editConnectedAccountMutation = gqlV1/* GraphQL */ `
    mutation EditConnectedAccount($connectedAccount: ConnectedAccountInputType!) {
      editConnectedAccount(connectedAccount: $connectedAccount) {
        id
        service
        settings
      }
    }
  `;
  before(() => utils.resetTestDB());

  before(async () => {
    user = await models.User.createUserWithCollective({ email: randEmail(), name: 'random user' });
    backer = await models.User.createUserWithCollective({ email: randEmail(), name: 'backer user' });
    admin = await models.User.createUserWithCollective({ email: randEmail(), name: 'admin user' });
    collective = await models.Collective.create({ name: 'testcollective' });
    collective.addUserWithRole(admin, 'ADMIN');
    collective.addUserWithRole(backer, 'BACKER');
    connectedAccount = await models.ConnectedAccount.create({
      CollectiveId: collective.id,
      service: 'twitter',
      username: 'opencollecttest',
    });
    connectedAccountData = {
      id: connectedAccount.id,
      settings: { tweet: 'hello world ' },
    };
  });

  describe('failure', () => {
    it('fails if not logged in', async () => {
      const res = await utils.graphqlQuery(editConnectedAccountMutation, {
        connectedAccount: connectedAccountData,
      });
      expect(res.errors).to.exist;
      expect(res.errors[0].message).to.contain('You need to be logged in to edit a connected account');
    });

    it('fails if connected account not found', async () => {
      const res = await utils.graphqlQuery(
        editConnectedAccountMutation,
        { connectedAccount: { ...connectedAccountData, id: 100 } },
        user,
      );
      expect(res.errors).to.exist;
      expect(res.errors[0].message).to.contain('Connected account not found');
    });

    it('fails to update a connected account if not connected as admin of CollectiveId', async () => {
      let res;
      res = await utils.graphqlQuery(editConnectedAccountMutation, { connectedAccount: connectedAccountData }, user);
      expect(res.errors).to.exist;
      expect(res.errors[0].message).to.contain("You don't have permission to edit this connected account");
      res = await utils.graphqlQuery(editConnectedAccountMutation, { connectedAccount: connectedAccountData }, backer);
      expect(res.errors).to.exist;
      expect(res.errors[0].message).to.contain("You don't have permission to edit this connected account");
    });
  });

  describe('success', () => {
    it('successfully updates a connected account', async () => {
      const res = await utils.graphqlQuery(
        editConnectedAccountMutation,
        { connectedAccount: connectedAccountData },
        admin,
      );
      expect(res.errors).to.not.exist;
      expect(res.data.editConnectedAccount.service).to.equal('twitter');
      expect(res.data.editConnectedAccount.settings).to.deep.equal(connectedAccountData.settings);
    });
  });
});
