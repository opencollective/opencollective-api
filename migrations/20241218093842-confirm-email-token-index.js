'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addIndex('Users', ['emailConfirmationToken'], {
      unique: true,
      where: {
        deletedAt: { [Sequelize.Op.eq]: null },
        emailConfirmationToken: { [Sequelize.Op.ne]: null },
      },
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('Users', ['emailConfirmationToken']);
  },
};
