import express from 'express';

import FEATURE from '../../constants/feature';
import OAuthScopes from '../../constants/oauth-scopes';
import { canUseFeature } from '../../lib/user-permissions';
import models from '../../models';
import { FeatureNotAllowedForUser, Forbidden, Unauthorized } from '../errors';

export const checkRemoteUserCanUseVirtualCards = (req: express.Request): void => {
  if (!req.remoteUser) {
    throw new Unauthorized('You need to be logged in to manage virtual cards.');
  }
  enforceScope(req, 'virtualCards');
};

export const checkRemoteUserCanUseAccount = (req: express.Request): void => {
  if (!req.remoteUser) {
    throw new Unauthorized('You need to be logged in to manage account.');
  }
  enforceScope(req, 'account');
};

export const checkRemoteUserCanUseHost = (req: express.Request): void => {
  if (!req.remoteUser) {
    throw new Unauthorized('You need to be logged in to manage hosted accounts.');
  }
  enforceScope(req, 'host');
};

export const checkRemoteUserCanUseTransactions = (req: express.Request): void => {
  if (!req.remoteUser) {
    throw new Unauthorized('You need to be logged in to manage transactions.');
  }
  enforceScope(req, 'transactions');
};

export const checkRemoteUserCanUseOrders = (req: express.Request): void => {
  if (!req.remoteUser) {
    throw new Unauthorized('You need to be logged in to manage orders');
  }
  if (!canUseFeature(req.remoteUser, FEATURE.ORDER)) {
    throw new FeatureNotAllowedForUser();
  }
  enforceScope(req, 'orders');
};

export const checkRemoteUserCanUseApplications = (req: express.Request): void => {
  if (!req.remoteUser) {
    throw new Unauthorized('You need to be logged in to manage applications.');
  }
  enforceScope(req, 'applications');
};

export const checkRemoteUserCanUseConversations = (req: express.Request): void => {
  if (!req.remoteUser) {
    throw new Unauthorized('You need to be logged in to manage conversations');
  }
  if (!canUseFeature(req.remoteUser, FEATURE.CONVERSATIONS)) {
    throw new FeatureNotAllowedForUser();
  }
  enforceScope(req, 'conversations');
};

export const checkRemoteUserCanUseExpenses = (req: express.Request): void => {
  if (!req.remoteUser) {
    throw new Unauthorized('You need to be logged in to manage expenses');
  }
  if (!canUseFeature(req.remoteUser, FEATURE.USE_EXPENSES)) {
    throw new FeatureNotAllowedForUser();
  }
  enforceScope(req, 'expenses');
};

export const checkRemoteUserCanUseUpdates = (req: express.Request): void => {
  if (!req.remoteUser) {
    throw new Unauthorized('You need to be logged in to manage updates.');
  }
  enforceScope(req, 'updates');
};

export const checkRemoteUserCanUseConnectedAccounts = (req: express.Request): void => {
  if (!req.remoteUser) {
    throw new Unauthorized('You need to be logged in to manage connected accounts.');
  }
  enforceScope(req, 'connectedAccounts');
};

export const checkRemoteUserCanUseWebhooks = (req: express.Request): void => {
  if (!req.remoteUser) {
    throw new Unauthorized('You need to be logged in to manage webhooks');
  }
  enforceScope(req, 'webhooks');
};

export const checkRemoteUserCanUseComment = (comment: typeof models.Comment, req: express.Request): void => {
  if (comment.ConversationId) {
    checkRemoteUserCanUseConversations(req);
  } else if (comment.UpdateId) {
    checkRemoteUserCanUseUpdates(req);
  } else if (comment.ExpenseId) {
    checkRemoteUserCanUseExpenses(req);
  }
};

export const checkRemoteUserCanRoot = (req: express.Request): void => {
  if (!req.remoteUser) {
    throw new Unauthorized('You need to be logged in.');
  }
  if (!req.remoteUser.isRoot()) {
    throw new Forbidden('You need to be logged in as root.');
  }
  enforceScope(req, 'root');
};

// In many places we check the scope using a direct string. This type will ensure we still use values from the enum.
type OAuthScope = keyof typeof OAuthScopes;

export const checkScope = (req: express.Request, scope: OAuthScope): boolean => {
  return !req.userToken || req.userToken.hasScope(scope);
};

export const enforceScope = (req: express.Request, scope: OAuthScope): void => {
  if (!checkScope(req, scope)) {
    throw new Forbidden(`The User Token is not allowed for operations in scope "${scope}".`);
  }
};
