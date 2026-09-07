import DataLoader from 'dataloader';
import { QueryTypes } from 'sequelize';

import { sequelize } from '../../models';

export const generateTierAvailableQuantityLoader = () => {
  return new DataLoader(tierIds =>
    sequelize
      .query<{ id: number; availableQuantity: number }>(
        `
      SELECT t.id, (t."maxQuantity" - (
        SELECT COALESCE(SUM(o.quantity), 0)
        FROM "Orders" o
        WHERE o."TierId" = t.id
        AND o."deletedAt" IS NULL
        AND (
          o."status" IN ('PAID', 'ACTIVE', 'DISPUTED', 'IN_REVIEW')
          OR (o."status" IN ('NEW', 'REQUIRE_CLIENT_CONFIRMATION', 'PROCESSING') AND o."updatedAt" > NOW() - INTERVAL '12 hour') -- Allow 12 hours to complete a payment
        )
        AND (
          -- Occupied if there are no contribution credits yet (async payment intents)
          -- or if at least one contribution credit is not refunded.
          -- Count each order once so recurring charges do not consume extra quantity.
          -- See https://github.com/opencollective/opencollective/issues/8875
          NOT EXISTS (
            SELECT 1
            FROM "Transactions" trx
            WHERE trx."OrderId" = o.id
              AND trx."kind" = 'CONTRIBUTION'
              AND trx."type" = 'CREDIT'
              AND trx."deletedAt" IS NULL
          )
          OR EXISTS (
            SELECT 1
            FROM "Transactions" trx
            WHERE trx."OrderId" = o.id
              AND trx."kind" = 'CONTRIBUTION'
              AND trx."type" = 'CREDIT'
              AND trx."deletedAt" IS NULL
              AND trx."RefundTransactionId" IS NULL
          )
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
          type: QueryTypes.SELECT,
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
