import sequelize, { DataTypes } from '../lib/sequelize';

function defineModel() {
  const Session = sequelize.define(
    'Session',
    {
      sid: {
        type: DataTypes.STRING(32),
        primaryKey: true,
      },

      expires: {
        type: DataTypes.DATE,
      },

      data: {
        type: DataTypes.TEXT,
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
    },
    {
      paranoid: true,
    },
  );

  return Session;
}

// We're using the defineModel method to keep the indentation and have a clearer git history.
// Please consider this if you plan to refactor.
const Session = defineModel();

export default Session;
