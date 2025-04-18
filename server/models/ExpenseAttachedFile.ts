import config from 'config';
import { DataTypes, ForeignKey, Model, NonAttribute, Transaction } from 'sequelize';

import { diffDBEntries } from '../lib/data';
import { isValidUploadedImage } from '../lib/images';
import sequelize from '../lib/sequelize';
import { isValidRESTServiceURL, isValidURL } from '../lib/url-utils';

import Expense from './Expense';
import { MAX_UPLOADED_FILE_URL_LENGTH } from './UploadedFile';
import User from './User';

/**
 * Sequelize model to represent an ExpenseAttachedFile, linked to the `ExpenseAttachedFiles` table.
 */
class ExpenseAttachedFile extends Model {
  declare public readonly id: number;
  declare public ExpenseId: ForeignKey<Expense['id']>;
  declare public CreatedByUserId: ForeignKey<User['id']>;
  declare public url: string;
  declare public createdAt: Date;

  declare public Expense?: NonAttribute<Expense>;

  /**
   * Create an attachment from user-submitted data.
   * @param attachmentData: The (potentially unsafe) user data. Fields will be whitelisted.
   * @param user: User creating this attachment
   * @param expense: The linked expense
   */
  static async createFromData(
    { url }: { url: string },
    user: User,
    expense: Expense,
    dbTransaction: Transaction | null,
  ): Promise<ExpenseAttachedFile> {
    return ExpenseAttachedFile.create(
      { ExpenseId: expense.id, CreatedByUserId: user.id, url },
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
        notNull: true,
        notEmpty: true,
        isValidURL(url: string): void {
          if (!url) {
            return;
          }

          if (!isValidURL(url)) {
            throw new Error('File URL is not a valid URL');
          }
        },
        isValid(url: string): void {
          if (url && !isValidUploadedImage(url) && !isValidRESTServiceURL(config.host.rest)) {
            throw new Error('The attached file URL is not valid');
          }
        },
        len: {
          args: [0, MAX_UPLOADED_FILE_URL_LENGTH],
          msg: 'The expense item file URL is too long',
        },
      },
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
