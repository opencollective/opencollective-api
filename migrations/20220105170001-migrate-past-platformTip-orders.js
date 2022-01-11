'use strict';

module.exports = {
  up: async queryInterface => {
    await queryInterface.sequelize.query(
      `
        UPDATE
          "Orders"
        SET
          "platformTipAmount" = ("data"->'platformFee')::int,
          "platformTipEligible" = true
        WHERE "data"->>'isFeesOnTop' = 'true' AND ("data"->'platformFee')::int > 0;
      `,
    );

    await queryInterface.sequelize.query(`
      UPDATE
        "Orders"
      SET
        "platformTipEligible" = (data->>'isFeesOnTop')::boolean
      WHERE
        "id" <= 93864 AND (data->>'isFeesOnTop') IS NOT NULL
      ;
    `);
  },

  down: async () => {
    return;
  },
};
