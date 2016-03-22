const Temporal = require('sequelize-temporal');

module.exports = function(Sequelize, DataTypes) {

  var Organization  = Sequelize.define('Organization', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },

    name: DataTypes.STRING,

    isHost: {
      type: DataTypes.BOOLEAN,
      defaultValue: false
    },

    description: DataTypes.TEXT('long'),
    website: DataTypes.STRING,
    twitterHandle: DataTypes.STRING,

    createdAt: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW
    },

    updatedAt: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW
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
          id: this.id,
          name: this.name,
          isHost: this.isHost,
          description: this.description,
          website: this.website,
          twitterHandle: this.twitterHandle,
          createdAt: this.createdAt,
          updatedAt: this.updatedAt
        };
      }
    },

    instanceMethods: {
      hasUserWithRole: function(userId, roles, cb) {
        this
          .getUsers({
            where: {
              id: userId
            }
          })
          .then(function(users) {
            if (users.length === 0) {
              return cb(null, false);
            } else if (!_.contains(roles, users[0].UserOrganization.role)) {
              return cb(null, false);
            }

            cb(null, true);
          })
          .catch(cb);
      },

      addUserWithRole(user, role) {
        return Sequelize.models.UserOrganization.create({
          role,
          UserId: user.id,
          OrganizationId: this.id
        });
      }
    }
  });

  return Temporal(Organization,Sequelize);
}