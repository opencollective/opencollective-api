'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    // Fix orders
    const affectedOrders = await queryInterface.sequelize.query(
      `
      WITH invalid_orders AS (
        SELECT
          id,
          ROUND(("totalAmount" - COALESCE("platformTipAmount", 0) / (1 + (data -> 'tax' ->> 'percentage')::numeric / 100))) AS gross_amount,
          ("totalAmount" - COALESCE("platformTipAmount", 0)) - ROUND(("totalAmount" - COALESCE("platformTipAmount", 0)) / (1 + (data -> 'tax' ->> 'percentage')::numeric / 100)) AS expected_tax_amount
        FROM "Orders"
        WHERE "taxAmount" IS NOT NULL
        AND data -> 'tax' ->> 'percentage' IS NOT NULL
        AND "totalAmount" != 0
        AND ("totalAmount" - COALESCE("platformTipAmount", 0)) - ROUND(("totalAmount" - COALESCE("platformTipAmount", 0)) / (1 + (data -> 'tax' ->> 'percentage')::numeric / 100))  != "taxAmount"
        ORDER BY "createdAt" DESC
      ) UPDATE "Orders" o
      SET
        "taxAmount" = invalid_orders.expected_tax_amount,
        "data" = jsonb_set(o.data, '{taxAmountBeforeMigration20230124101039}', to_jsonb(o."taxAmount"))
      FROM invalid_orders
      WHERE invalid_orders.id = o.id
      RETURNING o.*
    `,
      {
        type: queryInterface.sequelize.QueryTypes.SELECT,
      },
    );

    // Fix transactions
    for (const order of affectedOrders) {
      // There's no refunded transaction so we can look at the negative values only
      // We take some shortcuts on amount updates as there's no multi-currency case
      const transactions = await queryInterface.sequelize.query(
        `
        UPDATE "Transactions" t
        SET
          -- Update amount and amountInHostCurrency only for DEBIT
          "amount" = CASE WHEN "type" = 'DEBIT' THEN "amount" + :invalidTaxAmount - :newTaxAmount ELSE "amount" END,
          "amountInHostCurrency" = CASE WHEN "type" = 'DEBIT' THEN "amountInHostCurrency" + :invalidTaxAmount - :newTaxAmount ELSE "amountInHostCurrency" END,
          -- Update netAmountInCollectiveCurrency only for CREDIT
          "netAmountInCollectiveCurrency" = CASE WHEN "type" = 'CREDIT' THEN "netAmountInCollectiveCurrency" - :invalidTaxAmount + :newTaxAmount ELSE "netAmountInCollectiveCurrency" END,
          -- Update taxAmount and data for all
          "taxAmount" = :newTaxAmount,
          "data" = jsonb_set(t.data, '{fieldsBeforeMigration20230124101039}', jsonb_build_object('taxAmount', t."taxAmount", 'amount', t."amount", 'amountInHostCurrency', t."amountInHostCurrency", 'netAmountInCollectiveCurrency', t."netAmountInCollectiveCurrency"))
        WHERE "OrderId" = :orderId AND "taxAmount" = :invalidTaxAmount
        RETURNING *
        `,
        {
          type: queryInterface.sequelize.QueryTypes.SELECT,
          replacements: {
            orderId: order.id,
            invalidTaxAmount: -order.data.taxAmountBeforeMigration20230124101039,
            newTaxAmount: -order.taxAmount,
          },
        },
      );

      console.log(
        `Fixed ${transactions.length} transactions for order ${order.id} whose tax amount was updated from ${order.data.taxAmountBeforeMigration20230124101039} to ${order.taxAmount}`,
      );
    }
  },

  async down(queryInterface) {
    // Rollback orders
    const affectedOrders = await queryInterface.sequelize.query(
      `
      UPDATE "Orders" o
      SET
        "taxAmount" = (data -> 'taxAmountBeforeMigration20230124101039')::integer,
        "data" = o.data - 'taxAmountBeforeMigration20230124101039'
      WHERE data -> 'taxAmountBeforeMigration20230124101039' IS NOT NULL
      RETURNING o.*
    `,
      {
        type: queryInterface.sequelize.QueryTypes.SELECT,
      },
    );

    // Rollback transactions
    for (const order of affectedOrders) {
      const transactions = await queryInterface.sequelize.query(
        `
        UPDATE "Transactions" t
        SET
          "amount" = (data -> 'fieldsBeforeMigration20230124101039' ->> 'amount')::integer,
          "amountInHostCurrency" = (data -> 'fieldsBeforeMigration20230124101039' ->> 'amountInHostCurrency')::integer,
          "netAmountInCollectiveCurrency" = (data -> 'fieldsBeforeMigration20230124101039' ->> 'netAmountInCollectiveCurrency')::integer,
          "taxAmount" = (data -> 'fieldsBeforeMigration20230124101039' ->> 'taxAmount')::integer,
          "data" = t.data - 'fieldsBeforeMigration20230124101039'
        WHERE "OrderId" = :orderId
        AND "data" -> 'fieldsBeforeMigration20230124101039' IS NOT NULL
        RETURNING t.*
        `,
        { type: queryInterface.sequelize.QueryTypes.SELECT, replacements: { orderId: order.id } },
      );

      console.log(`Rolled back ${transactions.length} transactions for ${order.id}...`);
    }
  },
};
