import config from 'config';

import { mustBeLoggedInTo } from '../lib/auth';

import * as errors from '../graphql/errors';
/**
 * Model.
 */
export default (Sequelize, DataTypes) => {
  const supportedServices = ['paypal', 'stripe', 'github', 'twitter', 'meetup'];

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
      token: DataTypes.STRING,
      refreshToken: DataTypes.STRING, // used for Stripe

      data: DataTypes.JSON, // Extra service provider specific data, e.g. Stripe: { publishableKey, scope, tokenType }
      settings: DataTypes.JSON, // configuration settings, e.g. defining templates for auto-tweeting

      createdAt: {
        type: DataTypes.DATE,
        defaultValue: Sequelize.NOW,
      },

      updatedAt: {
        type: DataTypes.DATE,
        defaultValue: Sequelize.NOW,
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
            client_id: this.clientId,
            client_secret: this.token,
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

  ConnectedAccount.prototype.delete = async function(remoteUser) {
    mustBeLoggedInTo(remoteUser, 'disconnect this connected account');
    if (remoteUser.id !== this.CreatedByUserId || !remoteUser.isAdmin(this.CollectiveId)) {
      throw new errors.Unauthorized({
        message: 'You are either logged out or not authorized to disconnect this account',
      });
    }
    return this.destroy();
  };

  return ConnectedAccount;
};
