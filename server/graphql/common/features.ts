import type Express from 'express';
import { get } from 'lodash';
import { QueryOptions, QueryTypes } from 'sequelize';

import { CollectiveType } from '../../constants/collectives';
import FEATURE from '../../constants/feature';
import FEATURE_STATUS from '../../constants/feature-status';
import { getFeatureAccess, isFeatureBlockedForAccount } from '../../lib/allowed-features';
import { isPastEvent } from '../../lib/collectivelib';
import { getSupportedExpenseTypes } from '../../lib/expenses';
import { Collective, sequelize } from '../../models';

import { hasMultiCurrency } from './expenses';

/**
 * Wraps the given query in a `EXISTS` call and returns the result as a boolean.
 * Would be great to replace with https://github.com/sequelize/sequelize/issues/10187 if it gets implemented
 */
const checkExistsInDB = async (query: string | string[], queryOptions: QueryOptions = null): Promise<boolean> => {
  const queriesArray = Array.isArray(query) ? query : [query];
  const queries = queriesArray.map(q => `EXISTS (${q})`).join(' OR ');
  return sequelize
    .query(`SELECT ${queries} AS result`, { type: QueryTypes.SELECT, plain: true, ...queryOptions })
    .then(returnedValue => (returnedValue as unknown as { result?: boolean }).result);
};

const checkIsActive = async (
  promise: Promise<number | boolean>,
  fallback = FEATURE_STATUS.AVAILABLE,
): Promise<FEATURE_STATUS> => {
  return promise.then(result => (result ? FEATURE_STATUS.ACTIVE : fallback));
};

/** A simple wrapper around checkExistsInDB + checkIsActive */
const checkIsActiveIfExistsInDB = async (
  query: string | string[],
  queryOptions: QueryOptions = null,
  fallback = FEATURE_STATUS.AVAILABLE,
): Promise<FEATURE_STATUS> => {
  return checkIsActive(checkExistsInDB(query, queryOptions), fallback);
};

export const checkReceiveFinancialContributions = async (collective, req, { ignoreActive = false } = {}) => {
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

  // Check if contributions are disabled at the host level
  const host = await req.loaders.Collective.byId.load(collective.HostCollectiveId);
  if (isFeatureBlockedForAccount(host, FEATURE.RECEIVE_FINANCIAL_CONTRIBUTIONS)) {
    return FEATURE_STATUS.DISABLED;
  }

  // If `/donate` is disabled, the collective needs to have at least one active tier
  if (collective.settings?.disableCustomContributions) {
    const hasSomeActiveTiers = await checkExistsInDB(
      'SELECT * FROM "Tiers" WHERE "CollectiveId" = :CollectiveId AND "deletedAt" IS NULL',
      { replacements: { CollectiveId: collective.id } },
    );
    if (!hasSomeActiveTiers) {
      return FEATURE_STATUS.DISABLED;
    }
  }

  if (ignoreActive) {
    return FEATURE_STATUS.AVAILABLE;
  }

  return checkIsActiveIfExistsInDB(
    `SELECT 1 FROM "Orders"
      WHERE "CollectiveId" = :CollectiveId
      AND "status" IN ('ACTIVE', 'PAID')
      AND "deletedAt" IS NULL
    `,
    {
      replacements: { CollectiveId: collective.id },
    },
  );
};

const checkVirtualCardFeatureStatus = async account => {
  if (account.hasMoneyManagement) {
    if (get(account.settings, 'features.virtualCards')) {
      return checkIsActiveIfExistsInDB(
        'SELECT 1 FROM "VirtualCards" WHERE "HostCollectiveId" = :CollectiveId AND "deletedAt" IS NULL',
        { replacements: { CollectiveId: account.id } },
      );
    }
  } else if (account.HostCollectiveId) {
    const host = account.host || (await account.getHostCollective());
    if (host && get(host.settings, 'features.virtualCards')) {
      return checkIsActiveIfExistsInDB(
        'SELECT 1 FROM "VirtualCards" WHERE "CollectiveId" = :CollectiveId AND "deletedAt" IS NULL',
        { replacements: { CollectiveId: account.id } },
      );
    }
  }

  return FEATURE_STATUS.DISABLED;
};

export const checkCanUsePaymentMethods = async collective => {
  // Ignore type if the account already has some payment methods setup. Useful for Organizations that were turned into Funds.
  const hasPaymentMethods = await checkExistsInDB(
    `
    SELECT 1 FROM "PaymentMethods"
    WHERE "CollectiveId" = :CollectiveId
    AND "deletedAt" IS NULL
    AND (
      (service = 'opencollective' AND type = 'prepaid')
      OR (service = 'opencollective' AND type = 'giftcard')
      OR (service = 'stripe' AND type = 'creditcard')
    )
  `,
    {
      replacements: { CollectiveId: collective.id },
    },
  );

  if (hasPaymentMethods) {
    return FEATURE_STATUS.ACTIVE;
  } else if ([CollectiveType.USER, CollectiveType.ORGANIZATION].includes(collective.type)) {
    return FEATURE_STATUS.AVAILABLE;
  } else {
    return FEATURE_STATUS.UNSUPPORTED;
  }
};

const checkCanRequestVirtualCards = async (req: Express.Request, collective) => {
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

export const checkCanEmitGiftCards = async collective => {
  // Ignore type if the account already has some gift cards setup. Useful for Organizations that were turned into Funds.

  const hasCreatedGiftCards = await checkExistsInDB(
    `
    SELECT 1 FROM "PaymentMethods" pm
    INNER JOIN "PaymentMethods" source ON source.id = pm."SourcePaymentMethodId"
    WHERE source."CollectiveId" = :CollectiveId
    AND source."deletedAt" IS NULL
    AND pm."deletedAt" IS NULL
    AND pm.service = 'opencollective'
    AND pm.type = 'giftcard'
  `,
    {
      replacements: { CollectiveId: collective.id },
    },
  );

  if (hasCreatedGiftCards) {
    return FEATURE_STATUS.ACTIVE;
  } else if ([CollectiveType.USER, CollectiveType.ORGANIZATION].includes(collective.type)) {
    return FEATURE_STATUS.AVAILABLE;
  } else {
    return FEATURE_STATUS.UNSUPPORTED;
  }
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
    return checkIsActiveIfExistsInDB(
      `SELECT 1 FROM "Expenses" WHERE "CollectiveId" = :CollectiveId AND "deletedAt" IS NULL AND "type" = 'GRANT'`,
      { replacements: { CollectiveId: collective.id } },
    );
  }
};

const checkCanReceiveExpenses = async (collective, req: Express.Request) => {
  const supportedTypes = await getSupportedExpenseTypes(collective, { loaders: req.loaders });
  if (!supportedTypes.includes('INVOICE') && !supportedTypes.includes('RECEIPT')) {
    return FEATURE_STATUS.DISABLED;
  } else {
    return checkIsActiveIfExistsInDB(
      `SELECT 1 FROM "Expenses" WHERE "CollectiveId" = :CollectiveId AND "deletedAt" IS NULL AND "type" IN ('INVOICE', 'RECEIPT')`,
      { replacements: { CollectiveId: collective.id } },
    );
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
        return checkReceiveFinancialContributions(collective, req);
      case FEATURE.RECEIVE_EXPENSES:
        return checkCanReceiveExpenses(collective, req);
      case FEATURE.RECEIVE_GRANTS:
        return checkCanReceiveGrants(collective, req);
      case FEATURE.MULTI_CURRENCY_EXPENSES:
        return checkMultiCurrencyExpense(collective, req);
      case FEATURE.UPDATES:
        return checkIsActiveIfExistsInDB(
          `SELECT 1 FROM "Updates" WHERE "CollectiveId" = :CollectiveId AND "deletedAt" IS NULL AND "publishedAt" IS NOT NULL`,
          { replacements: { CollectiveId: collective.id } },
        );
      case FEATURE.CONVERSATIONS:
        return checkIsActiveIfExistsInDB(
          'SELECT 1 FROM "Conversations" WHERE "CollectiveId" = :CollectiveId AND "deletedAt" IS NULL',
          { replacements: { CollectiveId: collective.id } },
        );
      case FEATURE.RECURRING_CONTRIBUTIONS:
        return checkIsActiveIfExistsInDB(
          `SELECT 1 FROM "Orders" WHERE "FromCollectiveId" = :CollectiveId AND "deletedAt" IS NULL AND "SubscriptionId" IS NOT NULL AND "status" = 'ACTIVE'`,
          { replacements: { CollectiveId: collective.id } },
        );
      case FEATURE.TRANSFERWISE:
        return checkIsActiveIfExistsInDB(
          `SELECT 1 FROM "ConnectedAccounts" WHERE "CollectiveId" = :CollectiveId AND "deletedAt" IS NULL AND "service" = 'transferwise'`,
          { replacements: { CollectiveId: collective.id } },
        );
      case FEATURE.EVENTS:
        return checkIsActiveIfExistsInDB(
          `SELECT 1 FROM "Collectives" WHERE "ParentCollectiveId" = :CollectiveId AND "deletedAt" IS NULL AND "type" = 'EVENT'`,
          { replacements: { CollectiveId: collective.id } },
        );
      case FEATURE.PROJECTS:
        return checkIsActiveIfExistsInDB(
          `SELECT 1 FROM "Collectives" WHERE "ParentCollectiveId" = :CollectiveId AND "deletedAt" IS NULL AND "type" = 'PROJECT'`,
          { replacements: { CollectiveId: collective.id } },
        );
      case FEATURE.CONNECTED_ACCOUNTS:
        return checkIsActiveIfExistsInDB(
          `SELECT 1 FROM "Members" WHERE "CollectiveId" = :CollectiveId AND "deletedAt" IS NULL AND role = 'CONNECTED_COLLECTIVE'`,
          { replacements: { CollectiveId: collective.id } },
        );
      case FEATURE.TRANSACTIONS:
        return checkIsActiveIfExistsInDB(
          [
            // Using two EXISTS as Postgres is not using the best indexes otherwise
            `SELECT 1 FROM "Transactions" WHERE "CollectiveId" = :CollectiveId AND "deletedAt" IS NULL`,
            // `SELECT 1 FROM "Transactions" WHERE "FromCollectiveId" = :CollectiveId AND "deletedAt" IS NULL`,
          ],
          { replacements: { CollectiveId: collective.id } },
        );
      case FEATURE.USE_PAYMENT_METHODS:
        return checkCanUsePaymentMethods(collective);
      case FEATURE.EMIT_GIFT_CARDS:
        return checkCanEmitGiftCards(collective);
      case FEATURE.VIRTUAL_CARDS:
        return checkVirtualCardFeatureStatus(collective);
      case FEATURE.REQUEST_VIRTUAL_CARDS:
        return checkCanRequestVirtualCards(req, collective);
      case FEATURE.PAYPAL_PAYOUTS: {
        return checkIsActiveIfExistsInDB(
          `SELECT 1 FROM "ConnectedAccounts" WHERE "CollectiveId" = :CollectiveId AND "deletedAt" IS NULL AND "service" = 'paypal'`,
          { replacements: { CollectiveId: collective.id } },
          FEATURE_STATUS.DISABLED,
        );
      }
      default:
        return FEATURE_STATUS.ACTIVE;
    }
  };
