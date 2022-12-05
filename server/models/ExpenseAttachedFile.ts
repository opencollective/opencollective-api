import config from 'config';
import { DataTypes, ForeignKey, Model, Transaction } from 'sequelize';

import { diffDBEntries } from '../lib/data';
import { isValidUploadedImage } from '../lib/images';
import sequelize from '../lib/sequelize';

import User from './User';
import models from '.';

/**
 * Sequelize model to represent an ExpenseAttachedFile, linked to the `ExpenseAttachedFiles` table.
 */
export class ExpenseAttachedFile extends Model {
  public declare readonly id: number;
  public declare ExpenseId: number;
  public declare CreatedByUserId: ForeignKey<User['id']>;
  public declare url: string;
  public declare name: string;
  public declare createdAt: Date;

  /**
   * Create an attachment from user-submitted data.
   * @param attachmentData: The (potentially unsafe) user data. Fields will be whitelisted.
   * @param user: User creating this attachment
   * @param expense: The linked expense
   */
  static async createFromData(
    { url, name }: { url: string; name?: string },
    user: User,
    expense: typeof models.Expense,
    dbTransaction: Transaction | null,
  ): Promise<ExpenseAttachedFile> {
    return ExpenseAttachedFile.create(
      { ExpenseId: expense.id, CreatedByUserId: user.id, url, name },
      { transaction: dbTransaction },
    );
  }

  /**
   * Based on `diffDBEntries`, diff two attached files list to know which ones where
   * added, removed or added.
   * @returns [newEntries, removedEntries, updatedEntries]
   */
  static diffDBEntries = (
    baseAttachments: ExpenseAttachedFile[],
    attachmentsData: Record<string, unknown>[],
  ): [Record<string, unknown>[], ExpenseAttachedFile[], Record<string, unknown>[]] => {
    return diffDBEntries(baseAttachments, attachmentsData, ['url']);
  };
}

// Link the model to database fields
ExpenseAttachedFile.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
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
    url: {
      type: DataTypes.STRING,
      allowNull: false,
      validate: {
        isValid(url: string): void {
          if (url && !isValidUploadedImage(url) && !url.startsWith(config.host.rest)) {
            throw new Error('The attached file URL is not valid');
          }
        },
      },
    },
    name: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    createdAt: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
      allowNull: false,
    },
  },
  {
    sequelize,
    tableName: 'ExpenseAttachedFiles',
  },
);

export default ExpenseAttachedFile;
