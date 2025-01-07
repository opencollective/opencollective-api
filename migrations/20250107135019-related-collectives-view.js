'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP MATERIALIZED VIEW IF EXISTS "RelatedCollectives";
      CREATE MATERIALIZED VIEW "RelatedCollectives" AS
      -- Collectives that have Orders submitted by the same User
      SELECT
        ARRAY_AGG(DISTINCT (o."FromCollectiveId")) AS "CollectiveIds",
        ARRAY_AGG(DISTINCT (u.id)) AS "UserIds",
        CAST(NULL AS integer[]) AS "PaymentMethodIds",
        CAST(NULL AS integer[]) AS "PayoutMethodIds"
      FROM
        "Orders" o
        INNER JOIN "PaymentMethods" pm ON o."PaymentMethodId" = pm.id
        INNER JOIN "Users" u ON u.id = o."CreatedByUserId"
        INNER JOIN "Collectives" c ON u."CollectiveId" = c.id
        INNER JOIN "Collectives" fc ON fc.id = o."FromCollectiveId"
      WHERE o."deletedAt" IS NULL
        AND pm.service != 'opencollective'
      GROUP BY
        o."CreatedByUserId", c.id, u.id
      HAVING COUNT(DISTINCT (o."FromCollectiveId")) > 1
      UNION ALL
      -- Collectives that share same Payment Method by Fingerprint
      SELECT DISTINCT
        ARRAY_AGG(DISTINCT (c.id)) AS "CollectiveIds",
        ARRAY_AGG(DISTINCT (pm."CreatedByUserId")) AS "UserIds",
        ARRAY_AGG(DISTINCT (pm.id)) AS "PaymentMethodIds",
        CAST(NULL AS integer[]) AS "PayoutMethodIds"
      FROM
        "PaymentMethods" pm
        INNER JOIN "Collectives" c ON pm."CollectiveId" = c.id
      WHERE pm."data" ->> 'fingerprint' IS NOT NULL
      GROUP BY
          pm."data" ->> 'fingerprint'
      HAVING COUNT(DISTINCT (c.id)) > 1
      UNION ALL
      -- Collectives that share same Payout Method by Details
      (
        WITH
          pms AS (
            SELECT
              id,
              "CollectiveId",
              "CreatedByUserId",
              ARRAY_TO_STRING(
              ARRAY_REMOVE(
              ARRAY [data #>> '{details,abartn}', data #>> '{details,accountNumber}', data #>> '{details,bankCode}',
                  data #>> '{details,BIC}', data #>> '{details,billerCode}', data #>> '{details,branchCode}',
                  data #>> '{details,bsbCode}', data #>> '{details,cardNumber}', data #>> '{details,cardToken}',
                  data #>> '{details,customerReferenceNumber}', data #>> '{details,IBAN}',
                  data #>> '{details,idDocumentNumber}', data #>> '{details,idDocumentType}',
                  data #>> '{details,identificationNumber}', data #>> '{details,ifscCode}',
                  data #>> '{details,institutionNumber}', data #>> '{details,interacAccount}',
                  data #>> '{details,phoneNumber}', data #>> '{details,sortCode}', data #>> '{details,swiftCode}',
                  data #>> '{details,transitNumber}'], NULL), '') AS fingerprintvalues
            FROM "PayoutMethods"
            )
        SELECT
          ARRAY_AGG(DISTINCT ("CollectiveId")) AS "CollectiveIds",
          ARRAY_AGG(DISTINCT (pms."CreatedByUserId")) AS "UserIds",
          CAST(NULL AS integer[]) AS "PaymentMethodIds",
          ARRAY_AGG(DISTINCT (pms.id)) AS "PayoutMethodIds"
        FROM
          pms
          LEFT JOIN "Collectives" c ON "CollectiveId" = c.id
        WHERE fingerprintvalues != ''
        GROUP BY
          fingerprintvalues
        HAVING COUNT(DISTINCT ("CollectiveId")) > 1
        ORDER BY
          COUNT(DISTINCT ("CollectiveId")) DESC
        )
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP MATERIALIZED VIEW IF EXISTS "RelatedCollectives";
    `);
  },
};
