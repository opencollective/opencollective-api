import { pick } from 'lodash-es';
import type { CreationOptional, InferAttributes, InferCreationAttributes } from 'sequelize';

import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../constants/paymentMethods.js';
import sequelize, { DataTypes, Model } from '../lib/sequelize.js';

export enum AssetType {
  USER = 'USER',
  CREDIT_CARD = 'CREDIT_CARD',
  IP = 'IP',
  EMAIL_ADDRESS = 'EMAIL_ADDRESS',
  EMAIL_DOMAIN = 'EMAIL_DOMAIN',
}

/**
 * Sequelize model to represent an SuspendedAsset, linked to the `SuspendedAssets` table.
 */
class SuspendedAsset extends Model<InferAttributes<SuspendedAsset>, InferCreationAttributes<SuspendedAsset>> {
  public declare readonly id: CreationOptional<number>;
  public declare type: AssetType;
  public declare reason: string;
  public declare fingerprint: string;
  public declare createdAt: Date;
  public declare updatedAt: Date;
  public declare deletedAt: Date;

  static async assertAssetIsNotSuspended({
    type,
    fingerprint,
  }: {
    type: AssetType;
    fingerprint: string;
  }): Promise<void> {
    const asset = await this.findOne({ where: { type, fingerprint } });
    if (asset) {
      throw new Error(`Asset ${fingerprint} of type ${type} is suspended.`);
    }
  }

  static async suspendCreditCard(paymentMethod, reason) {
    if (
      paymentMethod?.type === PAYMENT_METHOD_TYPE.CREDITCARD &&
      paymentMethod?.service === PAYMENT_METHOD_SERVICE.STRIPE
    ) {
      const { name, data } = paymentMethod;
      const where = {
        type: AssetType.CREDIT_CARD,
        fingerprint:
          data?.fingerprint ||
          [name, ...Object.values(pick(data, ['brand', 'expMonth', 'expYear', 'funding']))].join('-'),
      };

      const [asset] = await SuspendedAsset.findOrCreate({ where, defaults: { reason }, paranoid: false });
      return asset;
    }
  }
}

// Link the model to database fields
SuspendedAsset.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    type: {
      type: DataTypes.ENUM(...Object.values(AssetType)),
      allowNull: false,
    },
    reason: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    fingerprint: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    createdAt: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
      allowNull: false,
    },
    updatedAt: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    },
    deletedAt: {
      type: DataTypes.DATE,
    },
  },
  {
    sequelize,
    paranoid: true,
    tableName: 'SuspendedAssets',
  },
);

export default SuspendedAsset;
