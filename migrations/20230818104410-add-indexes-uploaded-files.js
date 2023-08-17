'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  up: async queryInterface => {
    await queryInterface.addIndex('UploadedFiles', ['CreatedByUserId'], { concurrently: true });
  },

  down: async queryInterface => {
    await queryInterface.removeIndex('UploadedFiles', ['CreatedByUserId']);
  },
};
