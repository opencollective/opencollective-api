import { CreationOptional, ForeignKey, InferAttributes, InferCreationAttributes } from 'sequelize';

import ActivityTypes from '../constants/activities';
import dispatch from '../lib/notifications';
import sequelize, { DataTypes } from '../lib/sequelize';

import Expense from './Expense';
import { ModelWithPublicId } from './ModelWithPublicId';

class Activity extends ModelWithPublicId<InferAttributes<Activity>, InferCreationAttributes<Activity>> {
  public static readonly nanoIdPrefix = 'activity' as const;
  public static readonly tableName = 'Activities' as const;

  declare public readonly id: CreationOptional<number>;
  declare public readonly publicId: string;
  declare public type: ActivityTypes;
  declare public data: CreationOptional<Record<string, any> & { notify?: boolean }>;
  declare public CollectiveId: CreationOptional<number>;
  declare public FromCollectiveId: CreationOptional<number>;
  declare public HostCollectiveId: CreationOptional<number>;
  declare public UserId: CreationOptional<number>;
  declare public UserTokenId: CreationOptional<number>;
  declare public TransactionId: CreationOptional<number>;
  declare public ExpenseId: ForeignKey<Expense['id']>;
  declare public OrderId: CreationOptional<number>;
  declare public createdAt: CreationOptional<Date>;
}

Activity.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    publicId: {
      type: DataTypes.STRING,
      unique: true,
      allowNull: false,
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
      async afterCreate(activity) {
        if (activity.data?.notify !== false) {
          const dispatchPromise = dispatch(activity, { onlyAwaitEmails: true }); // intentionally no return statement, needs to be async by default
          if (activity.data?.awaitForDispatch) {
            await dispatchPromise;
          }
        }
      },
    },
  },
);

export default Activity;
