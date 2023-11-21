'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    console.log('Remove pledges (orders)');
    await queryInterface.sequelize.query(`
      UPDATE "Orders"
      SET
        "deletedAt" = COALESCE("deletedAt", NOW()),
        "status" = 'EXPIRED',
        "data" = jsonb_set("data", '{isPledge}', 'true')
      WHERE "status" = 'PLEDGED'
    `);

    console.log('Remove pledged collectives');
    await queryInterface.sequelize.query(`
      UPDATE "Collectives"
      SET
        "deletedAt" = COALESCE("deletedAt", NOW()),
        "slug" = CONCAT("slug", '-deleted-pledge')
      WHERE "isPledged" = TRUE
      AND "isActive" IS FALSE
    `);

    console.log('Remove pledge columns');
    await queryInterface.removeColumn('Collectives', 'isPledged');
  },

  async down(queryInterface, Sequelize) {
    console.log('Add pledge columns');
    await queryInterface.addColumn('Collectives', 'isPledged', {
      type: Sequelize.BOOLEAN,
      defaultValue: false,
    });

    console.log(
      'This migration will not restore deleted pledges & pledged collectives, please do that by hand by looking at the `deletedAt` columns',
    );
  },
};
