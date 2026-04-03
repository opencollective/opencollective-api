import { CreationOptional, ForeignKey, InferAttributes, InferCreationAttributes, Model, NonAttribute } from 'sequelize';

import ExpenseActionType from '../constants/expense-action-type';
import sequelize, { DataTypes } from '../lib/sequelize';

import Expense from './Expense';
import User from './User';

/**
 * Sequelize model to represent an ExpenseAction, linked to the `ExpenseActions` table.
 *
 * Records individual actions (e.g. approvals) taken on an expense by a user,
 * allowing multiple actions of the same type to be tracked over time.
 *
 * Rows are never hard-deleted; use paranoid soft-delete instead.
 */
class ExpenseAction extends Model<InferAttributes<ExpenseAction>, InferCreationAttributes<ExpenseAction>> {
  public static readonly tableName = 'ExpenseActions' as const;

  declare public readonly id: CreationOptional<number>;
  declare public ExpenseId: ForeignKey<Expense['id']>;
  declare public UserId: ForeignKey<User['id']>;
  declare public action: ExpenseActionType;
  declare public createdAt: CreationOptional<Date>;
  declare public deletedAt: CreationOptional<Date>;

  declare public expense?: NonAttribute<Expense>;
  declare public user?: NonAttribute<User>;
}

ExpenseAction.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
      allowNull: false,
    },
    ExpenseId: {
      type: DataTypes.INTEGER,
      references: { model: 'Expenses', key: 'id' },
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
      allowNull: false,
    },
    UserId: {
      type: DataTypes.INTEGER,
      references: { model: 'Users', key: 'id' },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
      allowNull: true,
    },
    action: {
      type: DataTypes.ENUM(...Object.values(ExpenseActionType)),
      allowNull: false,
    },
    createdAt: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
      allowNull: false,
    },
    deletedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  },
  {
    sequelize,
    tableName: 'ExpenseActions',
    paranoid: true,
    updatedAt: false,
  },
);

export default ExpenseAction;
