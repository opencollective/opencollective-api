import {
  CreationOptional,
  DataTypes,
  ForeignKey,
  InferAttributes,
  InferCreationAttributes,
  Model,
  Transaction,
} from 'sequelize';

import { optsSanitizedSimplifiedWithImages, sanitizeHTML } from '../lib/sanitize-html';
import sequelize from '../lib/sequelize';
import { RecipientAccount } from '../types/transferwise';

import type { Collective } from '.';
import { Order } from '.';

/**
 * Enum for ManualPaymentProvider types
 */
export enum ManualPaymentProviderTypes {
  BANK_TRANSFER = 'BANK_TRANSFER',
  OTHER = 'OTHER',
}

/**
 * Sanitize instructions HTML to prevent XSS
 */
export const sanitizeManualPaymentProviderInstructions = (instructions: string): string =>
  sanitizeHTML(instructions, optsSanitizedSimplifiedWithImages);

/**
 * Sequelize model to represent a ManualPaymentProvider, linked to the `ManualPaymentProviders` table.
 * These are custom payment methods that hosts can define for contributors to use when making
 * manual payments (bank transfers, etc).
 */
class ManualPaymentProvider extends Model<
  InferAttributes<ManualPaymentProvider>,
  InferCreationAttributes<ManualPaymentProvider>
> {
  declare public readonly id: CreationOptional<number>;
  declare public CollectiveId: ForeignKey<Collective['id']>;
  declare public type: ManualPaymentProviderTypes;
  declare public name: string;
  declare public instructions: string;
  declare public icon: CreationOptional<string>;
  declare public data: CreationOptional<RecipientAccount | Record<string, unknown>>;
  declare public order: CreationOptional<number>;
  declare public archivedAt: CreationOptional<Date>;
  declare public createdAt: CreationOptional<Date>;
  declare public updatedAt: CreationOptional<Date>;
  declare public deletedAt: CreationOptional<Date>;

  // Associations
  declare public Collective?: Collective;

  /**
   * Check if this provider can be deleted (no orders reference it)
   */
  async canBeDeleted({ transaction }: { transaction: Transaction }): Promise<boolean> {
    const orderCount = await Order.count({
      where: { ManualPaymentProviderId: this.id },
      transaction,
    });

    return orderCount === 0;
  }

  /**
   * Archive this provider (set archivedAt)
   */
  async archive({ transaction }: { transaction: Transaction }): Promise<ManualPaymentProvider> {
    return this.update({ archivedAt: new Date() }, { transaction });
  }
}

// Link the model to database fields
ManualPaymentProvider.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    CollectiveId: {
      type: DataTypes.INTEGER,
      references: { model: 'Collectives', key: 'id' },
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
      allowNull: false,
    },
    type: {
      type: DataTypes.ENUM(...Object.values(ManualPaymentProviderTypes)),
      allowNull: false,
      validate: {
        isIn: {
          args: [Object.values(ManualPaymentProviderTypes)],
          msg: `Must be one of ${Object.values(ManualPaymentProviderTypes)}`,
        },
      },
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
      validate: {
        notEmpty: { msg: 'Name is required' },
      },
    },
    instructions: {
      type: DataTypes.TEXT,
      allowNull: false,
      validate: {
        notEmpty: { msg: 'Instructions are required' },
      },
      set(value: string) {
        this.setDataValue('instructions', sanitizeManualPaymentProviderInstructions(value));
      },
    },
    icon: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    data: {
      type: DataTypes.JSONB,
      allowNull: true,
    },
    order: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    archivedAt: {
      type: DataTypes.DATE,
      allowNull: true,
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
      allowNull: true,
    },
  },
  {
    sequelize,
    paranoid: true,
    tableName: 'ManualPaymentProviders',
  },
);

export default ManualPaymentProvider;
