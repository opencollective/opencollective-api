'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(
      `
      UPDATE "Orders"
      SET status = 'PAUSED'
      WHERE data ->> 'paypalStatusChangeNote' = :contributionPausedMsg
      AND "deletedAt" IS NULL
      AND status = 'CANCELLED'
    `,
      {
        replacements: {
          contributionPausedMsg: `Your contribution to the Collective was paused. We'll inform you when it will be ready for re-activation.`,
        },
      },
    );
  },

  async down() {},
};
