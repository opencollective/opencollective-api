'use strict';

module.exports = {
  up: function (queryInterface, Sequelize) {
    return queryInterface.createTable('UserOrganizations', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true
      },

      role: Sequelize.ENUM('ADMIN', 'MEMBER'),

      UserId: {
        type: Sequelize.INTEGER,
        references: 'Users',
        referencesKey: 'id',
        primaryKey: true,
        allowNull: false,
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE'
      },

      OrganizationId: {
        type: Sequelize.INTEGER,
        references: 'Organizations',
        referencesKey: 'id',
        primaryKey: true,
        allowNull: false
      },

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
    })
    /*
     * Sequelize by default creates a constraint in manyTomany relationships.
     * We need manually remove this constraint and add a new one that supports multiple user roles per organization
     */
    .then(() => queryInterface.sequelize.query('ALTER TABLE "UserOrganizations" DROP CONSTRAINT "UserOrganizations_pkey";'))
    .then(() => queryInterface.removeIndex('UserOrganizations', 'UserOrganizations_pkey'))
    .then(() => {
      return queryInterface.addIndex('UserOrganizations', ['OrganizationId', 'UserId', 'role'], {
        indexName: 'UserOrganizations_3way',
        indicesType: 'UNIQUE'
      });
    });
  },

  down: function (queryInterface) {
    return queryInterface.dropTable('UserOrganizations');
  }
};
