import { QueryTypes } from 'sequelize';

import { BookedTransaction, getDescriptionForTransaction } from '../../server/lib/gocardless/sync';

export const regenerateRowsDescriptionsForGocardlessInstitution = async (
  queryInterface,
  institutionIdsInput: string | string[],
) => {
  const institutionIds = Array.isArray(institutionIdsInput) ? institutionIdsInput : [institutionIdsInput];
  const rows = (await queryInterface.sequelize.query(
    `
        SELECT tr.id, tr."rawValue", ti.data->'gocardless'->'institution'->>'id' AS "institutionId"
        FROM "TransactionsImportsRows" tr
        INNER JOIN "TransactionsImports" ti ON tr."TransactionsImportId" = ti.id
        WHERE ti.type = 'GOCARDLESS'
        AND ti.data->'gocardless'->'institution'->>'id' IN (:institutionIds)
        AND tr."rawValue" IS NOT NULL
        AND tr."deletedAt" IS NULL
      `,
    {
      type: QueryTypes.SELECT,
      replacements: { institutionIds },
    },
  )) as Array<{ id: number; rawValue: BookedTransaction; institutionId: string }>;

  for (const row of rows) {
    await queryInterface.sequelize.query(
      `UPDATE "TransactionsImportsRows" SET "description" = :description, "updatedAt" = NOW() WHERE id = :id`,
      {
        replacements: {
          id: row.id,
          description: getDescriptionForTransaction(row.rawValue, row.institutionId),
        },
      },
    );
  }
};
