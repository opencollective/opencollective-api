import type {
  BelongsToGetAssociationMixin,
  CreationOptional,
  ForeignKey,
  InferAttributes,
  InferCreationAttributes,
} from 'sequelize';

import { SupportedCurrency } from '../constants/currencies';
import sequelize, { DataTypes, Model } from '../lib/sequelize';

import Collective from './Collective';
import CustomDataTypes from './DataTypes';
import Expense from './Expense';
import Order from './Order';
import TransactionsImport from './TransactionsImport';

class TransactionsImportRow extends Model<
  InferAttributes<TransactionsImportRow>,
  InferCreationAttributes<TransactionsImportRow>
> {
  public declare id: CreationOptional<number>;
  public declare CollectiveId: ForeignKey<Collective['id']>;
  public declare TransactionsImportId: ForeignKey<TransactionsImport['id']>;
  public declare ExpenseId: ForeignKey<Expense['id']>;
  public declare OrderId: ForeignKey<Order['id']>;
  public declare sourceId: string;
  public declare isDismissed: boolean;
  public declare description: string;
  public declare date: Date;
  public declare amount: number;
  public declare isUnique: boolean;
  public declare currency: SupportedCurrency;
  public declare rawValue: Record<string, string>;
  public declare createdAt: Date;
  public declare updatedAt: Date;
  public declare deletedAt: Date | null;

  public declare import?: TransactionsImport;
  public declare getImport: BelongsToGetAssociationMixin<TransactionsImport>;

  public isProcessed(): boolean {
    return Boolean(this.OrderId || this.ExpenseId || this.isDismissed);
  }
}

TransactionsImportRow.init(
  {
    id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      autoIncrement: true,
      primaryKey: true,
    },
    TransactionsImportId: {
      type: DataTypes.INTEGER,
      references: { key: 'id', model: 'TransactionsImports' },
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
      allowNull: false,
    },
    ExpenseId: {
      type: DataTypes.INTEGER,
      references: { key: 'id', model: 'Expenses' },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
      allowNull: true,
    },
    OrderId: {
      type: DataTypes.INTEGER,
      references: { key: 'id', model: 'Orders' },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
      allowNull: true,
    },
    sourceId: {
      type: DataTypes.STRING,
      allowNull: true,
      validate: {
        notEmpty: true,
      },
    },
    isDismissed: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    description: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: '',
    },
    date: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    amount: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    currency: CustomDataTypes(DataTypes).currency,
    isUnique: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    rawValue: {
      type: DataTypes.JSONB,
      allowNull: true,
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
    deletedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  },
  {
    sequelize,
    tableName: 'TransactionsImportsRows',
    paranoid: true, // For soft-deletion
    timestamps: true,
  },
);

export default TransactionsImportRow;
