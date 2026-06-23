import {
  BelongsToGetAssociationMixin,
  CreationOptional,
  ForeignKey,
  HasManyGetAssociationsMixin,
  InferAttributes,
  InferCreationAttributes,
} from 'sequelize';

import PaymentIntentStatus from '../constants/payment-intent-status';
import PaymentIntentType from '../constants/payment-intent-type';
import { EntityShortIdPrefix } from '../lib/permalink/entity-map';
import sequelize, { DataTypes } from '../lib/sequelize';

import Collective from './Collective';
import Expense from './Expense';
import { ModelWithPublicId } from './ModelWithPublicId';
import Order from './Order';
import Transaction from './Transaction';
import User from './User';

class PaymentIntent extends ModelWithPublicId<
  EntityShortIdPrefix.PaymentIntent,
  InferAttributes<PaymentIntent>,
  InferCreationAttributes<PaymentIntent>
> {
  public static readonly nanoIdPrefix = EntityShortIdPrefix.PaymentIntent;
  public static readonly tableName = 'PaymentIntents' as const;

  declare id: CreationOptional<number>;
  declare primaryTransactionGroup: CreationOptional<string | null>;
  declare status: PaymentIntentStatus;
  declare type: PaymentIntentType;
  declare PayerCollectiveId: ForeignKey<Collective['id']> | null;
  declare PayeeCollectiveId: ForeignKey<Collective['id']> | null;
  declare HostCollectiveId: ForeignKey<Collective['id']> | null;
  declare InitiatedByCollectiveId: ForeignKey<Collective['id']> | null;
  declare CreatedByUserId: ForeignKey<User['id']> | null;
  declare description: CreationOptional<string | null>;
  declare paidAt: CreationOptional<Date | null>;
  declare OrderId: ForeignKey<Order['id']> | null;
  declare ExpenseId: ForeignKey<Expense['id']> | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare deletedAt: CreationOptional<Date | null>;

  declare payerCollective?: Collective;
  declare payeeCollective?: Collective;
  declare hostCollective?: Collective;
  declare initiatedByCollective?: Collective;
  declare createdByUser?: User;
  declare order?: Order;
  declare expense?: Expense;
  declare transactions?: Transaction[];

  declare getPayerCollective: BelongsToGetAssociationMixin<Collective>;
  declare getPayeeCollective: BelongsToGetAssociationMixin<Collective>;
  declare getHostCollective: BelongsToGetAssociationMixin<Collective>;
  declare getInitiatedByCollective: BelongsToGetAssociationMixin<Collective>;
  declare getCreatedByUser: BelongsToGetAssociationMixin<User>;
  declare getOrder: BelongsToGetAssociationMixin<Order>;
  declare getExpense: BelongsToGetAssociationMixin<Expense>;
  declare getTransactions: HasManyGetAssociationsMixin<Transaction>;
}

PaymentIntent.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    publicId: {
      type: DataTypes.STRING,
      unique: true,
      allowNull: false,
      defaultValue: sequelize.literal(`oc_nanoid('pi')`),
    },
    primaryTransactionGroup: {
      type: DataTypes.UUID,
      allowNull: true,
    },
    status: {
      type: DataTypes.ENUM(...Object.values(PaymentIntentStatus)),
      allowNull: false,
    },
    type: {
      type: DataTypes.ENUM(...Object.values(PaymentIntentType)),
      allowNull: false,
    },
    PayerCollectiveId: {
      type: DataTypes.INTEGER,
      references: { key: 'id', model: 'Collectives' },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
      allowNull: true,
    },
    PayeeCollectiveId: {
      type: DataTypes.INTEGER,
      references: { key: 'id', model: 'Collectives' },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
      allowNull: true,
    },
    HostCollectiveId: {
      type: DataTypes.INTEGER,
      references: { key: 'id', model: 'Collectives' },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
      allowNull: true,
    },
    InitiatedByCollectiveId: {
      type: DataTypes.INTEGER,
      references: { key: 'id', model: 'Collectives' },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
      allowNull: true,
    },
    CreatedByUserId: {
      type: DataTypes.INTEGER,
      references: { key: 'id', model: 'Users' },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
      allowNull: true,
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    paidAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    OrderId: {
      type: DataTypes.INTEGER,
      references: { key: 'id', model: 'Orders' },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
      allowNull: true,
    },
    ExpenseId: {
      type: DataTypes.INTEGER,
      references: { key: 'id', model: 'Expenses' },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
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
    tableName: 'PaymentIntents',
    paranoid: true,
  },
);

export default PaymentIntent;
