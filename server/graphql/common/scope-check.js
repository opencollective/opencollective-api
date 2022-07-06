import FEATURE from '../../constants/feature';
import { canUseFeature } from '../../lib/user-permissions';
import { FeatureNotAllowedForUser, Forbidden, Unauthorized } from '../errors';

export const checkRemoteUserCanUseVirtualCards = req => {
  if (!req.remoteUser) {
    throw new Unauthorized('You need to be logged in to manage virtual cards.');
  }
  if (!checkScope('virtualCards')) {
    throw new Unauthorized('The User Token is not allowed for mutations in scope "virtualCards".');
  }
};

export const checkRemoteUserCanUsePayoutMethods = req => {
  if (!req.remoteUser) {
    throw new Unauthorized('You need to be logged in to manage payout methods.');
  }
  if (!checkScope('payoutMethods')) {
    throw new Unauthorized('The User Token is not allowed for mutations in scope "payoutMethods".');
  }
};

export const checkRemoteUserCanUsePaymentMethods = req => {
  if (!req.remoteUser) {
    throw new Unauthorized('You need to be logged in to manage payment methods.');
  }
  if (!checkScope('paymentMethods')) {
    throw new Unauthorized('The User Token is not allowed for mutations in scope "paymentMethods".');
  }
};

export const checkRemoteUserCanUseAccount = req => {
  if (!req.remoteUser) {
    throw new Unauthorized('You need to be logged in to manage account.');
  }
  if (!checkScope('account')) {
    throw new Unauthorized('The User Token is not allowed for mutations in scope "account".');
  }
};

export const checkRemoteUserCanUseHost = req => {
  if (!req.remoteUser) {
    throw new Unauthorized('You need to be logged in to manage hosted accounts.');
  }
  if (!checkScope('host')) {
    throw new Unauthorized('The User Token is not allowed for mutations in scope "host".');
  }
};

export const checkRemoteUserCanUseOrders = req => {
  if (!req.remoteUser) {
    throw new Unauthorized('You need to be logged in to manage orders');
  }
  if (!canUseFeature(req.remoteUser, FEATURE.ORDER)) {
    return new FeatureNotAllowedForUser();
  }
  if (!checkScope('orders')) {
    throw new Unauthorized('The User Token is not allowed for mutations in scope "orders".');
  }
};

export const checkRemoteUserCanUseApplications = req => {
  if (!req.remoteUser) {
    throw new Unauthorized('You need to be logged in to manage applications.');
  }
  if (!checkScope('applications')) {
    throw new Unauthorized('The User Token is not allowed for mutations in scope "applications".');
  }
};

export const checkRemoteUserCanUseConversations = req => {
  if (!req.remoteUser) {
    throw new Unauthorized('You need to be logged in to manage conversations');
  }
  if (!canUseFeature(req.remoteUser, FEATURE.CONVERSATIONS)) {
    throw new FeatureNotAllowedForUser();
  }
  if (!checkScope('conversations')) {
    throw new Unauthorized('The User Token is not allowed for mutations in scope "conversations".');
  }
};

export const checkRemoteUserCanUseExpenses = req => {
  if (!req.remoteUser) {
    throw new Unauthorized('You need to be logged in to manage expenses');
  }
  if (!canUseFeature(req.remoteUser, FEATURE.USE_EXPENSES)) {
    throw new FeatureNotAllowedForUser();
  }
  if (!checkScope('expenses')) {
    throw new Unauthorized('The User Token is not allowed for mutations in scope "expenses".');
  }
};

export const checkRemoteUserCanUseUpdates = req => {
  if (!req.remoteUser) {
    throw new Unauthorized('You need to be logged in to manage updates.');
  }
  if (!checkScope('updates')) {
    throw new Unauthorized('The User Token is not allowed for mutations in scope "updates".');
  }
};

export const checkRemoteUserCanUseConnectedAccounts = req => {
  if (!req.remoteUser) {
    throw new Unauthorized('You need to be logged in to manage connected accounts.');
  }
  if (!checkScope('connectedAccounts')) {
    throw new Unauthorized('The User Token is not allowed for mutations in scope "connectedAccounts".');
  }
};

export const checkRemoteUserCanUseWebhooks = req => {
  if (!req.remoteUser) {
    throw new Unauthorized('You need to be logged in to manage webhooks');
  }
  if (req.userToken && !req.userToken.getScope().includes('webhooks')) {
    throw new Unauthorized('The User Token is not allowed for mutations in scope "webhooks".');
  }
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
  if (!checkScope('root')) {
    throw new Unauthorized('The User Token is not allowed for mutations in scope "root".');
  }
};

export const checkScope = (req, scope) => {
  return !req.userToken || req.userToken.hasScope(scope);
};
