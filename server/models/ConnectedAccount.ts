import config from 'config';
import { isNil } from 'lodash';
import {
  BelongsToGetAssociationMixin,
  CreationOptional,
  InferAttributes,
  InferCreationAttributes,
  NonAttribute,
} from 'sequelize';

import { supportedServices } from '../constants/connected-account';
import { crypto } from '../lib/encryption';
import sequelize, { DataTypes, Model } from '../lib/sequelize';

import Collective from './Collective';

class ConnectedAccount extends Model<
  InferAttributes<ConnectedAccount, { omit: 'info' | 'activity' | 'paypalConfig' }>,
  InferCreationAttributes<ConnectedAccount>
> {
  declare public readonly id: CreationOptional<number>;
  declare public service: string;
  declare public username: string;
  declare public clientId: string;
  declare public token: string;
  declare public refreshToken: string;
  declare public hash: string;
  declare public data: CreationOptional<Record<string, any>>;
  declare public settings: CreationOptional<Record<string, any>>;

  declare public CollectiveId: CreationOptional<number>;
  declare public CreatedByUserId: CreationOptional<number>;
  declare public createdAt: CreationOptional<Date>;
  declare public updatedAt: CreationOptional<Date>;
  declare public deletedAt: CreationOptional<Date>;

  declare public collective?: NonAttribute<Collective>;
  declare public getCollective: BelongsToGetAssociationMixin<Collective>;

  get info() {
    return {
      id: this.id,
      service: this.service,
      username: this.username,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }

  get activity() {
    return {
      id: this.id,
      service: this.service,
      CollectiveId: this.CollectiveId,
      CreatedByUserId: this.CreatedByUserId,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }

  get paypalConfig() {
    return {
      client_id: this.clientId, // eslint-disable-line camelcase
      client_secret: this.token, // eslint-disable-line camelcase
      mode: config.paypal.rest.mode,
    };
  }
}

ConnectedAccount.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    service: {
      type: DataTypes.STRING,
      validate: {
        isIn: {
          args: [supportedServices],
          msg: `Must be in ${supportedServices}`,
        },
      },
    },
    username: DataTypes.STRING, // paypal email / Stripe UserId / Twitter username / ...
    clientId: DataTypes.STRING, // paypal app id
    // either paypal secret OR an accessToken to do requests to the provider on behalf of the user
    token: {
      type: DataTypes.STRING,
      get() {
        const encrypted = this.getDataValue('token');
        return isNil(encrypted) ? null : crypto.decrypt(encrypted);
      },
      set(value: string) {
        this.setDataValue('token', crypto.encrypt(value));
      },
    },
    refreshToken: {
      type: DataTypes.STRING,
      get() {
        const encrypted = this.getDataValue('refreshToken');
        return isNil(encrypted) ? null : crypto.decrypt(encrypted);
      },
      set(value: string) {
        this.setDataValue('refreshToken', crypto.encrypt(value));
      },
    },
    data: DataTypes.JSONB, // Extra service provider specific data, e.g. Stripe: { publishableKey, scope, tokenType }
    settings: DataTypes.JSONB, // configuration settings, e.g. defining templates for auto-tweeting
    createdAt: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    },
    deletedAt: {
      type: DataTypes.DATE,
    },
    updatedAt: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    },
    hash: {
      type: DataTypes.STRING,
    },
    CollectiveId: {
      type: DataTypes.INTEGER,
      references: {
        model: 'Collectives',
        key: 'id',
      },
    },
    CreatedByUserId: {
      type: DataTypes.INTEGER,
      references: {
        model: 'Users',
        key: 'id',
      },
    },
  },
  {
    sequelize,
    paranoid: true,
  },
);

export default ConnectedAccount;
