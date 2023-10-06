'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // S3 limits the file name to 1024 characters
    await queryInterface.changeColumn('UploadedFiles', 'fileName', {
      type: Sequelize.STRING(1024),
      allowNull: true,
    });
  },

  async down() {
    console.log(
      'Not rolling back this migration because it would truncate the fileName column. Please do it manually if needed.',
    );
  },
};
