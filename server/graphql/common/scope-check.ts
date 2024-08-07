import moment from 'moment';

import FEATURE from '../../constants/feature';
import OAuthScopes from '../../constants/oauth-scopes';
import { canUseFeature } from '../../lib/user-permissions';
import Comment from '../../models/Comment';
import { FeatureNotAllowedForUser, Forbidden, Unauthorized } from '../errors';

export const checkRemoteUserCanUseVirtualCards = (req: Express.Request): void => {
  if (!req.remoteUser) {
    throw new Unauthorized('You need to be logged in to manage virtual cards.');
  }
  enforceScope(req, 'virtualCards');
};

export const checkRemoteUserCanUseAccount = (req: Express.Request): void => {
  if (!req.remoteUser) {
    throw new Unauthorized('You need to be logged in to manage account.');
  }
  enforceScope(req, 'account');
};

export const checkRemoteUserCanUseHost = (req: Express.Request): void => {
  if (!req.remoteUser) {
    throw new Unauthorized('You need to be logged in to manage hosted accounts.');
  }
  enforceScope(req, 'host');
};

export const checkRemoteUserCanUseTransactions = (req: Express.Request): void => {
  if (!req.remoteUser) {
    throw new Unauthorized('You need to be logged in to manage transactions.');
  }
  enforceScope(req, 'transactions');
};

export const checkRemoteUserCanUseOrders = (req: Express.Request): void => {
  if (!req.remoteUser) {
    throw new Unauthorized('You need to be logged in to manage orders');
  }
  if (!canUseFeature(req.remoteUser, FEATURE.ORDER)) {
    throw new FeatureNotAllowedForUser();
  }
  enforceScope(req, 'orders');
};

export const checkRemoteUserCanUseApplications = (req: Express.Request): void => {
  if (!req.remoteUser) {
    throw new Unauthorized('You need to be logged in to manage applications.');
  }
  enforceScope(req, 'applications');
};

export const checkRemoteUserCanUseConversations = (req: Express.Request): void => {
  if (!req.remoteUser) {
    throw new Unauthorized('You need to be logged in to manage conversations');
  }
  if (!canUseFeature(req.remoteUser, FEATURE.CONVERSATIONS)) {
    throw new FeatureNotAllowedForUser();
  }
  enforceScope(req, 'conversations');
};

export const checkRemoteUserCanUseExpenses = (req: Express.Request): void => {
  if (!req.remoteUser) {
    throw new Unauthorized('You need to be logged in to manage expenses');
  }
  if (!canUseFeature(req.remoteUser, FEATURE.USE_EXPENSES)) {
    throw new FeatureNotAllowedForUser();
  }
  enforceScope(req, 'expenses');
};

export const checkRemoteUserCanUseUpdates = (req: Express.Request): void => {
  if (!req.remoteUser) {
    throw new Unauthorized('You need to be logged in to manage updates.');
  }
  enforceScope(req, 'updates');
};

export const checkRemoteUserCanUseConnectedAccounts = (req: Express.Request): void => {
  if (!req.remoteUser) {
    throw new Unauthorized('You need to be logged in to manage connected accounts.');
  }
  enforceScope(req, 'connectedAccounts');
};

export const checkRemoteUserCanUseWebhooks = (req: Express.Request): void => {
  if (!req.remoteUser) {
    throw new Unauthorized('You need to be logged in to manage webhooks');
  }
  enforceScope(req, 'webhooks');
};

const checkRemoteUserCanUseHostApplications = (req: Express.Request): void => {
  if (!req.remoteUser) {
    throw new Unauthorized('You need to be logged in to manage host applications');
  }
  enforceScope(req, 'account');
};

export const checkRemoteUserCanUseComment = (comment: Comment, req: Express.Request): void => {
  if (comment.ConversationId) {
    checkRemoteUserCanUseConversations(req);
  } else if (comment.UpdateId) {
    checkRemoteUserCanUseUpdates(req);
  } else if (comment.ExpenseId) {
    checkRemoteUserCanUseExpenses(req);
  } else if (comment.HostApplicationId) {
    checkRemoteUserCanUseHostApplications(req);
  }
};

export const checkRemoteUserCanRoot = (req: Express.Request): void => {
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

export const checkScope = (req: Express.Request, scope: OAuthScope): boolean => {
  if (req.userToken) {
    return req.userToken.hasScope(scope);
  } else if (req.personalToken) {
    // Personal Tokens had no scope until this date, all scopes were assumed
    if (moment('2023-01-03') > moment(req.personalToken.updatedAt)) {
      return true;
    }
    return req.personalToken.hasScope(scope);
  }

  // No userToken or personalToken, no checkScope
  return true;
};

export const enforceScope = (req: Express.Request, scope: OAuthScope): void => {
  if (!checkScope(req, scope)) {
    if (req.userToken) {
      throw new Forbidden(`The User Token is not allowed for operations in scope "${scope}".`);
    }
    if (req.personalToken) {
      throw new Forbidden(`The Personal Token is not allowed for operations in scope "${scope}".`);
    }
  }
};
