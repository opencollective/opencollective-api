import config from 'config';
import { isNil } from 'lodash';

import { supportedServices } from '../constants/connected_account';
import { crypto } from '../lib/encryption';
/**
 * Model.
 */
export default (Sequelize, DataTypes) => {
  const ConnectedAccount = Sequelize.define(
    'ConnectedAccount',
    {
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
        set(value) {
          this.setDataValue('token', crypto.encrypt(value));
        },
      },
      // used for Stripe
      refreshToken: {
        type: DataTypes.STRING,
        get() {
          const encrypted = this.getDataValue('refreshToken');
          return isNil(encrypted) ? null : crypto.decrypt(encrypted);
        },
        set(value) {
          this.setDataValue('refreshToken', crypto.encrypt(value));
        },
      },

      data: DataTypes.JSONB, // Extra service provider specific data, e.g. Stripe: { publishableKey, scope, tokenType }
      settings: DataTypes.JSONB, // configuration settings, e.g. defining templates for auto-tweeting

      createdAt: {
        type: DataTypes.DATE,
        defaultValue: Sequelize.NOW,
      },

      updatedAt: {
        type: DataTypes.DATE,
        defaultValue: Sequelize.NOW,
      },

      hash: {
        type: DataTypes.STRING,
      },
    },
    {
      paranoid: true,

      getterMethods: {
        info() {
          return {
            id: this.id,
            service: this.service,
            username: this.username,
            createdAt: this.createdAt,
            updatedAt: this.updatedAt,
          };
        },

        paypalConfig() {
          return {
            client_id: this.clientId, // eslint-disable-line camelcase
            client_secret: this.token, // eslint-disable-line camelcase
            mode: config.paypal.rest.mode,
          };
        },
      },
    },
  );

  ConnectedAccount.associate = m => {
    ConnectedAccount.belongsTo(m.Collective, {
      foreignKey: 'CollectiveId',
      as: 'collective',
    });
  };

  return ConnectedAccount;
};
