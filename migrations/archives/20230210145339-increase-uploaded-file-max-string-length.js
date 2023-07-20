'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // S3 limits the file name to 1024 characters. We're adding some extra space for the domain
    // Currently https://opencollective-production.s3.us-west-1.amazonaws.com/ => 61 characters, but taking a bit of margin
    // in case we change the domain at some point
    await queryInterface.changeColumn('UploadedFiles', 'url', {
      type: Sequelize.STRING(1200),
      allowNull: false,
    });
  },

  async down() {
    console.log(
      'Not rolling back this migration because it would truncate the url column. Please do it manually if needed.',
    );
  },
};
