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
import ExpenseTypes from '../constants/expense-type';
import { TransactionKind } from '../constants/transaction-kind';
import { buildSanitizerOptions, sanitizeHTML } from '../lib/sanitize-html';
import sequelize, { DataTypes, Model } from '../lib/sequelize';

import Activity from './Activity';
import Collective from './Collective';
import Expense from './Expense';
import { OrderModelInterface } from './Order';
import User from './User';

const instructionsSanitizeOptions = buildSanitizerOptions({
  basicTextFormatting: true,
  multilineTextFormatting: true,
  links: true,
});

type AccountingCategoryCreationAttributes = InferCreationAttributes<
  AccountingCategory,
  { omit: 'id' | 'createdAt' | 'updatedAt' }
>;

type AccountingCategoryEditActivityData = {
  added?: Array<Partial<AccountingCategory>>;
  removed?: Array<Partial<AccountingCategory>>;
  edited?: Array<{ previousData: Partial<AccountingCategory>; newData: Partial<AccountingCategory> }>;
};

/** Accounting category kind is a subset of transaction kinds */
export const AccountingCategoryKindList: readonly (TransactionKind | `${TransactionKind}`)[] = [
  TransactionKind.ADDED_FUNDS,
  TransactionKind.CONTRIBUTION,
  TransactionKind.EXPENSE,
] as const;

export type AccountingCategoryKind = (typeof AccountingCategoryKindList)[number];

class ExpenseTypesEnum extends DataTypes.ABSTRACT {
  key = `"enum_Expenses_type"`;
}

class AccountingCategory extends Model<InferAttributes<AccountingCategory>, AccountingCategoryCreationAttributes> {
  declare id: number;
  declare CollectiveId: ForeignKey<Collective['id']>;
  declare code: string;
  declare name: string;
  declare friendlyName?: string;
  declare kind?: AccountingCategoryKind;
  declare hostOnly: boolean;
  declare instructions?: string;
  declare expensesTypes?: Array<ExpenseTypes | `${ExpenseTypes}`>;
  declare createdAt: Date;
  declare updatedAt: Date;

  // Associations
  declare getCollective: BelongsToGetAssociationMixin<Collective>;
  declare getExpenses: HasManyGetAssociationsMixin<Expense>;
  declare getOrders: HasManyGetAssociationsMixin<OrderModelInterface>;

  declare collective?: Collective;
  declare expenses?: Expense[];
  declare orders?: OrderModelInterface[];

  // Static methods
  public static async createEditActivity(
    collective: Collective,
    user: User,
    data: AccountingCategoryEditActivityData,
  ): Promise<void> {
    await Activity.create({
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
      hostOnly: this.hostOnly,
      kind: this.kind,
      instructions: this.instructions,
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
    hostOnly: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    instructions: {
      type: DataTypes.TEXT,
      allowNull: true,
      validate: {
        len: [0, 50000], // just to prevent people from putting a lot of text in there
      },
      set(instructions: string) {
        if (instructions) {
          this.setDataValue('instructions', sanitizeHTML(instructions, instructionsSanitizeOptions));
        } else {
          this.setDataValue('instructions', null);
        }
      },
    },
    kind: {
      type: DataTypes.ENUM(...Object.values(AccountingCategoryKindList)),
      allowNull: true,
    },
    expensesTypes: {
      type: DataTypes.ARRAY(new ExpenseTypesEnum()),
      allowNull: true,
      set(values: Array<ExpenseTypes | `${ExpenseTypes}`>): void {
        // Sequelize doesn't work with empty arrays ("cannot determine type of empty array"). We force `null` if it's empty
        this.setDataValue('expensesTypes', values?.length ? uniq(values).sort() : null);
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
