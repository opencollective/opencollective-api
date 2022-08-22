'use strict';

module.exports = {
  up: async queryInterface => {
    await queryInterface.sequelize.query(`
      UPDATE "PaymentMethods"
      SET
        "expiryDate" = DATE_TRUNC('month', "expiryDate" + interval '1 month') - interval '1 second'
      WHERE "type" = 'creditcard'
        AND "expiryDate" IS NOT NULL;
  `);
  },

  down: async () => {
    return;
  },
};
