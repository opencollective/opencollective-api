import { types } from '../../constants/collectives';
import FEATURE from '../../constants/feature';
import FEATURE_STATUS from '../../constants/feature-status';
import { hasFeature, isFeatureAllowedForCollectiveType } from '../../lib/allowed-features';
import models, { Op } from '../../models';

const checkIsActive = async (
  promise: Promise<number | boolean>,
  fallback = FEATURE_STATUS.AVAILABLE,
): Promise<FEATURE_STATUS> => {
  const result = promise?.then ? await promise : promise;
  return result ? FEATURE_STATUS.ACTIVE : fallback;
};

const checkReceiveFinancialContributions = collective => {
  if (!collective.HostCollectiveId || !collective.approvedAt) {
    return FEATURE_STATUS.DISABLED;
  } else if (!collective.isActive) {
    return FEATURE_STATUS.UNSUPPORTED;
  } else {
    return checkIsActive(
      models.Order.count({
        where: { CollectiveId: collective.id, status: { [Op.or]: ['PAID', 'ACTIVE'] } },
        limit: 1,
      }),
    );
  }
};

/**
 * Returns a resolved that will give the `FEATURE_STATUS` for the given collective/feature.
 */
export const getFeatureStatusResolver =
  (feature: FEATURE) =>
  async (collective: typeof models.Collective): Promise<FEATURE_STATUS> => {
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
        return checkReceiveFinancialContributions(collective);
      case FEATURE.RECEIVE_EXPENSES:
        return checkIsActive(models.Expense.count({ where: { CollectiveId: collective.id }, limit: 1 }));
      case FEATURE.UPDATES:
        return checkIsActive(
          models.Update.count({
            where: { CollectiveId: collective.id, publishedAt: { [Op.not]: null } },
            limit: 1,
          }),
        );
      case FEATURE.CONVERSATIONS:
        return checkIsActive(models.Conversation.count({ where: { CollectiveId: collective.id }, limit: 1 }));
      case FEATURE.RECURRING_CONTRIBUTIONS:
        return checkIsActive(
          models.Order.count({
            where: { FromCollectiveId: collective.id, SubscriptionId: { [Op.not]: null }, status: 'ACTIVE' },
            limit: 1,
          }),
        );
      case FEATURE.TRANSFERWISE:
        return checkIsActive(
          models.ConnectedAccount.count({
            where: { service: 'transferwise', CollectiveId: collective.id },
            limit: 1,
          }),
          FEATURE_STATUS.DISABLED,
        );
      case FEATURE.EVENTS:
        return checkIsActive(
          models.Collective.count({
            where: { type: types.EVENT, ParentCollectiveId: collective.id },
            limit: 1,
          }),
        );
      case FEATURE.PROJECTS:
        return checkIsActive(
          models.Collective.count({
            where: { type: types.PROJECT, ParentCollectiveId: collective.id },
            limit: 1,
          }),
        );
      case FEATURE.CONNECTED_ACCOUNTS:
        return checkIsActive(
          models.Member.count({
            where: { role: 'CONNECTED_COLLECTIVE', CollectiveId: collective.id },
            limit: 1,
          }),
        );
      case FEATURE.TRANSACTIONS:
        return checkIsActive(
          models.Transaction.count({
            where: { [Op.or]: { CollectiveId: collective.id, FromCollectiveId: collective.id } },
            limit: 1,
          }),
        );
      case FEATURE.VIRTUAL_CARDS:
        return checkIsActive(collective.settings?.features?.privacyVcc, FEATURE_STATUS.DISABLED);
      case FEATURE.REQUEST_VIRTUAL_CARDS: {
        const host = await collective.getHostCollective();
        const balance = await collective.getBalance();
        return checkIsActive(
          balance > 0 && // Collective has balance
            collective.isActive && // Collective is effectively being hosted
            host.settings?.virtualcards?.requestcard,
          FEATURE_STATUS.DISABLED,
        );
      }
      default:
        return FEATURE_STATUS.ACTIVE;
    }
  };
