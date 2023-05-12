'use strict';

const CommentType = {
  COMMENT: 'COMMENT',
  PRIVATE_NOTE: 'PRIVATE_NOTE',
};

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('Comments', 'type', {
      type: Sequelize.ENUM(...Object.values(CommentType)),
      defaultValue: CommentType.COMMENT,
    });
    await queryInterface.addColumn('CommentHistories', 'type', {
      type: Sequelize.ENUM(...Object.values(CommentType)),
      defaultValue: CommentType.COMMENT,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('Comments', 'type');
    await queryInterface.removeColumn('CommentHistories', 'type');
  },
};
