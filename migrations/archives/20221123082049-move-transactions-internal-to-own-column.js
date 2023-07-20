'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('Transactions', 'isInternal', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });

    await queryInterface.sequelize.query(`
      UPDATE "Transactions"
      SET "isInternal" = TRUE
      WHERE "data" ->> 'internal' IS NOT NULL
      AND ("data" ->> 'internal')::boolean = TRUE
    `);
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('Transactions', 'isInternal');
  },
};
