import notify from '../lib/notifications';
import sequelize, { DataTypes } from '../lib/sequelize';

function defineModel() {
  const Activity = sequelize.define(
    'Activity',
    {
      type: DataTypes.STRING,

      data: DataTypes.JSONB,

      CollectiveId: {
        type: DataTypes.INTEGER,
        references: {
          model: 'Collectives',
          key: 'id',
        },
      },

      UserId: {
        type: DataTypes.INTEGER,
        references: {
          model: 'Users',
          key: 'id',
        },
      },

      TransactionId: {
        type: DataTypes.INTEGER,
        references: {
          model: 'Transactions',
          key: 'id',
        },
      },

      ExpenseId: {
        type: DataTypes.INTEGER,
        references: {
          model: 'Expenses',
          key: 'id',
        },
      },

      createdAt: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW,
      },
    },
    {
      updatedAt: false,

      hooks: {
        afterCreate(activity) {
          if (activity.data?.notify !== false) {
            notify(activity); // intentionally no return statement, needs to be async
          }
          return Promise.resolve();
        },
      },
    },
  );

  return Activity;
}

// We're using the defineModel function to keep the indentation and have a clearer git history.
// Please consider this if you plan to refactor.
const Activity = defineModel();

export default Activity;
