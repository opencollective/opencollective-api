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
        WHERE "data"->>'isFeesOnTop' = 'true';
      `,
    );
  },

  down: async () => {
    return;
  },
};
