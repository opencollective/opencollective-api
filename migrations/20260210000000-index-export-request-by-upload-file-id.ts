'use strict';

import { Op, type QueryInterface } from 'sequelize';

module.exports = {
  async up(queryInterface: QueryInterface) {
    await queryInterface.addIndex('ExportRequests', ['UploadedFileId'], {
      unique: true,
      where: { UploadedFileId: { [Op.ne]: null }, deletedAt: { [Op.ne]: null } },
    });
  },

  async down() {},
};
