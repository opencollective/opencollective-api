import { InferAttributes } from 'sequelize';

import sequelize, { DataTypes } from '../lib/sequelize';

import { ModelWithPublicId } from './ModelWithPublicId';

export interface PaypalProductCreateAttributes {
  id: string;
  TierId: number;
  CollectiveId: number;
  HostCollectiveId: number;
}

class PaypalProduct extends ModelWithPublicId<InferAttributes<PaypalProduct>, PaypalProductCreateAttributes> {
  public static readonly nanoIdPrefix = 'pprod' as const;
  public static readonly tableName = 'PaypalProducts' as const;

  declare public id: string;
  declare public readonly publicId: string;
  declare public CollectiveId: number;
  declare public HostCollectiveId: number;
  declare public TierId: number;
  declare public createdAt: Date;
  declare public updatedAt: Date;
  declare public deletedAt: Date;
}

PaypalProduct.init(
  {
    id: {
      type: DataTypes.STRING,
      primaryKey: true,
      allowNull: false,
    },
    publicId: {
      type: DataTypes.STRING,
      unique: true,
    },
    CollectiveId: {
      type: DataTypes.INTEGER,
      references: { model: 'Collectives', key: 'id' },
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
      allowNull: false,
    },
    HostCollectiveId: {
      type: DataTypes.INTEGER,
      references: { model: 'Collectives', key: 'id' },
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
      allowNull: true, // Should be switched to false once all products have a host. We have set values for all currently hosted collectives, but unhosted ones will have null.
    },
    TierId: {
      type: DataTypes.INTEGER,
      references: { model: 'Tiers', key: 'id' },
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
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
    },
  },
  {
    sequelize,
    tableName: 'PaypalProducts',
    paranoid: true,
  },
);

export default PaypalProduct;
