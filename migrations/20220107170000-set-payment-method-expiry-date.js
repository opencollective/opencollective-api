'use strict';

module.exports = {
  up: async queryInterface => {
    await queryInterface.sequelize.query(`
      UPDATE "PaymentMethods"
      SET
        "expiryDate" = DATE (concat_ws('-',LPAD("data"->>'expYear', 4, '20'), LPAD("data"->>'expMonth', 2, '0'), '01'))
      WHERE "type" = 'creditcard'
        AND "expiryDate" IS NULL
        AND "data"->>'expYear' IS NOT NULL AND ("data"->>'expMonth')::Integer > 0;
  `);
  },

  down: async () => {
    return;
  },
};
