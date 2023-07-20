import config from 'config';
import { isNil } from 'lodash-es';
import { CreationOptional, InferAttributes, InferCreationAttributes } from 'sequelize';

import { supportedServices } from '../constants/connected_account.js';
import { crypto } from '../lib/encryption.js';
import sequelize, { DataTypes, Model } from '../lib/sequelize.js';

export class ConnectedAccount extends Model<
  InferAttributes<ConnectedAccount, { omit: 'info' | 'activity' | 'paypalConfig' }>,
  InferCreationAttributes<ConnectedAccount>
> {
  public declare readonly id: CreationOptional<number>;
  public declare service: string;
  public declare username: string;
  public declare clientId: string;
  public declare token: string;
  public declare refreshToken: string;
  public declare hash: string;
  public declare data: CreationOptional<Record<string, any>>;
  public declare settings: CreationOptional<Record<string, any>>;

  public declare CollectiveId: CreationOptional<number>;
  public declare CreatedByUserId: CreationOptional<number>;
  public declare createdAt: CreationOptional<Date>;
  public declare updatedAt: CreationOptional<Date>;

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
