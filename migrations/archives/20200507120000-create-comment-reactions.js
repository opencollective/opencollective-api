'use strict';

module.exports = {
  up: async (queryInterface, DataTypes) => {
    await queryInterface.createTable('CommentReactions', {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      FromCollectiveId: {
        type: DataTypes.INTEGER,
        references: { key: 'id', model: 'Collectives' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
        allowNull: false,
      },
      UserId: {
        type: DataTypes.INTEGER,
        references: { key: 'id', model: 'Users' },
        onDelete: 'NO ACTION',
        onUpdate: 'CASCADE',
        allowNull: false,
      },
      CommentId: {
        type: DataTypes.INTEGER,
        references: { key: 'id', model: 'Comments' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
        allowNull: false,
      },
      emoji: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      createdAt: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW,
        allowNull: false,
      },
      updatedAt: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW,
        allowNull: false,
      },
    });

    await queryInterface.addIndex('CommentReactions', ['CommentId', 'FromCollectiveId', 'emoji'], {
      indexName: `CommentReactions_UserId_CommentId_emoji`,
      unique: true,
    });
  },

  down: async queryInterface => {
    await queryInterface.dropTable('CommentReactions');
  },
};
