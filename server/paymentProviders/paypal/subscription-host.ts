/**
 * Helpers to find the host that owns a PayPal subscription on PayPal.
 *
 * A PayPal subscription is created with the credentials of the host of the collective at the time of the
 * contribution, and it is charged on that host's PayPal account. The collective's current host is therefore not
 * always the right one: collectives can be archived (no host anymore) or move to another host. The host of the
 * first charge is not always right either: collectives migrated in bulk (e.g. from OCF to OCE Foundation) keep
 * being charged under the new host. The most reliable source is the host of the most recent charge.
 */

import { TransactionKind } from '../../constants/transaction-kind';
import { TransactionTypes } from '../../constants/transactions';
import sequelize, { Op, QueryTypes } from '../../lib/sequelize';
import models, { Collective } from '../../models';
import Order from '../../models/Order';

/**
 * SQL expression returning the ID of the host that owns the PayPal subscription of an order: the host of its most
 * recent `CONTRIBUTION`/`CREDIT` transaction, otherwise the collective's current host.
 */
const getPaypalHostIdSqlExpression = (orderAlias = '"Orders"', collectiveAlias = '"collective"'): string => `
  COALESCE(
    (
      SELECT t."HostCollectiveId"
      FROM "Transactions" t
      WHERE t."OrderId" = ${orderAlias}.id
      AND t."kind" = 'CONTRIBUTION'
      AND t."type" = 'CREDIT'
      AND t."HostCollectiveId" IS NOT NULL
      AND t."deletedAt" IS NULL
      ORDER BY t."createdAt" DESC, t.id DESC
      LIMIT 1
    ),
    ${collectiveAlias}."HostCollectiveId"
  )
`;

/**
 * Returns the host that owns the PayPal subscription of this order on PayPal. See the file header.
 */
export const getPaypalHostForOrder = async (
  order: Order,
  { hostsCache }: { hostsCache?: Record<number, Collective> } = {},
): Promise<Collective | null> => {
  const lastChargeTransaction = await models.Transaction.findOne({
    attributes: ['HostCollectiveId'],
    where: {
      OrderId: order.id,
      kind: TransactionKind.CONTRIBUTION,
      type: TransactionTypes.CREDIT,
      HostCollectiveId: { [Op.ne]: null },
    },
    order: [
      ['createdAt', 'DESC'],
      ['id', 'DESC'],
    ],
  });

  if (!lastChargeTransaction) {
    // No charge yet (e.g. the order hasn't been processed): the current host of the collective is the right one
    const collective = order.collective || (await order.getCollective());
    return collective?.getHostCollective({ returnEvenIfNotApproved: true }) ?? null;
  }

  const hostId = lastChargeTransaction.HostCollectiveId;
  if (hostsCache) {
    if (!hostsCache[hostId]) {
      hostsCache[hostId] = await models.Collective.findByPk(hostId);
    }
    return hostsCache[hostId];
  }

  return models.Collective.findByPk(hostId);
};

/**
 * Returns the IDs of the orders (any status) with an active PayPal subscription owned by this host on PayPal.
 */
export const findOrderIdsWithActivePaypalSubscriptionForHost = async (
  hostId: number,
  { orderIds = undefined }: { orderIds?: number[] } = {},
): Promise<number[]> => {
  const rows = await sequelize.query<{ id: number }>(
    `
    SELECT "Orders".id
    FROM "Orders"
    INNER JOIN "Subscriptions" ON "Subscriptions".id = "Orders"."SubscriptionId"
    INNER JOIN "Collectives" "collective" ON "collective".id = "Orders"."CollectiveId"
    WHERE "Orders"."deletedAt" IS NULL
    AND "Subscriptions"."deletedAt" IS NULL
    AND "Subscriptions"."isActive" IS TRUE
    AND "Subscriptions"."paypalSubscriptionId" IS NOT NULL
    AND ${getPaypalHostIdSqlExpression()} = :hostId
    ${orderIds ? 'AND "Orders".id IN (:orderIds)' : ''}
    ORDER BY "Orders".id ASC
  `,
    {
      type: QueryTypes.SELECT,
      replacements: { hostId, orderIds: orderIds?.length ? orderIds : [0] },
    },
  );

  return rows.map(row => row.id);
};
