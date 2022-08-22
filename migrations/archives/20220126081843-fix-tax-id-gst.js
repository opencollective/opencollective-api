'use strict';

module.exports = {
  up: async queryInterface => {
    return queryInterface.sequelize.query(`
      UPDATE "Transactions"
      SET "data" = JSONB_SET("data", '{tax,id}', '"GST"')
      WHERE "data" -> 'tax' ->> 'taxerCountry' = 'NZ'
      AND "data" -> 'tax' ->> 'id' = 'VAT'
    `);
  },

  down: async () => {
    /**
     * No going back
     */
  },
};
