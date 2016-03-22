
/*
 * Donation model
 * - this represents a commitment by a user to pay amount to a collective over a time period
 * - Note that there will only be one entry per subscription
 */

module.exports = function(Sequelize, DataTypes) {

  var Donation = Sequelize.define('Donation', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },

    UserId: {
      type: DataTypes.INTEGER,
      references: 'Users',
      referencesKey: 'id',
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE'
    },

    CollectiveId: {
      type: DataTypes.INTEGER,
      references: 'Groups',
      referencesKey: 'id',
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE'
    },

    currency: {
      type: DataTypes.STRING,
      defaultValue: 'USD',
      set: function(val) {
        if (val && val.toUpperCase) {
          this.setDataValue('currency', val.toUpperCase());
        }
      }
    },

    amount: DataTypes.INTEGER,
    title: DataTypes.STRING,

    SubscriptionId: {
      type: DataTypes.INTEGER,
      references: 'Subscriptions',
      referencesKey: 'id',
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE'
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
      // Info
      info() {
        return {
          id: this.id,
          UserId: this.UserId,
          CollectiveId: this.CollectiveId,
          currency: this.currency,
          amount: this.amount,
          amountFloat: this.amount / 100,
          title: this.title,
          SubscriptionId: this.SubscriptionId,
          createdAt: this.createdAt
        }
      }
    }
  });

  return Donation;
}
