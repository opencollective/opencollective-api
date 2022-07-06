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
  if (req.userToken && !req.userToken.getScope().includes('expenses')) {
    throw new Unauthorized('The User Token is not allowed for mutations in scope "expenses".');
  }
};

export const checkRemoteUserCanUseUpdates = req => {
  if (!req.remoteUser) {
    throw new Unauthorized('You need to be logged in to manage updates.');
  }
  if (req.userToken && !req.userToken.getScope().includes('updates')) {
    throw new Unauthorized('The User Token is not allowed for mutations in scope "updates".');
  }
};

export const checkRemoteUserCanRoot = req => {
  if (!req.remoteUser?.isRoot()) {
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
