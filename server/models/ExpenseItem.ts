import { pick } from 'lodash';
import type { CreationOptional, ForeignKey, InferAttributes, InferCreationAttributes } from 'sequelize';
import { DataTypes, Model, Transaction } from 'sequelize';

import { diffDBEntries } from '../lib/data';
import { isValidUploadedImage } from '../lib/images';
import { buildSanitizerOptions, sanitizeHTML } from '../lib/sanitize-html';
import sequelize from '../lib/sequelize';

import User from './User';
import models from '.';

// Expense items diff as [newEntries, removedEntries, updatedEntries]
type ExpenseItemsDiff = [Record<string, unknown>[], ExpenseItem[], Record<string, unknown>[]];

/**
 * Sequelize model to represent an ExpenseItem, linked to the `ExpenseItems` table.
 */
export class ExpenseItem extends Model<InferAttributes<ExpenseItem>, InferCreationAttributes<ExpenseItem>> {
  public declare readonly id: CreationOptional<number>;
  public declare ExpenseId: number;
  public declare CreatedByUserId: ForeignKey<User['id']>;
  public declare amount: number;
  public declare url: string;
  public declare createdAt: CreationOptional<Date>;
  public declare updatedAt: CreationOptional<Date>;
  public declare deletedAt: CreationOptional<Date>;
  public declare incurredAt: Date;
  public declare description: CreationOptional<string>;

  private static editableFields = ['amount', 'url', 'description', 'incurredAt'];

  /**
   * Based on `diffDBEntries`, diff two items list to know which ones where
   * added, removed or added.
   * @returns [newEntries, removedEntries, updatedEntries]
   */
  static diffDBEntries = (baseItems: ExpenseItem[], itemsData: Record<string, unknown>[]): ExpenseItemsDiff => {
    return diffDBEntries(baseItems, itemsData, ExpenseItem.editableFields);
  };

  /**
   * Create an expense item from user-submitted data.
   * @param itemData: The (potentially unsafe) user data. Fields will be whitelisted.
   * @param user: User creating this item
   * @param expense: The linked expense
   */
  static async createFromData(
    itemData: Record<string, unknown>,
    user: User,
    expense: typeof models.Expense,
    dbTransaction: Transaction | null,
  ): Promise<ExpenseItem> {
    const cleanData = ExpenseItem.cleanData(itemData);
    return ExpenseItem.create(
      { ...cleanData, ExpenseId: expense.id, CreatedByUserId: user.id },
      { transaction: dbTransaction },
    );
  }

  /**
   * Updates an expense item from user-submitted data.
   * @param itemData: The (potentially unsafe) user data. Fields will be whitelisted.
   */
  static async updateFromData(itemData: Record<string, unknown>, dbTransaction: Transaction | null): Promise<void> {
    const id = itemData['id'];
    const cleanData = ExpenseItem.cleanData(itemData);
    await ExpenseItem.update(cleanData, { where: { id }, transaction: dbTransaction });
  }

  /** Filters out all the fields that cannot be edited by user */
  private static cleanData(data: Record<string, unknown>): Record<string, unknown> {
    return pick(data, ExpenseItem.editableFields);
  }
}

const descriptionSanitizerOptions = buildSanitizerOptions({
  titles: true,
  basicTextFormatting: true,
  multilineTextFormatting: true,
  images: true,
  links: true,
});

// Link the model to database fields
ExpenseItem.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    amount: {
      type: DataTypes.INTEGER,
      allowNull: false,
      validate: {
        min: 1,
      },
    },
    url: {
      type: DataTypes.STRING,
      allowNull: true,
      set(value: string | null): void {
        // Make sure empty strings are converted to null
        this.setDataValue('url', value || null);
      },
      validate: {
        isUrl: true,
        isValidImage(url: string): void {
          if (url && !isValidUploadedImage(url)) {
            throw new Error('The attached file URL is not valid');
          }
        },
      },
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true,
      set(value: string | null) {
        if (value) {
          this.setDataValue('description', sanitizeHTML(value, descriptionSanitizerOptions));
        } else {
          this.setDataValue('description', null);
        }
      },
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
    deletedAt: {
      type: DataTypes.DATE,
    },
    incurredAt: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
      allowNull: false,
    },
    ExpenseId: {
      type: DataTypes.INTEGER,
      references: { model: 'Expenses', key: 'id' },
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
      allowNull: false,
    },
    CreatedByUserId: {
      type: DataTypes.INTEGER,
      references: { key: 'id', model: 'Users' },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
      allowNull: false,
    },
  },
  {
    sequelize,
    paranoid: true,
    tableName: 'ExpenseItems',
  },
);

export default ExpenseItem;
