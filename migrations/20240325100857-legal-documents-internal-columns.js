'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('LegalDocuments', 'service', {
      type: Sequelize.ENUM('DROPBOX_FORMS', 'OPENCOLLECTIVE'),
      allowNull: false,
      defaultValue: 'DROPBOX_FORMS',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('LegalDocuments', 'service');
  },
};
