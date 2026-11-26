import config from 'config';
import type Express from 'express';
import { get } from 'lodash';

import { CollectiveType } from '../../constants/collectives';
import FEATURE from '../../constants/feature';
import FEATURE_STATUS from '../../constants/feature-status';
import { getFeatureAccess, isFeatureBlockedForAccount } from '../../lib/allowed-features';
import { isPastEvent } from '../../lib/collectivelib';
import { getSupportedExpenseTypes } from '../../lib/expenses';
import { Collective } from '../../models';
import { type FeatureProbe, queryFeatureProbes } from '../loaders/feature-probes';

import { hasMultiCurrency } from './expenses';

/**
 * Whether the account has the data that the probe looks for.
 *
 * With `req`, the probe joins the other probes of the request in one statement, and its result is cached for the
 * request. Without it, the probe runs alone and is never cached: mutations must use this form, as they would
 * otherwise return what was true before their own write.
 */
const hasData = async (collective, probe: FeatureProbe, req = null): Promise<boolean> => {
  const key = { accountId: collective.id, probe };
  const loader = req?.loaders?.Collective?.featureProbes;
  return loader ? loader.load(key) : queryFeatureProbes([key]).then(([result]) => result);
};

const checkIsActive = async (
  promise: Promise<boolean>,
  fallback = FEATURE_STATUS.AVAILABLE,
): Promise<FEATURE_STATUS> => {
  return promise.then(result => (result ? FEATURE_STATUS.ACTIVE : fallback));
};

/**
 * @param batchProbes - Answer the data probes through the request loaders. Only for resolvers: see `hasData`.
 */
export const checkReceiveFinancialContributions = async (
  collective,
  req,
  { ignoreActive = false, batchProbes = false } = {},
) => {
  const probesReq = batchProbes ? req : null;
  if (!collective.HostCollectiveId || !collective.approvedAt) {
    return FEATURE_STATUS.DISABLED;
  } else if (!collective.isActive) {
    return FEATURE_STATUS.UNSUPPORTED;
  } else if (
    collective.type === CollectiveType.EVENT &&
    isPastEvent(collective) &&
    !req.remoteUser?.isAdminOfCollectiveOrHost(collective)
  ) {
    return FEATURE_STATUS.UNSUPPORTED;
  } else if (isFeatureBlockedForAccount(collective, FEATURE.RECEIVE_FINANCIAL_CONTRIBUTIONS)) {
    return FEATURE_STATUS.DISABLED;
  }

  // Check if contributions are disabled on the parent (for projects and events under a frozen parent)
  if (collective.ParentCollectiveId) {
    const parent = await req.loaders.Collective.byId.load(collective.ParentCollectiveId);
    if (parent && isFeatureBlockedForAccount(parent, FEATURE.RECEIVE_FINANCIAL_CONTRIBUTIONS)) {
      return FEATURE_STATUS.DISABLED;
    }
  }

  // Check if contributions are disabled at the host level
  const host = await req.loaders.Collective.byId.load(collective.HostCollectiveId);
  if (isFeatureBlockedForAccount(host, FEATURE.RECEIVE_FINANCIAL_CONTRIBUTIONS)) {
    return FEATURE_STATUS.DISABLED;
  }

  // If `/donate` is disabled, the collective needs to have at least one active tier
  if (collective.settings?.disableCustomContributions) {
    const hasSomeActiveTiers = await hasData(collective, 'HAS_TIERS', probesReq);
    if (!hasSomeActiveTiers) {
      return FEATURE_STATUS.DISABLED;
    }
  }

  if (ignoreActive) {
    return FEATURE_STATUS.AVAILABLE;
  }

  return checkIsActive(hasData(collective, 'HAS_RECEIVED_CONTRIBUTIONS', probesReq));
};

const checkVirtualCardFeatureStatus = async (account, req) => {
  if (account.hasMoneyManagement) {
    if (get(account.settings, 'features.virtualCards')) {
      return checkIsActive(hasData(account, 'HAS_HOSTED_VIRTUAL_CARDS', req));
    }
  } else if (account.HostCollectiveId) {
    const host = account.host || (await account.getHostCollective({ loaders: req?.loaders }));
    if (host && get(host.settings, 'features.virtualCards')) {
      return checkIsActive(hasData(account, 'HAS_VIRTUAL_CARDS', req));
    }
  }

  return FEATURE_STATUS.DISABLED;
};

/**
 * @param req - Pass it from resolvers only, to answer the data probe through the request loaders: see `hasData`.
 */
export const checkCanUsePaymentMethods = async (collective, req = null) => {
  // Ignore type if the account already has some payment methods setup. Useful for Organizations that were turned into Funds.
  if (await hasData(collective, 'HAS_USABLE_PAYMENT_METHODS', req)) {
    return FEATURE_STATUS.ACTIVE;
  } else if ([CollectiveType.USER, CollectiveType.ORGANIZATION].includes(collective.type)) {
    return FEATURE_STATUS.AVAILABLE;
  } else {
    return FEATURE_STATUS.UNSUPPORTED;
  }
};

export const checkCanRequestVirtualCards = async (req: Express.Request, collective) => {
  if (!collective.HostCollectiveId || !collective.isActive) {
    return FEATURE_STATUS.UNSUPPORTED;
  }

  const host = await collective.getHostCollective({ loaders: req.loaders });
  if (!host?.settings?.virtualcards?.requestcard) {
    return FEATURE_STATUS.DISABLED;
  }

  const balance = await collective.getBalance({ loaders: req.loaders });
  return balance > 0 ? FEATURE_STATUS.AVAILABLE : FEATURE_STATUS.DISABLED;
};

const checkMultiCurrencyExpense = async (collective, req: Express.Request): Promise<FEATURE_STATUS> => {
  if (!collective.HostCollectiveId || !collective.isActive) {
    return FEATURE_STATUS.UNSUPPORTED;
  }

  const host = collective.host || (await req.loaders.Collective.byId.load(collective.HostCollectiveId));
  if (!hasMultiCurrency(collective, host)) {
    return FEATURE_STATUS.UNSUPPORTED;
  }

  return FEATURE_STATUS.AVAILABLE;
};

const checkCanReceiveGrants = async (collective, req: Express.Request) => {
  const supportedTypes = await getSupportedExpenseTypes(collective, { loaders: req.loaders });
  if (!supportedTypes.includes('GRANT')) {
    return FEATURE_STATUS.DISABLED;
  } else {
    return checkIsActive(hasData(collective, 'HAS_RECEIVED_GRANTS', req));
  }
};

const checkCanReceiveExpenses = async (collective, req: Express.Request) => {
  const supportedTypes = await getSupportedExpenseTypes(collective, { loaders: req.loaders });
  if (!supportedTypes.includes('INVOICE') && !supportedTypes.includes('RECEIPT')) {
    return FEATURE_STATUS.DISABLED;
  } else {
    return checkIsActive(hasData(collective, 'HAS_RECEIVED_EXPENSES', req));
  }
};

/**
 * Returns a resolved that will give the `FEATURE_STATUS` for the given collective/feature.
 */
export const getFeatureStatusResolver =
  (feature: FEATURE) =>
  async (collective: Collective, _, req): Promise<FEATURE_STATUS> => {
    if (!collective) {
      return FEATURE_STATUS.UNSUPPORTED;
    }

    // PAYPAL_CONNECT is a platform-level feature: check server config, ignore account settings
    if (feature === FEATURE.PAYPAL_CONNECT) {
      const clientId = config.paypal?.connect?.clientId;
      return clientId ? FEATURE_STATUS.AVAILABLE : FEATURE_STATUS.DISABLED;
    }

    const { access } = await getFeatureAccess(collective, feature, { loaders: req?.loaders });
    if (access === 'UNSUPPORTED') {
      return FEATURE_STATUS.UNSUPPORTED;
    } else if (access === 'DISABLED') {
      return FEATURE_STATUS.DISABLED;
    }

    // Add some special cases that check for data to see if the feature is `ACTIVE` or just `AVAILABLE`
    // Right now only UPDATES, CONVERSATIONS, and RECURRING CONTRIBUTIONS
    switch (feature) {
      case FEATURE.ABOUT:
        return collective.longDescription ? FEATURE_STATUS.ACTIVE : FEATURE_STATUS.AVAILABLE;
      case FEATURE.RECEIVE_FINANCIAL_CONTRIBUTIONS:
        return checkReceiveFinancialContributions(collective, req, { batchProbes: true });
      case FEATURE.RECEIVE_EXPENSES:
        return checkCanReceiveExpenses(collective, req);
      case FEATURE.RECEIVE_GRANTS:
        return checkCanReceiveGrants(collective, req);
      case FEATURE.MULTI_CURRENCY_EXPENSES:
        return checkMultiCurrencyExpense(collective, req);
      case FEATURE.UPDATES:
        return checkIsActive(hasData(collective, 'HAS_PUBLISHED_UPDATES', req));
      case FEATURE.CONVERSATIONS:
        return checkIsActive(hasData(collective, 'HAS_CONVERSATIONS', req));
      case FEATURE.RECURRING_CONTRIBUTIONS:
        return checkIsActive(hasData(collective, 'HAS_ACTIVE_RECURRING_CONTRIBUTIONS', req));
      case FEATURE.TRANSFERWISE:
        return checkIsActive(hasData(collective, 'HAS_WISE_ACCOUNT', req));
      case FEATURE.EVENTS:
        return checkIsActive(hasData(collective, 'HAS_EVENTS', req));
      case FEATURE.PROJECTS:
        return checkIsActive(hasData(collective, 'HAS_PROJECTS', req));
      case FEATURE.CONNECTED_ACCOUNTS:
        return checkIsActive(hasData(collective, 'HAS_CONNECTED_COLLECTIVES', req));
      case FEATURE.TRANSACTIONS:
        return checkIsActive(hasData(collective, 'HAS_TRANSACTIONS', req));
      case FEATURE.USE_PAYMENT_METHODS:
        return checkCanUsePaymentMethods(collective, req);
      case FEATURE.VIRTUAL_CARDS:
        return checkVirtualCardFeatureStatus(collective, req);
      case FEATURE.REQUEST_VIRTUAL_CARDS:
        return checkCanRequestVirtualCards(req, collective);
      case FEATURE.PAYPAL_PAYOUTS:
        return checkIsActive(hasData(collective, 'HAS_PAYPAL_ACCOUNT', req), FEATURE_STATUS.DISABLED);
      case FEATURE.PUBLIC_PROFILE: {
        if (collective.isIncognito) {
          return FEATURE_STATUS.DISABLED;
        }
        // For vendors, the PUBLIC_PROFILE is an opt-in feature that needs to be explicitly enabled by fiscal-host admin.
        else if (collective.type === CollectiveType.VENDOR && collective.settings?.features?.publicProfile !== true) {
          return FEATURE_STATUS.DISABLED;
        }
        return FEATURE_STATUS.ACTIVE;
      }
      default:
        return FEATURE_STATUS.ACTIVE;
    }
  };
