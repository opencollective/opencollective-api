import { expect } from 'chai';

import {
  checkRemoteUserCanRoot,
  checkRemoteUserCanUseAccount,
  checkRemoteUserCanUseApplications,
  checkRemoteUserCanUseConversations,
  checkRemoteUserCanUseHost,
  checkRemoteUserCanUseOrders,
  checkRemoteUserCanUseTransactions,
  checkRemoteUserCanUseVirtualCards,
  checkScope,
  enforceScope
} from '../../../../server/graphql/common/scope-check';
import { fakeApplication, fakeOrganization, fakeUser, fakeUserToken } from '../../../test-helpers/fake-data';
import { makeRequest, resetTestDB } from '../../../utils';

describe('server/graphql/v2/mutation/AccountMutations', () => {
  let req, userToken, application, userOwningTheToken;

  before(async () => {
    await resetTestDB();
    application = await fakeApplication({ type: 'oAuth' });
    userOwningTheToken = await fakeUser();
    userToken = await fakeUserToken({ type: 'OAUTH', ApplicationId: application.id, UserId: userOwningTheToken.id, scope: ['account'] });
  });

  beforeEach(async () => {
    req = makeRequest(userOwningTheToken);
    req.userToken = userToken;
  });

  describe('checkScope', () => {
    it(`Returns true if not using OAuth (aka. if there's no req.userToken)`, async () => {
      req.userToken = null;
      expect(checkScope(req, 'account')).to.be.true;
    });
    it(`Returns true if user token has scope`, async () => {
      expect(checkScope(req, 'account')).to.be.true;
    });
    it(`Returns false if doesn't have the scope`, async () => {
      expect(checkScope(req, 'root')).to.be.false;
    });
  });
  describe('enforceScope', () => {
    it(`Doesn't throw error if not using OAuth (aka. if there's no req.userToken)`, async () => {
      req.userToken = null;
      expect(() => enforceScope(req, 'account')).to.not.throw();
    });
    it(`Doesn't throw error if true if user token has scope`, async () => {
      expect(() => enforceScope(req, 'account')).to.not.throw();
    });
    it(`Throw error if doesn't have the scope`, async () => {
      expect(() => enforceScope(req, 'root')).to.throw(`The User Token is not allowed for operations in scope "root".`);
    });
  });
  describe('checkRemoteUserCanUseAccount', () => {
    it(`Execute without errors if not using OAuth (aka. if there's no req.userToken)`, async () => {
      req.userToken = null;
      expect(() => checkRemoteUserCanUseAccount(req)).to.not.throw();
    });
    it(`Execute without errors if the scope is allowed by the user token`, async () => {
      expect(() => checkRemoteUserCanUseAccount(req)).to.not.throw();
    });
    it(`Throws when not authenticated`, async () => {
      req.remoteUser = null;
      expect(() => checkRemoteUserCanUseAccount(req)).to.throw(`You need to be logged in to manage account.`);
    });
    it(`Throws if the scope is not available on the token`, async () => {
      const userTokenWithScopeRoot = await fakeUserToken({ scope: ['root'] });
      req.userToken = userTokenWithScopeRoot;
      expect(() => checkRemoteUserCanUseAccount(req)).to.throw(`The User Token is not allowed for operations in scope "account".`);
    });
  });
  describe('checkRemoteUserCanUseVirtualCards', () => {
    it(`Execute without errors if not using OAuth (aka. if there's no req.userToken)`, async () => {
      req.userToken = null;
      expect(() => checkRemoteUserCanUseVirtualCards(req)).to.not.throw();
    });
    it(`Execute without errors if the scope is allowed by the user token`, async () => {
      const userTokenWithScopeVirtualCards = await fakeUserToken({ scope: ['virtualCards'] });
      req.userToken = userTokenWithScopeVirtualCards;
      expect(() => checkRemoteUserCanUseVirtualCards(req)).to.not.throw();
    });
    it(`Throws when not authenticated`, async () => {
      req.remoteUser = null;
      expect(() => checkRemoteUserCanUseVirtualCards(req)).to.throw(`You need to be logged in to manage virtual cards.`);
    });
    it(`Throws if the scope is not available on the token`, async () => {
      expect(() => checkRemoteUserCanUseVirtualCards(req)).to.throw(`The User Token is not allowed for operations in scope "virtualCards".`);
    });
  });
  describe('checkRemoteUserCanUseHost', () => {
    it(`Execute without errors if not using OAuth (aka. if there's no req.userToken)`, async () => {
      req.userToken = null;
      expect(() => checkRemoteUserCanUseHost(req)).to.not.throw();
    });
    it(`Execute without errors if the scope is allowed by the user token`, async () => {
      const userTokenWithScopeHost = await fakeUserToken({ scope: ['host'] });
      req.userToken = userTokenWithScopeHost;
      expect(() => checkRemoteUserCanUseHost(req)).to.not.throw();
    });
    it(`Throws when not authenticated`, async () => {
      req.remoteUser = null;
      expect(() => checkRemoteUserCanUseHost(req)).to.throw(`You need to be logged in to manage hosted accounts.`);
    });
    it(`Throws if the scope is not available on the token`, async () => {
      expect(() => checkRemoteUserCanUseHost(req)).to.throw(`The User Token is not allowed for operations in scope "host".`);
    });
  });
  describe('checkRemoteUserCanUseTransactions', () => {
    it(`Execute without errors if not using OAuth (aka. if there's no req.userToken)`, async () => {
      req.userToken = null;
      expect(() => checkRemoteUserCanUseTransactions(req)).to.not.throw();
    });
    it(`Execute without errors if the scope is allowed by the user token`, async () => {
      const userTokenWithScopeTransactions = await fakeUserToken({ scope: ['transactions'] });
      req.userToken = userTokenWithScopeTransactions;
      expect(() => checkRemoteUserCanUseTransactions(req)).to.not.throw();
    });
    it(`Throws when not authenticated`, async () => {
      req.remoteUser = null;
      expect(() => checkRemoteUserCanUseTransactions(req)).to.throw(`You need to be logged in to manage transactions.`);
    });
    it(`Throws if the scope is not available on the token`, async () => {
      expect(() => checkRemoteUserCanUseTransactions(req)).to.throw(`The User Token is not allowed for operations in scope "transactions".`);
    });
  });
  describe('checkRemoteUserCanUseOrders', () => {
    it(`Execute without errors if not using OAuth (aka. if there's no req.userToken)`, async () => {
      req.userToken = null;
      expect(() => checkRemoteUserCanUseOrders(req)).to.not.throw();
    });
    it(`Execute without errors if the scope is allowed by the user token`, async () => {
      const userTokenWithScopeOrders = await fakeUserToken({ scope: ['orders'] });
      req.userToken = userTokenWithScopeOrders;
      expect(() => checkRemoteUserCanUseOrders(req)).to.not.throw();
    });
    it(`Throws when not authenticated`, async () => {
      req.remoteUser = null;
      expect(() => checkRemoteUserCanUseOrders(req)).to.throw(`You need to be logged in to manage orders`);
    });
    it(`Throws if the scope is not available on the token`, async () => {
      expect(() => checkRemoteUserCanUseOrders(req)).to.throw(`The User Token is not allowed for operations in scope "orders".`);
    });
  });
  describe('checkRemoteUserCanUseApplications', () => {
    it(`Execute without errors if not using OAuth (aka. if there's no req.userToken)`, async () => {
      req.userToken = null;
      expect(() => checkRemoteUserCanUseApplications(req)).to.not.throw();
    });
    it(`Execute without errors if the scope is allowed by the user token`, async () => {
      const userTokenWithScopeApplications = await fakeUserToken({ scope: ['applications'] });
      req.userToken = userTokenWithScopeApplications;
      expect(() => checkRemoteUserCanUseApplications(req)).to.not.throw();
    });
    it(`Throws when not authenticated`, async () => {
      req.remoteUser = null;
      expect(() => checkRemoteUserCanUseApplications(req)).to.throw(`You need to be logged in to manage applications.`);
    });
    it(`Throws if the scope is not available on the token`, async () => {
      expect(() => checkRemoteUserCanUseApplications(req)).to.throw(`The User Token is not allowed for operations in scope "applications".`);
    });
  });
  describe('checkRemoteUserCanUseConversations', () => {
    it(`Execute without errors if not using OAuth (aka. if there's no req.userToken)`, async () => {
      req.userToken = null;
      expect(() => checkRemoteUserCanUseConversations(req)).to.not.throw();
    });
    it(`Execute without errors if the scope is allowed by the user token`, async () => {
      const userTokenWithScopeConversations = await fakeUserToken({ scope: ['conversations'] });
      req.userToken = userTokenWithScopeConversations;
      expect(() => checkRemoteUserCanUseConversations(req)).to.not.throw();
    });
    it(`Throws when not authenticated`, async () => {
      req.remoteUser = null;
      expect(() => checkRemoteUserCanUseConversations(req)).to.throw(`You need to be logged in to manage conversations`);
    });
    it(`Throws if the scope is not available on the token`, async () => {
      expect(() => checkRemoteUserCanUseConversations(req)).to.throw(`The User Token is not allowed for operations in scope "conversations".`);
    });
  });
  describe.skip('checkRemoteUserCanRoot', () => {
    let rootUser, rootOrg;

    before(async () => {
      rootOrg = await fakeOrganization({ id: 8686, slug: 'opencollective' });
      rootUser = await fakeUser({}, { name: 'Root user' });
      await rootOrg.addUserWithRole(rootUser, 'ADMIN');
      console.log("isRoot", rootUser.isRoot());
    })
    beforeEach(async () => {
      req = makeRequest(rootUser);
      console.log("🚀 ~ file: scope-check.test.ts ~ line 59 ~ beforeEach ~ req", req.remoteUser.isRoot())
      req.userToken = userToken;
    });
    it(`Execute without errors if not using OAuth (aka. if there's no req.userToken)`, async () => {
      req.userToken = null;
      expect(() => checkRemoteUserCanRoot(req)).to.not.throw();
    });
    it(`Execute without errors if the scope is allowed by the user token`, async () => {
      const userTokenWithScopeRoot = await fakeUserToken({ scope: ['root'] });
      req.userToken = userTokenWithScopeRoot;
      expect(() => checkRemoteUserCanRoot(req)).to.not.throw();
    });
    it(`Throws when not authenticated`, async () => {
      req.remoteUser = null;
      expect(() => checkRemoteUserCanRoot(req)).to.throw(`You need to be logged in.`);
    });
    it(`Throws when not authenticated as a root user`, async () => {
      req.remoteUser = userOwningTheToken;
      expect(() => checkRemoteUserCanRoot(req)).to.throw(`You need to be logged in as root.`);
    });
    it(`Throws if the scope is not available on the token`, async () => {
      expect(() => checkRemoteUserCanRoot(req)).to.throw(`The User Token is not allowed for operations in scope "root".`);
    });
  });
});
