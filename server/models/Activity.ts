import { CreationOptional, ForeignKey, InferAttributes, InferCreationAttributes } from 'sequelize';

import ActivityTypes from '../constants/activities';
import dispatch from '../lib/notifications';
import sequelize, { DataTypes, Model } from '../lib/sequelize';

import Expense from './Expense';

export class Activity extends Model<InferAttributes<Activity>, InferCreationAttributes<Activity>> {
  public declare readonly id: CreationOptional<number>;
  public declare type: ActivityTypes;
  public declare data: CreationOptional<Record<string, any> & { notify?: boolean }>;
  public declare CollectiveId: CreationOptional<number>;
  public declare FromCollectiveId: CreationOptional<number>;
  public declare HostCollectiveId: CreationOptional<number>;
  public declare UserId: CreationOptional<number>;
  public declare UserTokenId: CreationOptional<number>;
  public declare TransactionId: CreationOptional<number>;
  public declare ExpenseId: ForeignKey<Expense['id']>;
  public declare OrderId: CreationOptional<number>;
  public declare createdAt: CreationOptional<Date>;
}

Activity.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },

    type: {
      type: DataTypes.STRING,
      get() {
        const value = this.getDataValue('type');
        if (value === 'order.thankyou') {
          return 'order.confirmed';
        }
      },
    },

    data: DataTypes.JSONB,

    CollectiveId: {
      type: DataTypes.INTEGER,
      references: {
        model: 'Collectives',
        key: 'id',
      },
    },

    FromCollectiveId: {
      type: DataTypes.INTEGER,
      references: {
        model: 'Collectives',
        key: 'id',
      },
    },

    HostCollectiveId: {
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

    UserTokenId: {
      type: DataTypes.INTEGER,
      references: {
        model: 'UserTokens',
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

    OrderId: {
      type: DataTypes.INTEGER,
      references: {
        model: 'Orders',
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
          dispatch(activity); // intentionally no return statement, needs to be async
        }
        return Promise.resolve();
      },
    },
  },
);

// ignore unused exports default

export default Activity;
