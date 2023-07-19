import { get } from 'lodash-es';
import { QueryOptions } from 'sequelize';

import { types } from '../../constants/collectives.js';
import FEATURE from '../../constants/feature.js';
import FEATURE_STATUS from '../../constants/feature-status.js';
import { hasFeature, isFeatureAllowedForCollectiveType } from '../../lib/allowed-features.js';
import { isPastEvent } from '../../lib/collectivelib.js';
import { Collective, sequelize } from '../../models/index.js';

import { hasMultiCurrency } from './expenses.js';

/**
 * Wraps the given query in a `EXISTS` call and returns the result as a boolean.
 * Would be great to replace with https://github.com/sequelize/sequelize/issues/10187 if it gets implemented
 */
const checkExistsInDB = async (query: string | string[], queryOptions: QueryOptions = null): Promise<boolean> => {
  const queriesArray = Array.isArray(query) ? query : [query];
  const queries = queriesArray.map(q => `EXISTS (${q})`).join(' OR ');
  return sequelize
    .query(`SELECT ${queries} AS result`, { type: sequelize.QueryTypes.SELECT, plain: true, ...queryOptions })
    .then(({ result }) => result);
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

const checkReceiveFinancialContributions = async (collective, remoteUser) => {
  if (!collective.HostCollectiveId || !collective.approvedAt) {
    return FEATURE_STATUS.DISABLED;
  } else if (!collective.isActive) {
    return FEATURE_STATUS.UNSUPPORTED;
  } else if (
    collective.type === types.EVENT &&
    isPastEvent(collective) &&
    !remoteUser?.isAdminOfCollectiveOrHost(collective)
  ) {
    return FEATURE_STATUS.UNSUPPORTED;
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
  if (account.isHostAccount) {
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
  } else if ([types.USER, types.ORGANIZATION].includes(collective.type)) {
    return FEATURE_STATUS.AVAILABLE;
  } else {
    return FEATURE_STATUS.UNSUPPORTED;
  }
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
  } else if ([types.USER, types.ORGANIZATION].includes(collective.type)) {
    return FEATURE_STATUS.AVAILABLE;
  } else {
    return FEATURE_STATUS.UNSUPPORTED;
  }
};

const checkMultiCurrencyExpense = async (collective, req): Promise<FEATURE_STATUS> => {
  if (!collective.HostCollectiveId) {
    return FEATURE_STATUS.UNSUPPORTED;
  }

  const host = collective.host || (await req.loaders.Collective.byId.load(collective.HostCollectiveId));
  if (!hasMultiCurrency(collective, host)) {
    return FEATURE_STATUS.UNSUPPORTED;
  }

  return FEATURE_STATUS.AVAILABLE;
};

/**
 * Returns a resolved that will give the `FEATURE_STATUS` for the given collective/feature.
 */
export const getFeatureStatusResolver =
  (feature: FEATURE) =>
  async (collective: Collective, _, req): Promise<FEATURE_STATUS> => {
    if (!collective) {
      return FEATURE_STATUS.UNSUPPORTED;
    } else if (!isFeatureAllowedForCollectiveType(collective.type, feature, collective.isHostAccount)) {
      return FEATURE_STATUS.UNSUPPORTED;
    } else if (!hasFeature(collective, feature)) {
      return FEATURE_STATUS.DISABLED;
    }

    // Add some special cases that check for data to see if the feature is `ACTIVE` or just `AVAILABLE`
    // Right now only UPDATES, CONVERSATIONS, and RECURRING CONTRIBUTIONS
    switch (feature) {
      case FEATURE.ABOUT:
        return collective.longDescription ? FEATURE_STATUS.ACTIVE : FEATURE_STATUS.AVAILABLE;
      case FEATURE.RECEIVE_FINANCIAL_CONTRIBUTIONS:
        return checkReceiveFinancialContributions(collective, req.remoteUser);
      case FEATURE.RECEIVE_EXPENSES:
        return checkIsActiveIfExistsInDB(
          `SELECT 1 FROM "Expenses" WHERE "CollectiveId" = :CollectiveId AND "deletedAt" IS NULL`,
          { replacements: { CollectiveId: collective.id } },
        );
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
          FEATURE_STATUS.DISABLED,
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
            `SELECT 1 FROM "Transactions" WHERE "FromCollectiveId" = :CollectiveId AND "deletedAt" IS NULL`,
          ],
          { replacements: { CollectiveId: collective.id } },
        );
      case FEATURE.USE_PAYMENT_METHODS:
        return checkCanUsePaymentMethods(collective);
      case FEATURE.EMIT_GIFT_CARDS:
        return checkCanEmitGiftCards(collective);
      case FEATURE.VIRTUAL_CARDS:
        return checkVirtualCardFeatureStatus(collective);
      case FEATURE.REQUEST_VIRTUAL_CARDS: {
        const host = await collective.getHostCollective({ loaders: req.loaders });
        const balance = await collective.getBalance();
        return balance > 0 && // Collective has balance
          collective.isActive && // Collective is effectively being hosted
          host?.settings?.virtualcards?.requestcard
          ? FEATURE_STATUS.ACTIVE // TODO: This flag is misused, there's a confusion between ACTIVE and AVAILABLE
          : FEATURE_STATUS.DISABLED;
      }
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
