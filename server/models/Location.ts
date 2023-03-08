import type { CreationOptional, ForeignKey, InferAttributes, InferCreationAttributes } from 'sequelize';

import sequelize, { DataTypes, Model } from '../lib/sequelize';

type GeoLocationShape = {
  type?: string;
  coordinates?: [number, number];
};

class Location extends Model<InferAttributes<Location>, InferCreationAttributes<Location>> {
  declare id: CreationOptional<number>;

  declare name: CreationOptional<string>;
  declare address1: CreationOptional<string>;
  declare address2: CreationOptional<string>;
  declare postalCode: CreationOptional<string>;
  declare city: CreationOptional<string>;
  declare zone: CreationOptional<string>;
  declare country: CreationOptional<string>;
  declare geoLocationLatLong: CreationOptional<null | GeoLocationShape>;
  declare formattedAddress: CreationOptional<string>;
  declare url: CreationOptional<string>;

  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare deletedAt: CreationOptional<Date>;

  // Relationships
  declare CollectiveId: ForeignKey<number>;
}

Location.init(
  {
    id: {
      allowNull: false,
      autoIncrement: true,
      primaryKey: true,
      type: DataTypes.INTEGER,
    },
    name: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    address1: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    address2: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    postalCode: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    city: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    zone: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    country: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    geoLocationLatLong: {
      type: DataTypes.JSONB,
      allowNull: true,
    },
    formattedAddress: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    url: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    CollectiveId: {
      type: DataTypes.INTEGER,
      references: { key: 'id', model: 'Collectives' },
      allowNull: true,
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
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
      allowNull: true,
      type: DataTypes.DATE,
    },
  },
  {
    sequelize,
    tableName: 'Locations',
    paranoid: true, // For soft-deletion
  },
);

export default Location;
