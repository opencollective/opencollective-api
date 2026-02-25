import { isNil } from 'lodash';
import type { CreationOptional, ForeignKey, InferAttributes, InferCreationAttributes } from 'sequelize';
import validator from 'validator';

import sequelize, { DataTypes } from '../lib/sequelize';
import { StructuredAddress } from '../types/Location';

import { ModelWithPublicId } from './ModelWithPublicId';

type GeoLocationLatLong = {
  type: 'Point';
  coordinates: [number, number];
};

class Location extends ModelWithPublicId<InferAttributes<Location>, InferCreationAttributes<Location>> {
  public static readonly nanoIdPrefix = 'loc' as const;
  public static readonly tableName = 'Locations' as const;

  declare id: CreationOptional<number>;
  declare public readonly publicId: string;

  declare name: CreationOptional<string>;
  declare country: CreationOptional<string>;
  declare address: CreationOptional<string>;
  declare structured: CreationOptional<null | StructuredAddress>;

  declare geoLocationLatLong: CreationOptional<null | GeoLocationLatLong>;

  // Virtual lat/long fields
  declare lat: number;
  declare long: number;

  // Relationships
  declare CollectiveId: ForeignKey<number>;

  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare deletedAt: CreationOptional<Date>;
}

Location.init(
  {
    id: {
      allowNull: false,
      autoIncrement: true,
      primaryKey: true,
      type: DataTypes.INTEGER,
    },
    publicId: {
      type: DataTypes.STRING,
      unique: true,
      allowNull: false,
    },
    name: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    country: {
      type: DataTypes.STRING,
      allowNull: true,
      validate: {
        len: [2, 2],
        isCountryISO(value) {
          if (!(isNil(value) || validator.isISO31661Alpha2(value))) {
            throw new Error('Invalid Country ISO.');
          }
        },
      },
    },
    geoLocationLatLong: {
      type: DataTypes.JSONB,
      allowNull: true,
      validate: {
        validate(data) {
          if (!data) {
            return;
          } else if (data.type !== 'Point' || !data.coordinates || data.coordinates.length !== 2) {
            throw new Error('Invalid GeoLocation');
          } else if (typeof data.coordinates[0] !== 'number' || typeof data.coordinates[1] !== 'number') {
            throw new Error('Invalid latitude/longitude');
          }
        },
      },
    },
    structured: {
      type: DataTypes.JSONB,
      allowNull: true,
    },
    address: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    lat: {
      type: DataTypes.VIRTUAL(DataTypes.FLOAT),
      allowNull: true,
      get() {
        return this.geoLocationLatLong?.coordinates?.[0];
      },
    },
    long: {
      type: DataTypes.VIRTUAL(DataTypes.FLOAT),
      allowNull: true,
      get() {
        return this.geoLocationLatLong?.coordinates?.[1];
      },
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
