const Temporal = require('sequelize-temporal');
var roles = require('../constants/roles').organization;

module.exports = function(Sequelize, DataTypes) {

  var UserOrganization = Sequelize.define('UserOrganization', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },

    role: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: roles.ADMIN,
      validate: {
        isIn: {
          args: [[roles.ADMIN, roles.MEMBER]],
          msg: 'Must be host, member or backer'
        }
      }
    },

    UserId: {
      type: DataTypes.INTEGER,
      references: 'Users',
      referencesKey: 'id',
      primaryKey: true,
      allowNull: false,
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE'
    },

    OrganizationId: {
      type: DataTypes.INTEGER,
      references: 'Organizations',
      referencesKey: 'id',
      primaryKey: true,
      allowNull: false
    },

    createdAt: {
      type: DataTypes.DATE,
      defaultValue: Sequelize.NOW
    },
    updatedAt: {
      type: DataTypes.DATE,
      defaultValue: Sequelize.NOW
    },
    deletedAt: {
      type: DataTypes.DATE
    }
  }, {
    paranoid: true,

    getterMethods: {
      // Info.
      info: function() {
        return {
          role: this.role,
          organizationId: this.organizationId,
          userId: this.UserId,
          createdAt: this.createdAt,
          updatedAt: this.updatedAt,
          deletedAt: this.deletedAt
        };
      }
    }
  });

  return Temporal(UserOrganization, Sequelize);
};
