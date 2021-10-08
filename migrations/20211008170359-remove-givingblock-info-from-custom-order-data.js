'use strict';

module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query(`
      UPDATE "Orders" SET data = jsonb_set(data, '{thegivingblock}', jsonb_build_object('pledgeAmount', (data->>'customData')::json->>'pledgeAmount', 'pledgeCurrency', (data->>'customData')::json->>'pledgeCurrency'), true);

      UPDATE "Orders" SET data = jsonb(data - 'customData');
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`
      UPDATE "Orders" SET data = jsonb_set(data, '{customData}', jsonb_build_object('pledgeAmount', (data->>'thegivingblock')::json->>'pledgeAmount', 'pledgeCurrency', (data->>'thegivingblock')::json->>'pledgeCurrency'), true);

      UPDATE "Orders" SET data = jsonb(data - 'thegivingblock');
    `);
  }
};
