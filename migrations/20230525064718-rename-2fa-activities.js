'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE "Activities"
      SET "type" = 'user.new.two.factor.method'
      WHERE "type" = 'user.new.two.factor.code'
    `);

    await queryInterface.sequelize.query(`
      UPDATE "Activities"
      SET "type" = 'user.remove.two.factor.method'
      WHERE "type" = 'user.remove.two.factor.code'
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE "Activities"
      SET "type" = 'user.new.two.factor.code'
      WHERE "type" = 'user.new.two.factor.method'
    `);

    await queryInterface.sequelize.query(`
      UPDATE "Activities"
      SET "type" = 'user.remove.two.factor.code'
      WHERE "type" = 'user.remove.two.factor.method'
    `);
  },
};
