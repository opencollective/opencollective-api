import { isNil } from 'lodash-es';
import type { CreationOptional, ForeignKey, InferAttributes, InferCreationAttributes } from 'sequelize';
import validator from 'validator';

import sequelize, { DataTypes, Model } from '../lib/sequelize.js';
import { StructuredAddress } from '../types/Location.js';

type GeoLocationLatLong = {
  type: 'Point';
  coordinates: [number, number];
};

class Location extends Model<InferAttributes<Location>, InferCreationAttributes<Location>> {
  declare id: CreationOptional<number>;

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
          if (!(isNil(value) || validator.default.isISO31661Alpha2(value))) {
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
