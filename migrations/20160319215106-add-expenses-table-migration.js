'use strict';

module.exports = {
  up: function (queryInterface, Sequelize) {
    return queryInterface.createTable(
      'Expenses', {
        id: {
          type: Sequelize.INTEGER,
          primaryKey: true,
          autoIncrement: true
        },

        UserId: {
          type: Sequelize.INTEGER,
          references: 'Users',
          referencesKey: 'id',
          onDelete: 'SET NULL',
          onUpdate: 'CASCADE'
        },

        CollectiveId: {
          type: Sequelize.INTEGER,
          references: 'Groups',
          referencesKey: 'id',
          onDelete: 'SET NULL',
          onUpdate: 'CASCADE'
        },

        currency: {
          type: Sequelize.STRING,
          defaultValue: 'USD',
          set: function(val) {
            if (val && val.toUpperCase) {
              this.setDataValue('currency', val.toUpperCase());
            }
          }
        },

        amount: Sequelize.INTEGER,
        title: Sequelize.STRING,
        description: Sequelize.TEXT('long'),
        attachment: Sequelize.STRING,
        category: Sequelize.STRING,
        vat: Sequelize.INTEGER,

        LastEditedById: {
          type: Sequelize.INTEGER,
          references: 'Users',
          referencesKey: 'id',
          onDelete: 'SET NULL',
          onUpdate: 'CASCADE'
        },

        status: Sequelize.STRING,

        createdAt: {
          type: Sequelize.DATE,
          defaultValue: Sequelize.NOW
        },

        updatedAt: {
          type: Sequelize.DATE,
          defaultValue: Sequelize.NOW
        },

        deletedAt: {
          type: Sequelize.DATE
        }
      }, {
        paranoid: true
      });
  },

  down: function (queryInterface) {
    return queryInterface.dropTable('Expenses');
  }
};
