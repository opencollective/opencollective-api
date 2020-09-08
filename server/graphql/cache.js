import { difference } from 'lodash';

export const purgeCacheForCollectiveOperationNames = [
  'CollectivePage',
  'BudgetSection',
  'UpdatesSection',
  'TransactionsSection',
  'TransactionsPage',
  'ExpensesPage',
  'CollectiveBannerIframe',
  'CollectiveCover',
  'RecurringContributions',
  'ContributionsSection',
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

export function getGraphqlCacheKey(req) {
  if (req.remoteUser) {
    return;
  }
  if (!req.body || !req.body.operationName) {
    return;
  }
  switch (req.body.operationName) {
    case 'CollectivePage':
      if (!checkSupportedVariables(req, ['slug', 'nbContributorsPerContributeCard'])) {
        return;
      }
      if (req.body.variables.nbContributorsPerContributeCard !== 4) {
        return;
      }
      return `${req.body.operationName}_${req.body.variables.slug}`;
    case 'BudgetSection':
      if (!checkSupportedVariables(req, ['slug', 'limit'])) {
        return;
      }
      if (req.body.variables.limit !== 3) {
        return;
      }
      return `${req.body.operationName}_${req.body.variables.slug}`;
    case 'UpdatesSection':
      if (!checkSupportedVariables(req, ['slug', 'onlyPublishedUpdates'])) {
        return;
      }
      if (req.body.variables.onlyPublishedUpdates !== true) {
        return;
      }
      return `${req.body.operationName}_${req.body.variables.slug}`;
    case 'TransactionsSection':
      if (!checkSupportedVariables(req, ['slug', 'limit'])) {
        return;
      }
      if (req.body.variables.limit !== 10) {
        return;
      }
      return `${req.body.operationName}_${req.body.variables.slug}`;
    case 'TransactionsPage':
      if (!checkSupportedVariables(req, ['slug', 'offset', 'limit'])) {
        return;
      }
      if (req.body.variables.offset !== 0 || req.body.variables.limit !== 15) {
        return;
      }
      return `${req.body.operationName}_${req.body.variables.slug}`;
    case 'ExpensesPage':
      if (!checkSupportedVariables(req, ['collectiveSlug', 'offset', 'limit'])) {
        return;
      }
      if (req.body.variables.offset !== 0 || req.body.variables.limit !== 10) {
        return;
      }
      return `${req.body.operationName}_${req.body.variables.collectiveSlug}`;
    case 'CollectiveBannerIframe':
      if (!checkSupportedVariables(req, ['collectiveSlug'])) {
        return;
      }
      return `${req.body.operationName}_${req.body.variables.collectiveSlug}`;
    case 'CollectiveCover':
    case 'RecurringContributions':
    case 'ContributionsSection':
      if (!checkSupportedVariables(req, ['slug'])) {
        return;
      }
      return `${req.body.operationName}_${req.body.variables.slug}`;
  }
}
