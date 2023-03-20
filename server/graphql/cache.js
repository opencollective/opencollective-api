import { difference, isEqual } from 'lodash';

import { TransactionKind } from '../constants/transaction-kind';
import { md5 } from '../lib/utils';

export const purgeCacheForCollectiveOperationNames = [
  'CollectivePage',
  'ContributePage',
  'BudgetSection',
  'BudgetSectionWithHost',
  'UpdatesSection',
  'TransactionsSection',
  'TransactionsPage',
  'ExpensesPage',
  'CollectiveBannerIframe',
  'CollectiveCover',
  'RecurringContributions',
  'ContributionsSectionStatic',
  'Members_Users',
  'Members_Organizations',
];

export function checkSupportedVariables(req, variableNames) {
  if (!req.body.variables) {
    return false;
  }
  // Check missing variables
  if (difference(variableNames, Object.keys(req.body.variables)).length > 0) {
    return false;
  }
  // Check extra variables
  if (difference(Object.keys(req.body.variables), variableNames).length > 0) {
    return false;
  }

  return true;
}

function getCacheKeyForBudgetOrTransactionsSections(req, queryHash) {
  if (
    req.body.variables.kind &&
    !isEqual(req.body.variables.kind.sort(), [
      TransactionKind.ADDED_FUNDS,
      TransactionKind.BALANCE_TRANSFER,
      TransactionKind.CONTRIBUTION,
      TransactionKind.EXPENSE,
      TransactionKind.PLATFORM_TIP,
    ])
  ) {
    return;
  }
  return `${req.body.operationName}_${queryHash}_${req.body.variables.slug}`;
}

export function getGraphqlCacheKey(req) {
  if (req.remoteUser) {
    return;
  }
  if (!req.body || !req.body.operationName || !req.body.query) {
    return;
  }

  const queryHash = md5(req.body.query);

  switch (req.body.operationName) {
    case 'CollectivePage':
    case 'ContributePage':
      if (!checkSupportedVariables(req, ['slug', 'nbContributorsPerContributeCard'])) {
        return;
      }
      if (req.body.variables.nbContributorsPerContributeCard !== 4) {
        return;
      }
      return `${req.body.operationName}_${queryHash}_${req.body.variables.slug}`;
    case 'BudgetSection':
      if (!checkSupportedVariables(req, ['slug', 'limit', 'kind'])) {
        return;
      }
      if (req.body.variables.limit !== 3) {
        return;
      }
      return getCacheKeyForBudgetOrTransactionsSections(req, queryHash);
    case 'BudgetSectionWithHost':
      if (!checkSupportedVariables(req, ['slug', 'limit', 'kind'])) {
        return;
      }
      if (req.body.variables.limit !== 3) {
        return;
      }
      return getCacheKeyForBudgetOrTransactionsSections(req, queryHash);
    case 'UpdatesSection':
      if (!checkSupportedVariables(req, ['slug', 'onlyPublishedUpdates'])) {
        return;
      }
      if (req.body.variables.onlyPublishedUpdates !== true) {
        return;
      }
      return `${req.body.operationName}_${queryHash}_${req.body.variables.slug}`;
    case 'TransactionsSection':
      if (!checkSupportedVariables(req, ['slug', 'limit', 'kind'])) {
        return;
      }
      if (req.body.variables.limit !== 10) {
        return;
      }
      return getCacheKeyForBudgetOrTransactionsSections(req, queryHash);
    case 'TransactionsPage':
      if (!checkSupportedVariables(req, ['slug', 'offset', 'limit'])) {
        return;
      }
      if (req.body.variables.offset !== 0 || req.body.variables.limit !== 15) {
        return;
      }
      return `${req.body.operationName}_${queryHash}_${req.body.variables.slug}`;
    case 'ExpensesPage':
      if (!checkSupportedVariables(req, ['collectiveSlug', 'offset', 'limit'])) {
        return;
      }
      if (req.body.variables.offset !== 0 || req.body.variables.limit !== 10) {
        return;
      }
      return `${req.body.operationName}_${queryHash}_${req.body.variables.collectiveSlug}`;
    case 'CollectiveBannerIframe':
      if (!checkSupportedVariables(req, ['collectiveSlug'])) {
        return;
      }
      return `${req.body.operationName}_${queryHash}_${req.body.variables.collectiveSlug}`;
    case 'CollectiveCover':
    case 'RecurringContributions':
    case 'ContributionsSectionStatic':
      if (!checkSupportedVariables(req, ['slug'])) {
        return;
      }
      return `${req.body.operationName}_${queryHash}_${req.body.variables.slug}`;
    case 'Members':
      if (!checkSupportedVariables(req, ['collectiveSlug', 'offset', 'limit', 'type', 'role', 'orderBy'])) {
        return;
      }
      if (req.body.variables.offset !== 0 || req.body.variables.limit !== 100) {
        return;
      }
      if (req.body.variables.role !== 'BACKER') {
        return;
      }
      if (req.body.variables.type === 'ORGANIZATION,COLLECTIVE') {
        return `${req.body.operationName}_${queryHash}_Organizations_${req.body.variables.collectiveSlug}`;
      } else if (req.body.variables.type === 'USER') {
        return `${req.body.operationName}_${queryHash}_Users_${req.body.variables.collectiveSlug}`;
      } else {
        return;
      }

    case 'ContributionsSection':
      if (!checkSupportedVariables(req, ['slug', 'offset', 'limit', 'role', 'accountType', 'orderBy'])) {
        return;
      }
      if (req.body.variables.offset !== 0 || req.body.variables.limit !== 15) {
        return;
      }
      if (req.body.variables.orderBy.field !== 'MEMBER_COUNT' || req.body.variables.orderBy.direction !== 'DESC') {
        return;
      }
      if (!req.body.variables.role || req.body.variables.role.length !== 1) {
        return;
      }
      if (!req.body.variables.accountType || req.body.variables.accountType.length !== 1) {
        return;
      }
      return `${req.body.operationName}_${queryHash}_${req.body.variables.role[0]}_${req.body.variables.accountType[0]}_${req.body.variables.slug}`;
  }
}
