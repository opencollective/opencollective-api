import { get } from 'lodash';

import { types } from '../../constants/collectives';
import FEATURE from '../../constants/feature';
import FEATURE_STATUS from '../../constants/feature-status';
import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../../constants/paymentMethods';
import { hasFeature, isFeatureAllowedForCollectiveType } from '../../lib/allowed-features';
import models, { Op } from '../../models';

const checkIsActive = async (
  promise: Promise<number | boolean>,
  fallback = FEATURE_STATUS.AVAILABLE,
): Promise<FEATURE_STATUS> => {
  return promise.then(result => (result ? FEATURE_STATUS.ACTIVE : fallback));
};

const checkReceiveFinancialContributions = async collective => {
  if (!collective.HostCollectiveId || !collective.approvedAt) {
    return FEATURE_STATUS.DISABLED;
  } else if (!collective.isActive) {
    return FEATURE_STATUS.UNSUPPORTED;
  }

  // If `/donate` is disabled, the collective needs to have at least one active tier
  if (collective.settings?.disableCustomContributions) {
    const hasSomeActiveTiers = await models.Tier.count({ where: { CollectiveId: collective.id }, limit: 1 });
    if (!hasSomeActiveTiers) {
      return FEATURE_STATUS.DISABLED;
    }
  }

  return checkIsActive(
    models.Order.count({
      where: { CollectiveId: collective.id, status: { [Op.or]: ['PAID', 'ACTIVE'] } },
      limit: 1,
    }),
  );
};

const checkVirtualCardFeatureStatus = async account => {
  if (account.isHostAccount) {
    if (get(account.settings, 'features.virtualCards')) {
      return checkIsActive(models.VirtualCard.count({ where: { HostCollectiveId: account.id } }));
    }
  } else if (account.HostCollectiveId) {
    const host = account.host || (await account.getHostCollective());
    if (host && get(host.settings, 'features.virtualCards')) {
      return checkIsActive(models.VirtualCard.count({ where: { CollectiveId: account.id } }));
    }
  }

  return FEATURE_STATUS.DISABLED;
};

const checkCanUsePaymentMethods = async collective => {
  // Ignore type if the account already has some payment methods setup. Useful for Organizations that were turned into Funds.
  const paymentMethodCount = await models.PaymentMethod.count({
    where: {
      CollectiveId: collective.id,
      [Op.or]: [
        { service: PAYMENT_METHOD_SERVICE.STRIPE, type: PAYMENT_METHOD_TYPE.CREDITCARD },
        { service: PAYMENT_METHOD_SERVICE.OPENCOLLECTIVE, type: PAYMENT_METHOD_TYPE.GIFTCARD },
        { service: PAYMENT_METHOD_SERVICE.OPENCOLLECTIVE, type: PAYMENT_METHOD_TYPE.PREPAID },
      ],
    },
  });

  if (paymentMethodCount) {
    return FEATURE_STATUS.ACTIVE;
  } else if ([types.USER, types.ORGANIZATION].includes(collective.type)) {
    return FEATURE_STATUS.AVAILABLE;
  } else {
    return FEATURE_STATUS.UNSUPPORTED;
  }
};

const checkCanEmitGiftCards = async collective => {
  // Ignore type if the account already has some gift cards setup. Useful for Organizations that were turned into Funds.
  const createdGiftCards = await models.PaymentMethod.count({
    where: {
      service: PAYMENT_METHOD_SERVICE.OPENCOLLECTIVE,
      type: PAYMENT_METHOD_TYPE.GIFTCARD,
    },
    include: [
      {
        model: models.PaymentMethod,
        as: 'sourcePaymentMethod',
        where: { CollectiveId: collective.id },
        required: true,
        attributes: [],
      },
    ],
  });

  if (createdGiftCards) {
    return FEATURE_STATUS.ACTIVE;
  } else if ([types.USER, types.ORGANIZATION].includes(collective.type)) {
    return FEATURE_STATUS.AVAILABLE;
  } else {
    return FEATURE_STATUS.UNSUPPORTED;
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
      console.log("UNSPORTED")
      return FEATURE_STATUS.UNSUPPORTED;
    } else if (!hasFeature(collective, feature)) {
      console.log("DISABLED", feature)
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
      case FEATURE.USE_PAYMENT_METHODS:
        return checkCanUsePaymentMethods(collective);
      case FEATURE.EMIT_GIFT_CARDS:
        return checkCanEmitGiftCards(collective);
      case FEATURE.VIRTUAL_CARDS:
        return checkVirtualCardFeatureStatus(collective);
      case FEATURE.REQUEST_VIRTUAL_CARDS: {
        const host = await collective.getHostCollective();
        const balance = await collective.getBalance();
        return balance > 0 && // Collective has balance
          collective.isActive && // Collective is effectively being hosted
          host.settings?.virtualcards?.requestcard
          ? FEATURE_STATUS.ACTIVE // TODO: This flag is misused, there's a confusion between ACTIVE and AVAILABLE
          : FEATURE_STATUS.DISABLED;
      }
      case FEATURE.PAYPAL_PAYOUTS: {
        const hasConnectedAccount = await models.ConnectedAccount.count({
          where: { service: 'paypal', CollectiveId: collective.id },
          limit: 1,
        });
        return hasConnectedAccount ? FEATURE_STATUS.ACTIVE : FEATURE_STATUS.DISABLED;
      }
      default:
        return FEATURE_STATUS.ACTIVE;
    }
  };
