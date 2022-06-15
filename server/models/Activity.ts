import { CreationOptional, InferAttributes, InferCreationAttributes } from 'sequelize';

import ActivityTypes from '../constants/activities';
import notify from '../lib/notifications';
import sequelize, { DataTypes, Model } from '../lib/sequelize';

export class Activity extends Model<InferAttributes<Activity>, InferCreationAttributes<Activity>> {
  public declare readonly id: CreationOptional<number>;
  public declare type: ActivityTypes;
  public declare data: CreationOptional<Record<string, any> & { notify?: boolean }>;
  public declare CollectiveId: CreationOptional<number>;
  public declare UserId: CreationOptional<number>;
  public declare ApplicationId: CreationOptional<number>;
  public declare TransactionId: CreationOptional<number>;
  public declare ExpenseId: CreationOptional<number>;
  public declare createdAt: CreationOptional<Date>;
}

function setupModel() {
  Activity.init(
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
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

      ApplicationId: {
        type: DataTypes.INTEGER,
        references: {
          model: 'Applications',
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
      sequelize,
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
}

// We're using the setupModel function to keep the indentation and have a clearer git history.
// Please consider this if you plan to refactor.
setupModel();

export default Activity;
