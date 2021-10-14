'use strict';

module.exports = {
  up: async queryInterface => {
    await queryInterface.sequelize.query(`
      UPDATE "Orders"
      SET data = jsonb_set("data", '{thegivingblock}', jsonb_build_object('pledgeAmount', data -> 'customData' ->> 'pledgeAmount', 'pledgeCurrency', data -> 'customData' ->> 'pledgeCurrency'), TRUE)
        #- '{customData, pledgeAmount}'
        #- '{customData, pledgeCurrency}'
      WHERE "data" -> 'customData' ->> 'pledgeAmount' IS NOT NULL
        AND "data" -> 'customData' ->> 'pledgeCurrency' IS NOT NULL;
    `);
  },

  down: async queryInterface => {
    await queryInterface.sequelize.query(`
      UPDATE "Orders" SET data = jsonb_set(data, '{customData}', '{}', true)
      WHERE data->>'customData' IS NULL;
    `);

    await queryInterface.sequelize.query(`
      UPDATE "Orders" SET data = jsonb_set(data, '{customData, pledgeAmount}', to_jsonb((data->>'thegivingblock')::json->>'pledgeAmount'), true)
      WHERE (data->>'thegivingblock')::json->>'pledgeAmount' IS NOT NULL
        AND (data->>'thegivingblock')::json->>'pledgeCurrency' IS NOT NULL;
    `);

    await queryInterface.sequelize.query(`
      UPDATE "Orders" SET data = jsonb_set(data, '{customData, pledgeCurrency}', to_jsonb((data->>'thegivingblock')::json->>'pledgeCurrency'), true)
      WHERE (data->>'thegivingblock')::json->>'pledgeAmount' IS NOT NULL
        AND (data->>'thegivingblock')::json->>'pledgeCurrency' IS NOT NULL;
    `);

    await queryInterface.sequelize.query(`
      UPDATE "Orders" SET data = jsonb(data - 'thegivingblock');
    `);
  },
};
