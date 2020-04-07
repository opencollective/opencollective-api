import { Model, Transaction } from 'sequelize';
import restoreSequelizeAttributesOnClass from '../lib/restore-sequelize-attributes-on-class';
import { diffDBEntries } from '../lib/data';
import { isValidOCImage } from '../lib/images';

/**
 * Sequelize model to represent an ExpenseAttachedFile, linked to the `ExpenseAttachedFiles` table.
 */
export class ExpenseAttachedFile extends Model<ExpenseAttachedFile> {
  public readonly id!: number;
  public ExpenseId!: number;
  public CreatedByUserId: number;
  public url!: string;
  public createdAt!: Date;

  constructor(...args) {
    super(...args);
    restoreSequelizeAttributesOnClass(new.target, this);
  }

  /**
   * Create an attachment from user-submitted data.
   * @param attachmentData: The (potentially unsafe) user data. Fields will be whitelisted.
   * @param user: User creating this attachment
   * @param expense: The linked expense
   */
  static async createFromData(
    url: string,
    user,
    expense,
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
  static diffDBEntries = (baseAttachments, attachmentsData): [object[], ExpenseAttachedFile[], object[]] => {
    return diffDBEntries(baseAttachments, attachmentsData, ['url']);
  };
}

export default (sequelize, DataTypes): typeof ExpenseAttachedFile => {
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
          isUrl: true,
          isValidImage(url: string): void {
            if (url && !isValidOCImage(url)) {
              throw new Error('The attached file URL is not valid');
            }
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

  return ExpenseAttachedFile;
};
