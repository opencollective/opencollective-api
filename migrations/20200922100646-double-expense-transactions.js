'use strict';

const destroyDuplicatesQuery = `
  UPDATE "Transactions" t
  SET
    "deletedAt" = NOW(),
    data = (
      CASE WHEN t.data IS NULL
      THEN '{"isDuplicateExpenseTransaction": true}'::jsonb
      ELSE t.data::jsonb || '{"isDuplicateExpenseTransaction": true}'::jsonb
    END)
  WHERE t.id IN (
    SELECT
      max(id)
    FROM
      "Transactions"
    WHERE
      "ExpenseId" IS NOT NULL
      AND "type" = :transactionType
      AND "PaymentMethodId" IS NULL
      AND "RefundTransactionId" IS NULL
      AND "deletedAt" IS NULL
    GROUP BY
      "ExpenseId"
    HAVING
      COUNT(id) = 2
  )
`;

module.exports = {
  up: async queryInterface => {
    await queryInterface.sequelize.query(destroyDuplicatesQuery, { replacements: { transactionType: 'CREDIT' } });
    await queryInterface.sequelize.query(destroyDuplicatesQuery, { replacements: { transactionType: 'DEBIT' } });
  },

  down: async queryInterface => {
    await queryInterface.sequelize.query(`
      UPDATE "Transactions"
      SET "deletedAt" = NULL
      WHERE ("data" ->> 'isDuplicateExpenseTransaction')::boolean = TRUE
    `);
  },
};
