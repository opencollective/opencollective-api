'use strict';

module.exports = {
  up: async queryInterface => {
    await queryInterface.sequelize.query(`
      UPDATE "PaymentMethods" as pm
      SET "name" = CONCAT(c."name", ' (Host)'), "type" = 'host'
      FROM "Collectives" AS c
      WHERE pm."service" = 'opencollective' AND pm."type" = 'collective'
      AND pm."CollectiveId" = c."id"
      AND c."type" IN ('ORGANIZATION', 'USER')
    `);
  },

  down: async () => {
    // No rollback
  },
};
