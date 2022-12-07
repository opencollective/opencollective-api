import DataLoader from 'dataloader';

import { sequelize } from '../../models';

export const generatePaymentMethodNeedsConfirmationLoader = (): DataLoader<number, boolean> => {
  return new DataLoader(async (paymentMethodIds: number[]) => {
    const results = await sequelize.query(
      `
      SELECT "PaymentMethodId", COUNT(*) AS "count"
      FROM "Orders"
      WHERE "PaymentMethodId" IN (:paymentMethodIds)
      AND "status" IN ('REQUIRE_CLIENT_CONFIRMATION', 'ERROR', 'PENDING')
      AND "deletedAt" IS NULL
      AND "data" -> 'needsConfirmation' = 'true'
      GROUP BY "PaymentMethodId"
    `,
      {
        replacements: { paymentMethodIds },
        type: sequelize.QueryTypes.SELECT,
        mapToModel: false,
      },
    );

    const groupedCounts: { [PaymentMethodId: number]: number } = {};
    results.forEach(item => (groupedCounts[item.PaymentMethodId] = item.count));
    return paymentMethodIds.map(id => Boolean(groupedCounts[id]));
  });
};
