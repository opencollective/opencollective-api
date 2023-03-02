import type { CreationOptional, ForeignKey, InferAttributes, InferCreationAttributes } from 'sequelize';

import sequelize, { DataTypes, Model } from '../lib/sequelize';

import User from './User';

type GeoLocationShape = {
  type?: string;
  coordinates?: [number, number];
};

class Location extends Model<InferAttributes<Location>, InferCreationAttributes<Location>> {
  declare id: CreationOptional<number>;

  declare name: CreationOptional<string>;
  declare address: CreationOptional<string>;
  declare street: CreationOptional<string>;
  declare street2: CreationOptional<string>;
  declare postalCode: CreationOptional<string>;
  declare city: CreationOptional<string>;
  declare state: CreationOptional<string>;
  declare countryISO: CreationOptional<string>;
  declare geoLocationLatLong: CreationOptional<null | GeoLocationShape>;
  declare type: CreationOptional<'LEGAL' | 'DISPLAY'>;

  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare deletedAt: CreationOptional<Date>;

  // Relationships
  declare CollectiveId: ForeignKey<number>;
  declare CreatedByUserId: ForeignKey<User['id']>;
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
    address: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    street: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    street2: {
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
    state: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    countryISO: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    geoLocationLatLong: {
      type: DataTypes.JSONB,
      allowNull: true,
    },
    type: {
      type: DataTypes.ENUM('LEGAL', 'DISPLAY'),
      defaultValue: 'DISPLAY',
      allowNull: false,
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
    CreatedByUserId: {
      type: DataTypes.INTEGER,
      references: { key: 'id', model: 'Users' },
      allowNull: true,
      onDelete: 'SET NULL',
      onUpdate: 'SET NULL',
    },
  },
  {
    sequelize,
    tableName: 'Locations',
    paranoid: true, // For soft-deletion
  },
);

export default Location;
