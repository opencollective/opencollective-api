'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('AccountingCategories', 'appliesTo', {
      type: Sequelize.ENUM(['HOST', 'HOSTED_COLLECTIVES']),
      allowNull: false,
      defaultValue: 'HOSTED_COLLECTIVES',
    });

    await queryInterface.sequelize.query(`
      UPDATE "AccountingCategories"
      SET "appliesTo" = 'HOSTED_COLLECTIVES'
      WHERE "CollectiveId" IN (
        SELECT id FROM "Collectives" where type = 'ORGANIZATION'
      );
    `);

    await queryInterface.sequelize.query(`
      UPDATE "AccountingCategories"
      SET "appliesTo" = 'HOST'
      WHERE "CollectiveId" IN (
        SELECT id FROM "Collectives" where type = 'COLLECTIVE'
      );
    `);
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('AccountingCategories', 'appliesTo');
  },
};
