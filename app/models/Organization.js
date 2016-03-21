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
    paranoid: true
  });

  return Temporal(Organization,Sequelize);
}