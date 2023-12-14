import { uniq } from 'lodash';
import type {
  BelongsToGetAssociationMixin,
  ForeignKey,
  HasManyGetAssociationsMixin,
  InferAttributes,
  InferCreationAttributes,
  NonAttribute,
} from 'sequelize';

import ActivityTypes from '../constants/activities';
import ExpenseTypes from '../constants/expense_type';
import sequelize, { DataTypes, Model } from '../lib/sequelize';

import Collective from './Collective';
import User from './User';
import models, { Expense } from '.';

type AccountingCategoryCreationAttributes = InferCreationAttributes<
  AccountingCategory,
  { omit: 'id' | 'createdAt' | 'updatedAt' }
>;

type AccountingCategoryEditActivityData = {
  added?: Array<Partial<AccountingCategory>>;
  removed?: Array<Partial<AccountingCategory>>;
  edited?: Array<{ previousData: Partial<AccountingCategory>; newData: Partial<AccountingCategory> }>;
};

class AccountingCategory extends Model<InferAttributes<AccountingCategory>, AccountingCategoryCreationAttributes> {
  declare id: number;
  declare CollectiveId: ForeignKey<Collective['id']>;
  declare code: string;
  declare name: string;
  declare friendlyName?: string;
  declare expensesTypes?: Array<ExpenseTypes | `${ExpenseTypes}`>;
  declare createdAt: Date;
  declare updatedAt: Date;

  // Associations
  declare getCollective: BelongsToGetAssociationMixin<Collective>;
  declare getExpenses: HasManyGetAssociationsMixin<Expense>;

  declare collective?: Collective;
  declare expenses?: Expense[];

  // Static methods
  public static async createEditActivity(
    collective: Collective,
    user: User,
    data: AccountingCategoryEditActivityData,
  ): Promise<void> {
    await models.Activity.create({
      type: ActivityTypes.ACCOUNTING_CATEGORIES_EDITED,
      UserId: user.id,
      CollectiveId: collective.id,
      HostCollectiveId: collective.HostCollectiveId,
      data,
    });
  }

  // Getters
  get publicInfo(): NonAttribute<Partial<AccountingCategory>> {
    return {
      id: this.id,
      code: this.code,
      name: this.name,
      friendlyName: this.friendlyName,
      CollectiveId: this.CollectiveId,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      expensesTypes: this.expensesTypes,
    };
  }
}

AccountingCategory.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    code: {
      type: DataTypes.STRING,
      allowNull: false,
      validate: {
        len: [1, 255],
      },
      set(value: string): void {
        this.setDataValue('code', value?.trim());
      },
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
      validate: {
        len: [0, 255],
      },
      set(value: string): void {
        this.setDataValue('name', value?.trim());
      },
    },
    friendlyName: {
      type: DataTypes.STRING,
      allowNull: true,
      validate: {
        len: [0, 255],
      },
      set(value: string): void {
        this.setDataValue('friendlyName', value?.trim());
      },
    },
    expensesTypes: {
      type: DataTypes.ENUM(...Object.keys(ExpenseTypes)),
      allowNull: true,
      set(values: Array<ExpenseTypes | `${ExpenseTypes}`>): void {
        this.setDataValue('expensesTypes', values ? uniq(values).sort() : null);
      },
    },
    CollectiveId: {
      type: DataTypes.INTEGER,
      references: { key: 'id', model: 'Collectives' },
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
    },
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    updatedAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
  },
  {
    sequelize,
    tableName: 'AccountingCategories',
    paranoid: false, // No soft-delete for this one
  },
);

export default AccountingCategory;
