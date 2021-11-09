import restoreSequelizeAttributesOnClass from '../lib/restore-sequelize-attributes-on-class';
import sequelize, { DataTypes, Model } from '../lib/sequelize';

interface LocationAttributes {
  id: number;
  CollectiveId: number;
  country: string;
  name: string;
  address: string;
  latitude: number;
  longitude: number;
  structured: Record<string, string>;
  isMainLegalAddress: boolean;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date;
}

class Location extends Model<LocationAttributes> implements LocationAttributes {
  id: number;
  CollectiveId: number;
  country: string;
  name: string;
  address: string;
  latitude: number;
  longitude: number;
  structured: Record<string, string>;
  isMainLegalAddress: boolean;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date;

  constructor(...args) {
    super(...args);
    restoreSequelizeAttributesOnClass(new.target, this);
  }
}

Location.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    CollectiveId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: 'Collectives', key: 'id' },
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
    },
    country: {
      type: DataTypes.STRING(2),
      allowNull: false,
    },
    name: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    address: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    latitude: {
      type: DataTypes.FLOAT,
      allowNull: true,
    },
    longitude: {
      type: DataTypes.FLOAT,
      allowNull: true,
    },
    structured: {
      type: DataTypes.JSONB,
      allowNull: true,
    },
    isMainLegalAddress: {
      type: DataTypes.BOOLEAN,
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
    tableName: 'Locations',
    paranoid: true,
    validate: {
      bothCoordsOrNone() {
        if ((this.latitude === null) !== (this.longitude === null)) {
          throw new Error('You should either set both latitude and longitude, or neither');
        }
      },
      isNotEmpty() {
        if (!this.address && !this.latitude && !this.structured) {
          throw new Error('Address, latitude/longitude or structured data is required');
        }
      },
    },
  },
);

export default Location;
