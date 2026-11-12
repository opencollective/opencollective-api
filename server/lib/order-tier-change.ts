/**
 * Tier changes on recurring contributions.
 *
 * A contributor must only get a tier's benefits (`Orders.TierId`, a BACKER `Members` row on that tier, public
 * listing as that tier's backer) once they have actually paid an amount that satisfies the tier. `updateOrder`
 * therefore applies a tier change immediately only when the latest successful charge of the order already
 * covers the new tier (downgrades, lateral moves, custom contributions). Otherwise the change is stored as
 * `Order.data.pendingTierChange`: the new amount is billed from the next charge on, and the tier is applied by
 * `applyPendingTierChangeAfterCharge` once a charge that covers it succeeds.
 */

import { omit } from 'lodash';
import type { Transaction as SequelizeTransaction } from 'sequelize';

import ActivityTypes from '../constants/activities';
import OrderStatuses from '../constants/order-status';
import roles from '../constants/roles';
import { TransactionKind } from '../constants/transaction-kind';
import { TransactionTypes } from '../constants/transactions';
import models, { Op, sequelize } from '../models';
import type Member from '../models/Member';
import type Order from '../models/Order';
import type Tier from '../models/Tier';
import type Transaction from '../models/Transaction';
import type User from '../models/User';

import { roundCentsAmount } from './currency';
import logger from './logger';
import { reportErrorToSentry, reportMessageToSentry } from './sentry';

/**
 * Whether a payment of `amountInCents` (in order currency, excluding platform tip, including taxes) pays for
 * `tier`. Unlike `assertOrderAmountMatchesTier`, paying more than a fixed tier's price satisfies it.
 */
export const doesAmountSatisfyTier = (
  tier: Pick<Tier, 'amountType' | 'amount' | 'minimumAmount' | 'currency'> | null,
  order: Pick<Order, 'currency' | 'quantity' | 'data'>,
  amountInCents: number | null,
): boolean => {
  const requiredUnitAmount = !tier ? 0 : tier.amountType === 'FIXED' ? tier.amount : tier.minimumAmount;
  if (!requiredUnitAmount) {
    return true; // Tier has no price, nothing to pay for
  } else if (tier.currency && tier.currency !== order.currency) {
    return false; // Amounts in different currencies can't be compared
  } else if (amountInCents === null || amountInCents === undefined) {
    return false;
  }

  const taxPercentage = order.data?.tax?.percentage || 0;
  const baseAmount = taxPercentage
    ? roundCentsAmount(amountInCents / (1 + taxPercentage / 100), order.currency)
    : amountInCents;
  const requiredBaseAmount = roundCentsAmount(requiredUnitAmount * (order.quantity ?? 1), order.currency);
  return baseAmount >= requiredBaseAmount;
};

/**
 * Amount paid to the collective by a charge, read from the ledger: the CONTRIBUTION CREDIT of the charge's
 * transaction group. Platform tips are recorded separately so they're excluded; taxes are included.
 * Returns null when the amount can't be compared with the order (e.g. different currency).
 */
const getPaidAmountFromContributionCredit = (
  order: Order,
  credit: Transaction | null,
): { amount: number; transactionId: number } | null => {
  if (!credit) {
    return null;
  } else if (credit.currency !== order.currency) {
    return null;
  }

  return { amount: credit.amount, transactionId: credit.id };
};

const findChargeContributionCredit = (
  order: Order,
  chargeTransaction: Transaction,
  transaction?: SequelizeTransaction,
) =>
  models.Transaction.findOne({
    transaction,
    where: {
      OrderId: order.id,
      TransactionGroup: chargeTransaction.TransactionGroup,
      kind: TransactionKind.CONTRIBUTION,
      type: TransactionTypes.CREDIT,
      isRefund: false,
    },
  });

/**
 * Amount of the latest successful, non-refunded charge of the order.
 * See `getPaidAmountFromContributionCredit` for the unit.
 */
export const getLastPaidAmount = async (order: Order): Promise<number | null> => {
  const credit = await models.Transaction.findOne({
    where: {
      OrderId: order.id,
      CollectiveId: order.CollectiveId,
      kind: TransactionKind.CONTRIBUTION,
      type: TransactionTypes.CREDIT,
      isRefund: false,
      RefundTransactionId: null,
    },
    order: [
      ['createdAt', 'DESC'],
      ['id', 'DESC'],
    ],
  });

  return getPaidAmountFromContributionCredit(order, credit)?.amount ?? null;
};

type BackerMembershipKey = { MemberCollectiveId: number; TierId: number | null };

/**
 * Moves a BACKER membership of `CollectiveId` from `from` to `to` (another tier and/or another member account),
 * because the contributions in `movedOrderIds` moved there.
 *
 * Memberships are unique per (account, collective, role, tier), and other contributions from the same account
 * can rely on the same row:
 * - if a membership already exists for `to`, it is reused (the source is merged into it, never duplicated);
 * - the source row is only moved/removed when no other active or paid contribution from the source account is on
 *   the source tier, otherwise it is kept and the target is created next to it.
 * A missing target row is created without the "new member" activity, since this is not a new contributor. With
 * `onlyIfSourceExists`, nothing is created when there's no source membership to move.
 *
 * Returns the membership the moved contributions now rely on (null if none) and what was created/removed.
 */
export const moveBackerMembership = async (
  {
    CollectiveId,
    from,
    to,
    movedOrderIds,
    CreatedByUserId,
    onlyIfSourceExists = false,
  }: {
    CollectiveId: number;
    from: BackerMembershipKey;
    to: BackerMembershipKey;
    movedOrderIds: number[];
    CreatedByUserId: number;
    onlyIfSourceExists?: boolean;
  },
  { transaction }: { transaction?: SequelizeTransaction } = {},
): Promise<{ member: Member | null; createdMember: Member | null; removedMember: Member | null }> => {
  const fromKey = {
    CollectiveId,
    role: roles.BACKER,
    MemberCollectiveId: from.MemberCollectiveId,
    TierId: from.TierId || null,
  };
  const toKey = {
    CollectiveId,
    role: roles.BACKER,
    MemberCollectiveId: to.MemberCollectiveId,
    TierId: to.TierId || null,
  };
  const result = { member: null, createdMember: null, removedMember: null };
  if (fromKey.MemberCollectiveId === toKey.MemberCollectiveId && fromKey.TierId === toKey.TierId) {
    result.member = await models.Member.findOne({ where: fromKey, transaction });
    return result;
  }

  // Sequential queries: they can run on a single SQL transaction connection
  const source = await models.Member.findOne({ where: fromKey, transaction });
  if (!source && onlyIfSourceExists) {
    return result;
  }

  const target = await models.Member.findOne({ where: toKey, transaction });
  const otherOrdersOnSource = await models.Order.count({
    transaction,
    where: {
      id: { [Op.notIn]: movedOrderIds },
      FromCollectiveId: fromKey.MemberCollectiveId,
      CollectiveId,
      TierId: fromKey.TierId,
      status: [OrderStatuses.ACTIVE, OrderStatuses.PAID],
    },
  });

  const keepSource = otherOrdersOnSource > 0;
  if (!target && source && !keepSource) {
    result.member = await source.update(
      { MemberCollectiveId: toKey.MemberCollectiveId, TierId: toKey.TierId },
      { transaction },
    );
    return result;
  }

  if (target) {
    result.member = target;
  } else {
    result.member = result.createdMember = await models.Member.create(
      { ...toKey, CreatedByUserId, since: source?.since ?? new Date() },
      { transaction },
    );
  }

  if (source && !keepSource) {
    await source.destroy({ transaction });
    result.removedMember = source;
  }

  return result;
};

/**
 * Moves the contributor's BACKER membership of `order.collective` from `fromTierId` to `toTierId`.
 * See `moveBackerMembership`.
 */
export const syncBackerMembershipTier = async (
  order: Order,
  fromTierId: number | null,
  toTierId: number | null,
  { transaction }: { transaction?: SequelizeTransaction } = {},
): Promise<void> => {
  if ((fromTierId || null) === (toTierId || null)) {
    return;
  }

  await moveBackerMembership(
    {
      CollectiveId: order.CollectiveId,
      from: { MemberCollectiveId: order.FromCollectiveId, TierId: fromTierId },
      to: { MemberCollectiveId: order.FromCollectiveId, TierId: toTierId },
      movedOrderIds: [order.id],
      CreatedByUserId: order.CreatedByUserId,
    },
    { transaction },
  );
};

/**
 * Records a change of amount or tier on a recurring contribution. Not dispatched as a notification: this is an
 * audit trail, visible in the activity log.
 */
export const createOrderUpdatedActivity = async (
  order: Order,
  {
    user,
    UserTokenId,
    changes,
  }: {
    user?: User | null;
    UserTokenId?: number | null;
    changes: Record<string, unknown>;
  },
  { transaction }: { transaction?: SequelizeTransaction } = {},
): Promise<void> => {
  const collective = order.collective || (await order.getCollective({ transaction }));
  await models.Activity.create(
    {
      type: ActivityTypes.ORDER_UPDATED,
      UserId: user?.id ?? null,
      UserTokenId: UserTokenId ?? null,
      FromCollectiveId: order.FromCollectiveId,
      CollectiveId: order.CollectiveId,
      HostCollectiveId: collective?.HostCollectiveId ?? null,
      OrderId: order.id,
      data: {
        notify: false,
        order: order.info,
        ...changes,
      },
    },
    { transaction },
  );
};

/**
 * To call after any successful charge of a recurring contribution: applies `order.data.pendingTierChange`
 * if the charge paid for the pending tier. The order instance is updated in place.
 *
 * Never throws: a failure here must not break the payment flow (the change stays pending for the next charge).
 */
export const applyPendingTierChangeAfterCharge = async (
  order: Order,
  chargeTransaction: Transaction | null | undefined | void,
): Promise<boolean> => {
  const pendingTierChange = order.data?.pendingTierChange;
  if (!pendingTierChange || !chargeTransaction) {
    return false;
  }

  try {
    const tier = await models.Tier.findByPk(pendingTierChange.TierId);
    if (!tier || tier.CollectiveId !== order.CollectiveId) {
      // Tier deleted or order moved to another collective: the pending change can't be applied anymore
      await order.update({ data: omit(order.data, ['pendingTierChange']) });
      await createOrderUpdatedActivity(order, {
        changes: { pendingTierChange: { ...pendingTierChange, status: 'DISCARDED', reason: 'TIER_UNAVAILABLE' } },
      });
      return false;
    }

    const credit = await findChargeContributionCredit(order, chargeTransaction as Transaction);
    const paid = getPaidAmountFromContributionCredit(order, credit);
    if (!paid || !doesAmountSatisfyTier(tier, order, paid.amount)) {
      // Can happen if the provider charged a different amount (e.g. PayPal plan out of sync with the order)
      logger.warn(`Order #${order.id}: charge does not pay for pending tier #${tier.id}, keeping it pending`);
      reportMessageToSentry('Charge does not pay for pending tier change', {
        extra: { orderId: order.id, tierId: tier.id, paid, chargeTransactionId: (chargeTransaction as Transaction).id },
      });
      return false;
    }

    const previousTierId = order.TierId || null;
    await sequelize.transaction(async transaction => {
      await order.update({ TierId: tier.id, data: omit(order.data, ['pendingTierChange']) }, { transaction });
      await syncBackerMembershipTier(order, previousTierId, tier.id, { transaction });
      await createOrderUpdatedActivity(
        order,
        {
          changes: {
            previousTierId,
            TierId: tier.id,
            pendingTierChange: { ...pendingTierChange, status: 'APPLIED', paidAmount: paid.amount },
            paidByTransactionId: paid.transactionId,
          },
        },
        { transaction },
      );
    });

    order.Tier = tier;
    order.tier = tier;
    return true;
  } catch (e) {
    logger.error(`Order #${order.id}: failed to apply pending tier change: ${e.message}`);
    reportErrorToSentry(e, { extra: { orderId: order.id, pendingTierChange } });
    return false;
  }
};
