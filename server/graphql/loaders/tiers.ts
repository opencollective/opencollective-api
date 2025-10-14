import DataLoader from 'dataloader';

import { sequelize } from '../../models';

export const generateTierAvailableQuantityLoader = () => {
  return new DataLoader(tierIds =>
    sequelize
      .query(
        `
      SELECT t.id, (t."maxQuantity" - (
        SELECT COALESCE(SUM(o.quantity), 0)
        FROM "Orders" o
        LEFT JOIN "Transactions" trx ON trx."OrderId" = o.id AND trx."kind" = 'CONTRIBUTION' AND trx."type" = 'CREDIT' AND trx."deletedAt" IS NULL
        WHERE o."TierId" = t.id
        AND o."deletedAt" IS NULL
        AND (
          o."status" IN ('PAID', 'ACTIVE', 'DISPUTED', 'IN_REVIEW')
          OR (o."status" IN ('NEW', 'REQUIRE_CLIENT_CONFIRMATION', 'PROCESSING') AND o."updatedAt" > NOW() - INTERVAL '12 hour') -- Allow 12 hours to complete a payment
        )
        AND (
          trx.id IS NULL -- No transactions yet, important to consider for payment intents that are processed asynchronously
          OR trx."RefundTransactionId" IS NULL -- Not refunded
        )
      )) AS "availableQuantity"
      FROM "Tiers" t
      WHERE t.id IN (?)
      AND t."maxQuantity" IS NOT NULL
      AND t."deletedAt" IS NULL
      GROUP BY t.id
    `,
        {
          replacements: [tierIds],
          type: sequelize.QueryTypes.SELECT,
        },
      )
      .then(results => {
        return tierIds.map(tierId => {
          const result = results.find(({ id }) => id === tierId);
          if (result) {
            return result.availableQuantity > 0 ? result.availableQuantity : 0;
          } else {
            return null;
          }
        });
      }),
  );
};
