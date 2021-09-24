'use strict';

module.exports = {
  up: async queryInterface => {
    // Initial definition of isFeesOnTop
    // from 2020-05-28 to 2020-09-22
    await queryInterface.sequelize.query(`
      UPDATE "Orders"
      SET data = jsonb_set(data, '{platformTipEligible}', 'true')
      WHERE "id" <= 93864
      AND (data->>'isFeesOnTop')::boolean IS TRUE
    `);
    await queryInterface.sequelize.query(`
      UPDATE "Orders"
      SET data = jsonb_set(data, '{hasPlatformTip}', 'true')
      WHERE "id" <= 93864
      AND (data->>'platformFee')::numeric > 0;
    `);

    // Since May 1st
    // All collectives but OSC and OC, unless activated
  },

  down: async () => {
    // No coming back
  },
};
