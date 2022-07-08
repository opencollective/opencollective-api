import FEATURE from '../../constants/feature';
import { canUseFeature } from '../../lib/user-permissions';
import { FeatureNotAllowedForUser, Forbidden, Unauthorized } from '../errors';

export const checkRemoteUserCanUseVirtualCards = req => {
  if (!req.remoteUser) {
    throw new Unauthorized('You need to be logged in to manage virtual cards.');
  }
  enforceScope(req, 'virtualCards');
};

export const checkRemoteUserCanUseAccount = req => {
  if (!req.remoteUser) {
    throw new Unauthorized('You need to be logged in to manage account.');
  }
  enforceScope(req, 'account');
};

export const checkRemoteUserCanUseHost = req => {
  if (!req.remoteUser) {
    throw new Unauthorized('You need to be logged in to manage hosted accounts.');
  }
  enforceScope(req, 'host');
};

export const checkRemoteUserCanUseTransactions = req => {
  if (!req.remoteUser) {
    throw new Unauthorized('You need to be logged in to manage transactions.');
  }
  enforceScope(req, 'transactions');
};

export const checkRemoteUserCanUseOrders = req => {
  if (!req.remoteUser) {
    throw new Unauthorized('You need to be logged in to manage orders');
  }
  if (!canUseFeature(req.remoteUser, FEATURE.ORDER)) {
    return new FeatureNotAllowedForUser();
  }
  enforceScope(req, 'orders');
};

export const checkRemoteUserCanUseApplications = req => {
  if (!req.remoteUser) {
    throw new Unauthorized('You need to be logged in to manage applications.');
  }
  enforceScope(req, 'applications');
};

export const checkRemoteUserCanUseConversations = req => {
  if (!req.remoteUser) {
    throw new Unauthorized('You need to be logged in to manage conversations');
  }
  if (!canUseFeature(req.remoteUser, FEATURE.CONVERSATIONS)) {
    throw new FeatureNotAllowedForUser();
  }
  enforceScope(req, 'conversations');
};

export const checkRemoteUserCanUseExpenses = req => {
  if (!req.remoteUser) {
    throw new Unauthorized('You need to be logged in to manage expenses');
  }
  if (!canUseFeature(req.remoteUser, FEATURE.USE_EXPENSES)) {
    throw new FeatureNotAllowedForUser();
  }
  enforceScope(req, 'expenses');
};

export const checkRemoteUserCanUseUpdates = req => {
  if (!req.remoteUser) {
    throw new Unauthorized('You need to be logged in to manage updates.');
  }
  enforceScope(req, 'updates');
};

export const checkRemoteUserCanUseConnectedAccounts = req => {
  if (!req.remoteUser) {
    throw new Unauthorized('You need to be logged in to manage connected accounts.');
  }
  enforceScope(req, 'connectedAccounts');
};

export const checkRemoteUserCanUseWebhooks = req => {
  if (!req.remoteUser) {
    throw new Unauthorized('You need to be logged in to manage webhooks');
  }
  enforceScope(req, 'webhooks');
};

export const checkRemoteUserCanUseComment = (comment, req) => {
  if (comment.ConversationId) {
    checkRemoteUserCanUseConversations(req);
  } else if (comment.UpdateId) {
    checkRemoteUserCanUseUpdates(req);
  } else if (comment.ExpenseId) {
    checkRemoteUserCanUseExpenses(req);
  }
};

export const checkRemoteUserCanRoot = req => {
  if (!req.remoteUser) {
    throw new Unauthorized('You need to be logged in.');
  }
  if (!req.remoteUser?.isRoot()) {
    throw new Forbidden('You need to be logged in as root.');
  }
  enforceScope(req, 'root');
};

export const checkScope = (req, scope) => {
  return !req.userToken || req.userToken.hasScope(scope);
};

export const enforceScope = (req, scope) => {
  if (!checkScope(req, scope)) {
    throw new Forbidden(`The User Token is not allowed for operations in scope "${scope}".`);
  }
};
