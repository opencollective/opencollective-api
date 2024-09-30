'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE "Orders"
      SET "data" = JSONB_SET("data", '{pausedBy}', '"HOST"')
      WHERE status = 'PAUSED'
      AND (data ->> 'isOCFShutdown')::boolean = TRUE
      AND data ->> 'pausedBy' != 'HOST'
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE "Orders"
      SET "data" = JSONB_SET("data", '{pausedBy}', '"PLATFORM"')
      WHERE status = 'PAUSED'
      AND (data ->> 'isOCFShutdown')::boolean = TRUE
      AND data ->> 'pausedBy' = 'HOST'
    `);
  },
};
