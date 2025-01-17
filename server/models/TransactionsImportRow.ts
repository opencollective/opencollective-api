import type {
  BelongsToGetAssociationMixin,
  CreationOptional,
  ForeignKey,
  InferAttributes,
  InferCreationAttributes,
} from 'sequelize';

import { SupportedCurrency } from '../constants/currencies';
import { TransactionsImportRowStatus } from '../graphql/v2/enum/TransactionsImportRowStatus';
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
  declare public id: CreationOptional<number>;
  declare public CollectiveId: ForeignKey<Collective['id']>;
  declare public TransactionsImportId: ForeignKey<TransactionsImport['id']>;
  declare public ExpenseId: ForeignKey<Expense['id']>;
  declare public OrderId: ForeignKey<Order['id']>;
  declare public sourceId: string;
  declare public status: TransactionsImportRowStatus | `${TransactionsImportRowStatus}`;
  declare public description: string;
  declare public date: Date;
  declare public amount: number;
  declare public isUnique: boolean;
  declare public currency: SupportedCurrency;
  declare public rawValue: Record<string, string>;
  declare public createdAt: Date;
  declare public updatedAt: Date;
  declare public deletedAt: Date | null;

  declare public import?: TransactionsImport;
  declare public getImport: BelongsToGetAssociationMixin<TransactionsImport>;

  public isProcessed(): boolean {
    return this.status === 'LINKED' || this.status === 'IGNORED';
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
    status: {
      type: DataTypes.ENUM(...Object.values(TransactionsImportRowStatus)),
      defaultValue: 'PENDING',
      allowNull: false,
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
