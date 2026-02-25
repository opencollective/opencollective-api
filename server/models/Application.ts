import { randomBytes } from 'crypto';

import { isNil, merge } from 'lodash';
import type {
  Association,
  BelongsToGetAssociationMixin,
  CreationOptional,
  ForeignKey,
  InferAttributes,
  InferCreationAttributes,
  NonAttribute,
} from 'sequelize';

import { crypto } from '../lib/encryption';
import sequelize, { DataTypes } from '../lib/sequelize';

import { ModelWithPublicId } from './ModelWithPublicId';
import User from './User';

export type ApplicationType = 'apiKey' | 'oAuth';

class Application extends ModelWithPublicId<InferAttributes<Application>, InferCreationAttributes<Application>> {
  public static readonly nanoIdPrefix = 'app' as const;
  public static readonly tableName = 'Applications' as const;

  declare public readonly id: CreationOptional<number>;
  declare public CollectiveId: number;
  declare public CreatedByUserId: ForeignKey<User['id']>;
  declare public type: ApplicationType;
  declare public apiKey: string;
  declare public clientId: string;
  declare public clientSecret: string;
  declare public callbackUrl: string;
  declare public name: string;
  declare public description: string;
  declare public disabled: boolean;
  declare public preAuthorize2FA: CreationOptional<boolean>;
  declare public createdAt: CreationOptional<Date>;
  declare public updatedAt: CreationOptional<Date>;
  declare public deletedAt: CreationOptional<Date>;
  declare public data: Record<string, unknown>;

  declare public createdByUser: NonAttribute<User>;
  declare getCreatedByUser: BelongsToGetAssociationMixin<User>;

  declare static associations: {
    createdByUser: Association<Application, User>;
  };

  get info(): NonAttribute<Partial<Application>> {
    return {
      name: this.name,
      description: this.description,
      apiKey: this.apiKey,
      clientId: this.clientId,
      clientSecret: this.clientSecret,
      callbackUrl: this.callbackUrl,
    };
  }

  get publicInfo(): NonAttribute<Partial<Application>> {
    return {
      id: this.id,
      name: this.name,
      description: this.description,
      type: this.type,
      CreatedByUserId: this.CreatedByUserId,
      CollectiveId: this.CollectiveId,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      deletedAt: this.deletedAt,
    };
  }
}

Application.init(
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
    },
    CollectiveId: {
      type: DataTypes.INTEGER,
      references: {
        model: 'Collectives',
        key: 'id',
      },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
    },
    CreatedByUserId: {
      type: DataTypes.INTEGER,
      references: {
        model: 'Users',
        key: 'id',
      },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
    },
    type: {
      type: DataTypes.ENUM,
      values: ['apiKey', 'oAuth'],
    },
    apiKey: {
      type: DataTypes.STRING,
    },
    clientId: {
      type: DataTypes.STRING,
    },
    clientSecret: {
      type: DataTypes.STRING,
      get() {
        const encrypted = this.getDataValue('clientSecret');
        return isNil(encrypted) ? null : crypto.decrypt(encrypted);
      },
      set(value: string) {
        this.setDataValue('clientSecret', crypto.encrypt(value));
      },
    },
    callbackUrl: {
      type: DataTypes.STRING,
    },
    name: {
      type: DataTypes.STRING,
    },
    description: {
      type: DataTypes.STRING,
    },
    disabled: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    preAuthorize2FA: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
      allowNull: false,
    },
    createdAt: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    },
    updatedAt: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    },
    deletedAt: {
      type: DataTypes.DATE,
    },
    data: {
      type: DataTypes.JSONB,
    },
  },
  {
    sequelize,
    modelName: 'Application',
    paranoid: true,
  },
);

Application.create = (props?): Promise<ReturnType<typeof Application.create>> => {
  if (props.type === 'apiKey') {
    props = merge(props, {
      apiKey: randomBytes(20).toString('hex'),
    });
  }
  if (props.type === 'oAuth') {
    props = merge(props, {
      clientId: randomBytes(10).toString('hex'), // Will be 20 length in ascii
      clientSecret: randomBytes(20).toString('hex'), // Will be 40 length in ascii
    });
  }
  return Application.build(props).save();
};

export default Application;
