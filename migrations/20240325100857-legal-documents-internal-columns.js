'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('LegalDocuments', 'service', {
      type: Sequelize.ENUM('DROPBOX_FORMS', 'OPENCOLLECTIVE'),
      allowNull: false,
      defaultValue: 'DROPBOX_FORMS',
    });

    await queryInterface.addColumn('LegalDocuments', 'encryptedFormData', {
      type: Sequelize.TEXT,
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeColumn('LegalDocuments', 'service');
    await queryInterface.removeColumn('LegalDocuments', 'encryptedFormData');
  },
};
