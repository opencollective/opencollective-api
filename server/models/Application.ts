import { randomBytes } from 'crypto';

import { isNil, merge } from 'lodash';
import type { CreationOptional, ForeignKey, InferAttributes, InferCreationAttributes, NonAttribute } from 'sequelize';

import { crypto } from '../lib/encryption';
import sequelize, { DataTypes, Model } from '../lib/sequelize';

import User from './User';

export type ApplicationType = 'apiKey' | 'oAuth';

class Application extends Model<InferAttributes<Application>, InferCreationAttributes<Application>> {
  public declare readonly id: CreationOptional<number>;
  public declare CollectiveId: number;
  public declare CreatedByUserId: ForeignKey<User['id']>;
  public declare type: ApplicationType;
  public declare apiKey: string;
  public declare clientId: string;
  public declare clientSecret: string;
  public declare callbackUrl: string;
  public declare name: string;
  public declare description: string;
  public declare disabled: boolean;
  public declare createdAt: CreationOptional<Date>;
  public declare updatedAt: CreationOptional<Date>;
  public declare deletedAt: CreationOptional<Date>;
  public declare data: JSON;

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
