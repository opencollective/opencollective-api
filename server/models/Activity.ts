import {
  CreationOptional,
  ForeignKey,
  InferAttributes,
  InferCreationAttributes,
  NonAttribute,
  Transaction,
} from 'sequelize';

import ActivityTypes from '../constants/activities';
import dispatch from '../lib/notifications';
import { trackActivityDispatch, waitAllActivityDispatches } from '../lib/notifications/activity-dispatch-tracker';
import { EntityShortIdPrefix } from '../lib/permalink/entity-map';
import sequelize, { DataTypes } from '../lib/sequelize';

import Collective from './Collective';
import Expense from './Expense';
import { ModelWithPublicId } from './ModelWithPublicId';

class Activity extends ModelWithPublicId<
  EntityShortIdPrefix.Activity,
  InferAttributes<Activity>,
  InferCreationAttributes<Activity>
> {
  public static readonly nanoIdPrefix = EntityShortIdPrefix.Activity;
  public static readonly tableName = 'Activities' as const;

  declare public readonly id: CreationOptional<number>;
  declare public type: ActivityTypes;
  declare public data: CreationOptional<Record<string, any> & { notify?: boolean }>;
  declare public CollectiveId: CreationOptional<number>;
  declare public Collective?: NonAttribute<Collective>;
  declare public FromCollectiveId: CreationOptional<number>;
  declare public HostCollectiveId: CreationOptional<number>;
  declare public UserId: CreationOptional<number>;
  declare public UserTokenId: CreationOptional<number>;
  declare public TransactionId: CreationOptional<number>;
  declare public ExpenseId: ForeignKey<Expense['id']>;
  declare public OrderId: CreationOptional<number>;
  declare public createdAt: CreationOptional<Date>;

  public static waitAllDispatch = waitAllActivityDispatches;
}

const scheduleActivityDispatch = (
  activity: Activity,
  { transaction, onlyAwaitEmails = true }: { transaction?: Transaction; onlyAwaitEmails?: boolean } = {},
) => {
  const runDispatch = () => dispatch(activity, { onlyAwaitEmails });

  if (transaction) {
    transaction.afterCommit(() => {
      trackActivityDispatch(runDispatch());
    });
  } else {
    const dispatchPromise = runDispatch();
    trackActivityDispatch(dispatchPromise);
    return dispatchPromise;
  }
};

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
      async afterCreate(activity, options) {
        if (activity.data?.notify !== false) {
          scheduleActivityDispatch(activity, { transaction: options.transaction });
        }
      },
    },
  },
);

export default Activity;
