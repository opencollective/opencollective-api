import { expect } from 'chai';

import {
  checkRemoteUserCanRoot,
  checkRemoteUserCanUseAccount,
  checkRemoteUserCanUseApplications,
  checkRemoteUserCanUseComment,
  checkRemoteUserCanUseConnectedAccounts,
  checkRemoteUserCanUseConversations,
  checkRemoteUserCanUseExpenses,
  checkRemoteUserCanUseHost,
  checkRemoteUserCanUseOrders,
  checkRemoteUserCanUseTransactions,
  checkRemoteUserCanUseUpdates,
  checkRemoteUserCanUseVirtualCards,
  checkRemoteUserCanUseWebhooks,
  checkScope,
  enforceScope,
} from '../../../../server/graphql/common/scope-check.js';
import {
  fakeApplication,
  fakeComment,
  fakeConversation,
  fakeExpense,
  fakeUpdate,
  fakeUser,
  fakeUserToken,
} from '../../../test-helpers/fake-data.js';
import { makeRequest } from '../../../utils.js';

describe('server/graphql/common/scope-check', () => {
  let req, userToken, application, userOwningTheToken, randomUser;

  before(async () => {
    application = await fakeApplication({ type: 'oAuth' });
    userOwningTheToken = await fakeUser();
    randomUser = await fakeUser();
    userToken = await fakeUserToken({
      type: 'OAUTH',
      ApplicationId: application.id,
      UserId: userOwningTheToken.id,
      scope: ['account'],
    });
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
    it(`Doesn't throw error if user token has scope`, async () => {
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
      expect(() => checkRemoteUserCanUseAccount(req)).to.throw(
        `The User Token is not allowed for operations in scope "account".`,
      );
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
      expect(() => checkRemoteUserCanUseVirtualCards(req)).to.throw(
        `You need to be logged in to manage virtual cards.`,
      );
    });
    it(`Throws if the scope is not available on the token`, async () => {
      expect(() => checkRemoteUserCanUseVirtualCards(req)).to.throw(
        `The User Token is not allowed for operations in scope "virtualCards".`,
      );
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
      expect(() => checkRemoteUserCanUseHost(req)).to.throw(
        `The User Token is not allowed for operations in scope "host".`,
      );
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
      expect(() => checkRemoteUserCanUseTransactions(req)).to.throw(
        `The User Token is not allowed for operations in scope "transactions".`,
      );
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
      expect(() => checkRemoteUserCanUseOrders(req)).to.throw(
        `The User Token is not allowed for operations in scope "orders".`,
      );
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
      expect(() => checkRemoteUserCanUseApplications(req)).to.throw(
        `The User Token is not allowed for operations in scope "applications".`,
      );
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
      expect(() => checkRemoteUserCanUseConversations(req)).to.throw(
        `You need to be logged in to manage conversations`,
      );
    });
    it(`Throws if the scope is not available on the token`, async () => {
      expect(() => checkRemoteUserCanUseConversations(req)).to.throw(
        `The User Token is not allowed for operations in scope "conversations".`,
      );
    });
  });
  describe('checkRemoteUserCanUseExpenses', () => {
    it(`Execute without errors if not using OAuth (aka. if there's no req.userToken)`, async () => {
      req.userToken = null;
      expect(() => checkRemoteUserCanUseExpenses(req)).to.not.throw();
    });
    it(`Execute without errors if the scope is allowed by the user token`, async () => {
      const userTokenWithScopeExpenses = await fakeUserToken({ scope: ['expenses'] });
      req.userToken = userTokenWithScopeExpenses;
      expect(() => checkRemoteUserCanUseExpenses(req)).to.not.throw();
    });
    it(`Throws when not authenticated`, async () => {
      req.remoteUser = null;
      expect(() => checkRemoteUserCanUseExpenses(req)).to.throw(`You need to be logged in to manage expenses`);
    });
    it(`Throws if the scope is not available on the token`, async () => {
      expect(() => checkRemoteUserCanUseExpenses(req)).to.throw(
        `The User Token is not allowed for operations in scope "expenses".`,
      );
    });
  });
  describe('checkRemoteUserCanUseUpdates', () => {
    it(`Execute without errors if not using OAuth (aka. if there's no req.userToken)`, async () => {
      req.userToken = null;
      expect(() => checkRemoteUserCanUseUpdates(req)).to.not.throw();
    });
    it(`Execute without errors if the scope is allowed by the user token`, async () => {
      const userTokenWithScopeUpdates = await fakeUserToken({ scope: ['updates'] });
      req.userToken = userTokenWithScopeUpdates;
      expect(() => checkRemoteUserCanUseUpdates(req)).to.not.throw();
    });
    it(`Throws when not authenticated`, async () => {
      req.remoteUser = null;
      expect(() => checkRemoteUserCanUseUpdates(req)).to.throw(`You need to be logged in to manage updates.`);
    });
    it(`Throws if the scope is not available on the token`, async () => {
      expect(() => checkRemoteUserCanUseUpdates(req)).to.throw(
        `The User Token is not allowed for operations in scope "updates".`,
      );
    });
  });
  describe('checkRemoteUserCanUseConnectedAccounts', () => {
    it(`Execute without errors if not using OAuth (aka. if there's no req.userToken)`, async () => {
      req.userToken = null;
      expect(() => checkRemoteUserCanUseConnectedAccounts(req)).to.not.throw();
    });
    it(`Execute without errors if the scope is allowed by the user token`, async () => {
      const userTokenWithScopeConnectedAccounts = await fakeUserToken({ scope: ['connectedAccounts'] });
      req.userToken = userTokenWithScopeConnectedAccounts;
      expect(() => checkRemoteUserCanUseConnectedAccounts(req)).to.not.throw();
    });
    it(`Throws when not authenticated`, async () => {
      req.remoteUser = null;
      expect(() => checkRemoteUserCanUseConnectedAccounts(req)).to.throw(
        `You need to be logged in to manage connected accounts.`,
      );
    });
    it(`Throws if the scope is not available on the token`, async () => {
      expect(() => checkRemoteUserCanUseConnectedAccounts(req)).to.throw(
        `The User Token is not allowed for operations in scope "connectedAccounts".`,
      );
    });
  });
  describe('checkRemoteUserCanUseWebhooks', () => {
    it(`Execute without errors if not using OAuth (aka. if there's no req.userToken)`, async () => {
      req.userToken = null;
      expect(() => checkRemoteUserCanUseWebhooks(req)).to.not.throw();
    });
    it(`Execute without errors if the scope is allowed by the user token`, async () => {
      const userTokenWithScopeWebhooks = await fakeUserToken({ scope: ['webhooks'] });
      req.userToken = userTokenWithScopeWebhooks;
      expect(() => checkRemoteUserCanUseWebhooks(req)).to.not.throw();
    });
    it(`Throws when not authenticated`, async () => {
      req.remoteUser = null;
      expect(() => checkRemoteUserCanUseWebhooks(req)).to.throw(`You need to be logged in to manage webhooks`);
    });
    it(`Throws if the scope is not available on the token`, async () => {
      expect(() => checkRemoteUserCanUseWebhooks(req)).to.throw(
        `The User Token is not allowed for operations in scope "webhooks".`,
      );
    });
  });
  describe('checkRemoteUserCanUseComment', () => {
    let commentOnExpense, commentOnConversation, commentOnUpdate, expense, conversation, update;
    before(async () => {
      expense = await fakeExpense({
        status: 'APPROVED',
        FromCollectiveId: userOwningTheToken.collective.id,
        amount: 8000,
        currency: 'USD',
        CollectiveId: randomUser.collective.id,
      });
      update = await fakeUpdate({
        CollectiveId: randomUser.collective.id,
        publishedAt: new Date(),
      });
      conversation = await fakeConversation({
        CollectiveId: randomUser.collective.id,
      });
      commentOnExpense = await fakeComment({
        ExpenseId: expense.id,
        FromCollectiveId: userOwningTheToken.collective.id,
        CollectiveId: expense.CollectiveId,
      });
      commentOnConversation = await fakeComment({
        ConversationId: conversation.id,
        FromCollectiveId: userOwningTheToken.collective.id,
        CollectiveId: conversation.CollectiveId,
      });
      commentOnUpdate = await fakeComment({
        UpdateId: update.id,
        FromCollectiveId: userOwningTheToken.collective.id,
        CollectiveId: update.CollectiveId,
      });
    });
    it(`Execute without errors if not using OAuth (aka. if there's no req.userToken)`, async () => {
      req.userToken = null;
      expect(() => checkRemoteUserCanUseComment(commentOnExpense, req)).to.not.throw();
    });
    it(`Execute without errors for comment on Expense if the scope is allowed by the user token`, async () => {
      const userTokenWithScopeExpense = await fakeUserToken({ scope: ['expenses'] });
      req.userToken = userTokenWithScopeExpense;
      expect(() => checkRemoteUserCanUseComment(commentOnExpense, req)).to.not.throw();
    });
    it(`Execute without errors for comment on Update if the scope is allowed by the user token`, async () => {
      const userTokenWithScopeUpdates = await fakeUserToken({ scope: ['updates'] });
      req.userToken = userTokenWithScopeUpdates;
      expect(() => checkRemoteUserCanUseComment(commentOnUpdate, req)).to.not.throw();
    });
    it(`Execute without errors for comment on Conversation if the scope is allowed by the user token`, async () => {
      const userTokenWithScopeConversations = await fakeUserToken({ scope: ['conversations'] });
      req.userToken = userTokenWithScopeConversations;
      expect(() => checkRemoteUserCanUseComment(commentOnConversation, req)).to.not.throw();
    });
    it(`Throws when not authenticated`, async () => {
      req.remoteUser = null;
      expect(() => checkRemoteUserCanUseComment(commentOnExpense, req)).to.throw(
        `You need to be logged in to manage expenses`,
      );
      expect(() => checkRemoteUserCanUseComment(commentOnUpdate, req)).to.throw(
        `You need to be logged in to manage updates.`,
      );
      expect(() => checkRemoteUserCanUseComment(commentOnConversation, req)).to.throw(
        `You need to be logged in to manage conversations`,
      );
    });
    it(`Throws if the scope is not available on the token`, async () => {
      expect(() => checkRemoteUserCanUseComment(commentOnExpense, req)).to.throw(
        `The User Token is not allowed for operations in scope "expenses".`,
      );
      expect(() => checkRemoteUserCanUseComment(commentOnUpdate, req)).to.throw(
        `The User Token is not allowed for operations in scope "updates".`,
      );
      expect(() => checkRemoteUserCanUseComment(commentOnConversation, req)).to.throw(
        `The User Token is not allowed for operations in scope "conversations".`,
      );
    });
  });
  describe('checkRemoteUserCanRoot', () => {
    let rootUser;

    before(async () => {
      rootUser = await fakeUser({ data: { isRoot: true } });
      rootUser.rolesByCollectiveId = { 1: ['ADMIN'] };
    });
    beforeEach(async () => {
      req = makeRequest(rootUser);
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
      expect(() => checkRemoteUserCanRoot(req)).to.throw(
        `The User Token is not allowed for operations in scope "root".`,
      );
    });
  });
});
