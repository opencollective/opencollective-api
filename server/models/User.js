import Promise from 'bluebird';
import { isEmailBurner } from 'burner-email-providers';
import config from 'config';
import debugLib from 'debug';
import slugify from 'limax';
import { defaults, get, intersection, pick } from 'lodash';
import Temporal from 'sequelize-temporal';

import roles from '../constants/roles';
import * as auth from '../lib/auth';
import emailLib from '../lib/email';
import logger from '../lib/logger';
import sequelize, { DataTypes, Op } from '../lib/sequelize';
import { isValidEmail } from '../lib/utils';

const debug = debugLib('models:User');

function defineModel() {
  const { models } = sequelize;

  const User = sequelize.define(
    'User',
    {
      email: {
        type: DataTypes.STRING,
        allowNull: false,
        unique: true,
        set(val) {
          if (val && val.toLowerCase) {
            this.setDataValue('email', val.toLowerCase());
          }
        },
        validate: {
          len: {
            args: [6, 128],
            msg: 'Email must be between 6 and 128 characters in length',
          },
          isEmail: {
            msg: 'Email must be valid',
          },
          isBurnerEmail: function (val) {
            if (isEmailBurner(val.toLowerCase()) && !emailLib.isWhitelistedDomain(val.toLowerCase())) {
              throw new Error(
                'This email provider is not allowed on Open Collective. If you think that it should be, please email us at support@opencollective.com.',
              );
            }
          },
        },
      },

      emailWaitingForValidation: {
        type: DataTypes.STRING,
        unique: true,
        validate: {
          isEmail: {
            msg: 'Email must be valid',
          },
        },
      },

      emailConfirmationToken: {
        type: DataTypes.STRING,
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
        allowNull: true,
      },

      confirmedAt: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW,
        allowNull: true,
      },

      lastLoginAt: {
        type: DataTypes.DATE,
      },

      newsletterOptIn: {
        allowNull: false,
        defaultValue: false,
        type: DataTypes.BOOLEAN,
      },

      data: {
        type: DataTypes.JSONB,
        allowNull: true,
      },

      twoFactorAuthToken: {
        type: DataTypes.STRING,
        allowNull: true,
      },

      twoFactorAuthRecoveryCodes: {
        type: DataTypes.ARRAY(DataTypes.STRING),
        allowNull: true,
      },
      changelogViewDate: {
        type: DataTypes.DATE,
        allowNull: true,
      },
    },
    {
      paranoid: true,

      getterMethods: {
        // Collective of type USER corresponding to this user
        userCollective() {
          return models.Collective.findByPk(this.CollectiveId).then(userCollective => {
            if (!userCollective) {
              logger.info(
                `No Collective attached to this user id ${this.id} (User.CollectiveId: ${this.CollectiveId})`,
              );
              return {};
            }
            return userCollective;
          });
        },

        name() {
          return this.userCollective.then(collective => collective.name);
        },

        twitterHandle() {
          return this.userCollective.then(collective => collective.twitterHandle);
        },

        githubHandle() {
          return this.userCollective.then(collective => collective.githubHandle);
        },

        website() {
          return this.userCollective.then(collective => collective.website);
        },

        description() {
          return this.userCollective.then(collective => collective.description);
        },

        longDescription() {
          return this.userCollective.then(collective => collective.longDescription);
        },

        image() {
          return this.userCollective.then(collective => collective.image);
        },

        // Info (private).
        info() {
          return {
            id: this.id,
            email: this.email,
            emailWaitingForValidation: this.emailWaitingForValidation,
            createdAt: this.createdAt,
            updatedAt: this.updatedAt,
          };
        },

        // Show (to any other user).
        show() {
          return {
            id: this.id,
            CollectiveId: this.CollectiveId,
            createdAt: this.createdAt,
            updatedAt: this.updatedAt,
          };
        },

        minimal() {
          return {
            id: this.id,
            email: this.email,
          };
        },

        // Used for the public collective
        public() {
          return {
            id: this.id,
          };
        },
      },
    },
  );

  /** Instance Methods */

  /**
   * Generate a JWT for user.
   *
   * @param {object} `payload` - data to attach to the token
   * @param {Number} `expiration` - expiration period in seconds
   */
  User.prototype.jwt = function (payload, expiration) {
    expiration = expiration || auth.TOKEN_EXPIRATION_LOGIN;
    return auth.createJwt(this.id, payload, expiration);
  };

  User.prototype.generateLoginLink = function (redirect = '/', websiteUrl) {
    const lastLoginAt = this.lastLoginAt ? this.lastLoginAt.getTime() : null;
    const token = this.jwt({ scope: 'login', lastLoginAt });
    // if a different websiteUrl is passed
    // we don't accept that in production to avoid fishing related issues
    if (websiteUrl && config.env !== 'production') {
      return `${websiteUrl}/signin/${token}?next=${redirect}`;
    } else {
      return `${config.host.website}/signin/${token}?next=${redirect}`;
    }
  };

  User.prototype.generateConnectedAccountVerifiedToken = function (connectedAccountId, username) {
    const payload = {
      scope: 'connected-account',
      connectedAccountId,
      username,
    };
    return this.jwt(payload, auth.TOKEN_EXPIRATION_CONNECTED_ACCOUNT);
  };

  User.prototype.getMemberships = function (options = {}) {
    const query = {
      where: {
        MemberCollectiveId: this.CollectiveId,
      },
      ...options,
    };
    return models.Member.findAll(query);
  };

  User.prototype.unsubscribe = function (CollectiveId, type, channel = 'email') {
    const notification = {
      UserId: this.id,
      CollectiveId,
      type,
      channel,
    };
    return models.Notification.findOne({ where: notification }).then(result => {
      if (result) {
        return result.update({ active: false });
      } else {
        notification.active = false;
        return models.Notification.create(notification);
      }
    });
  };

  User.prototype.getIncognitoProfile = function () {
    // TODO: We should rely on the `Members` table for this
    return models.Collective.findOne({ where: { isIncognito: true, CreatedByUserId: this.id } });
  };

  User.prototype.populateRoles = async function () {
    if (this.rolesByCollectiveId) {
      debug('roles already populated');
      return Promise.resolve(this);
    }
    const rolesByCollectiveId = {};
    const adminOf = [];
    const where = { MemberCollectiveId: this.CollectiveId };
    const incognitoProfile = await this.getIncognitoProfile();
    if (incognitoProfile) {
      where.MemberCollectiveId = { [Op.in]: [this.CollectiveId, incognitoProfile.id] };
    }
    const memberships = await models.Member.findAll({ where });
    memberships.map(m => {
      rolesByCollectiveId[m.CollectiveId] = rolesByCollectiveId[m.CollectiveId] || [];
      rolesByCollectiveId[m.CollectiveId].push(m.role);
      if (m.role === roles.ADMIN) {
        adminOf.push(m.CollectiveId);
      }
    });
    this.rolesByCollectiveId = rolesByCollectiveId;
    debug('populateRoles', this.rolesByCollectiveId);
    return this;
  };

  User.prototype.hasRole = function (roles, CollectiveId) {
    if (!CollectiveId) {
      return false;
    }
    if (this.CollectiveId === Number(CollectiveId)) {
      return true;
    }
    if (!this.rolesByCollectiveId) {
      logger.info("User.rolesByCollectiveId hasn't been populated.");
      logger.debug(new Error().stack);
      return false;
    }
    if (typeof roles === 'string') {
      roles = [roles];
    }
    const result = intersection(this.rolesByCollectiveId[Number(CollectiveId)], roles).length > 0;
    debug('hasRole', 'userid:', this.id, 'has role', roles, ' in CollectiveId', CollectiveId, '?', result);
    return result;
  };

  // Adding some sugars
  User.prototype.isAdmin = function (CollectiveId) {
    const result = this.CollectiveId === Number(CollectiveId) || this.hasRole([roles.HOST, roles.ADMIN], CollectiveId);
    debug('isAdmin of CollectiveId', CollectiveId, '?', result);
    return result;
  };

  // Slightly better API than the former
  User.prototype.isAdminOfCollective = function (collective) {
    if (collective.type === 'EVENT' || collective.type === 'PROJECT') {
      return this.isAdmin(collective.id) || this.isAdmin(collective.ParentCollectiveId);
    } else {
      return this.isAdmin(collective.id);
    }
  };

  /**
   * Check if the user is an admin of the collective or its fiscal host
   */
  User.prototype.isAdminOfCollectiveOrHost = function (collective) {
    if (!collective) {
      return false;
    } else if (this.isAdminOfCollective(collective)) {
      return true;
    } else if (collective.HostCollectiveId) {
      return this.isAdmin(collective.HostCollectiveId);
    } else {
      return false;
    }
  };

  User.prototype.isRoot = function () {
    const result = this.hasRole([roles.ADMIN], 1) || this.hasRole([roles.ADMIN], 8686);
    debug('isRoot?', result);
    return result;
  };

  User.prototype.isMember = function (CollectiveId) {
    const result =
      this.CollectiveId === CollectiveId || this.hasRole([roles.HOST, roles.ADMIN, roles.MEMBER], CollectiveId);
    debug('isMember of CollectiveId', CollectiveId, '?', result);
    return result;
  };

  // Slightly better API than the former
  User.prototype.isMemberOfCollective = function (collective) {
    if (collective.type === 'EVENT' || collective.type === 'PROJECT') {
      return this.isMember(collective.id) || this.isMember(collective.ParentCollectiveId);
    } else {
      return this.isMember(collective.id);
    }
  };

  // Determines whether a user can see updates for a collective based on their roles.
  User.prototype.canSeePrivateUpdatesForCollective = function (collective) {
    const allowedRoles = [roles.HOST, roles.ADMIN, roles.MEMBER, roles.CONTRIBUTOR, roles.BACKER];
    return this.hasRole(allowedRoles, collective.id) || this.hasRole(allowedRoles, collective.ParentCollectiveId);
  };

  /**
   * Limit the user account, preventing most actions on the platoform
   * @param spamReport: an optional spam report to attach to the account limitation. See `server/lib/spam.ts`.
   */
  User.prototype.limitAccount = async function (spamReport = null) {
    const newData = { ...this.data, features: { ...get(this.data, 'features'), ALL: false } };
    if (spamReport) {
      newData.spamReports = [...get(this.data, 'spamReports', []), spamReport];
    }

    logger.info(`Limiting user account for ${this.id}`);
    return this.update({ data: newData });
  };

  /**
   * Limit the user account, preventing a specific feature
   * @param feature:the feature to limit. See `server/constants/feature.ts`.
   */
  User.prototype.limitFeature = async function (feature) {
    const features = get(this.data, 'features', {});

    features[feature] = false;

    return this.update({ data: { ...this.data, features } });
  };

  /**
   * Class Methods
   */
  User.createMany = (users, defaultValues = {}) => {
    return Promise.map(users, u => User.create(defaults({}, u, defaultValues)), { concurrency: 1 });
  };

  User.findOrCreateByEmail = (email, otherAttributes) => {
    if (!isValidEmail(email)) {
      return Promise.reject(new Error('Please provide a valid email address'));
    }
    debug('findOrCreateByEmail', email, 'other attributes: ', otherAttributes);
    return User.findByEmail(email).then(
      user => user || models.User.createUserWithCollective(Object.assign({}, { email }, otherAttributes)),
    );
  };

  User.findByEmail = (email, transaction) => {
    return User.findOne({ where: { email: email.toLowerCase() } }, { transaction });
  };

  User.createUserWithCollective = async (userData, transaction) => {
    if (!userData) {
      return Promise.reject(new Error('Cannot create a user: no user data provided'));
    }

    const sequelizeParams = transaction ? { transaction } : undefined;
    debug('createUserWithCollective', userData);
    const cleanUserData = pick(userData, ['email', 'newsletterOptIn']);
    const user = await User.create(cleanUserData, sequelizeParams);

    // If user doesn't provide a name, set it to "incognito". If we cannot
    // slugify it (for example name="------") then fallback on "user".
    let collectiveName = userData.name;
    if (!collectiveName || collectiveName.trim().length === 0) {
      collectiveName = 'incognito';
    } else if (slugify(collectiveName).length === 0) {
      collectiveName = 'user';
    }

    const userCollectiveData = {
      type: 'USER',
      name: collectiveName,
      legalName: userData.legalName,
      image: userData.image,
      description: userData.description,
      longDescription: userData.longDescription,
      website: userData.website,
      twitterHandle: userData.twitterHandle,
      githubHandle: userData.githubHandle,
      currency: userData.currency,
      hostFeePercent: userData.hostFeePercent,
      isActive: false,
      isHostAccount: Boolean(userData.isHostAccount),
      CreatedByUserId: userData.CreatedByUserId || user.id,
      data: { UserId: user.id },
      settings: userData.settings,
      countryISO: userData.location?.country,
      address: userData.location?.address,
    };
    user.collective = await models.Collective.create(userCollectiveData, sequelizeParams);

    // It's difficult to predict when the image will be updated by findImageForUser
    // So we skip that in test environment to make it more predictable
    if (!['ci', 'test'].includes(config.env)) {
      user.collective.findImageForUser(user);
    }
    user.CollectiveId = user.collective.id;
    await user.save(sequelizeParams);
    return user;
  };

  User.splitName = name => {
    let firstName = null,
      lastName = null;
    if (name) {
      const tokens = name.split(' ');
      firstName = tokens[0];
      lastName = tokens.length > 1 ? tokens.slice(1).join(' ') : null;
    }
    return { firstName, lastName };
  };

  Temporal(User, sequelize);

  return User;
}

// We're using the defineModel method to keep the indentation and have a clearer git history.
// Please consider this if you plan to refactor.
const User = defineModel();

export default User;
