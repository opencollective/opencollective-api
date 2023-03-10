import bcrypt from 'bcrypt';
import { isEmailBurner } from 'burner-email-providers';
import config from 'config';
import debugLib from 'debug';
import slugify from 'limax';
import { defaults, get, intersection, isEmpty, pick } from 'lodash';
import {
  BelongsToGetAssociationMixin,
  CreationOptional,
  InferAttributes,
  InferCreationAttributes,
  NonAttribute,
} from 'sequelize';
import Temporal from 'sequelize-temporal';

import activities from '../constants/activities';
import { types } from '../constants/collectives';
import { Service } from '../constants/connected_account';
import OrderStatuses from '../constants/order_status';
import roles from '../constants/roles';
import * as auth from '../lib/auth';
import emailLib from '../lib/email';
import logger from '../lib/logger';
import sequelize, { DataTypes, Model, Op } from '../lib/sequelize';
import { isValidEmail, parseToBoolean } from '../lib/utils';

import Collective from './Collective';
import models from '.';

const debug = debugLib('models:User');

class User extends Model<InferAttributes<User>, InferCreationAttributes<User>> {
  public declare readonly id: CreationOptional<number>;
  public declare email: string;
  public declare emailWaitingForValidation: CreationOptional<string>;
  public declare emailConfirmationToken: CreationOptional<string>;
  public declare twoFactorAuthToken: CreationOptional<string>;
  public declare twoFactorAuthRecoveryCodes: CreationOptional<string[]>;
  public declare CollectiveId: number;
  public declare newsletterOptIn: boolean;
  public declare data: CreationOptional<Record<string, unknown>>;
  public declare createdAt: CreationOptional<Date>;
  public declare changelogViewDate: CreationOptional<Date>;
  public declare updatedAt: CreationOptional<Date>;
  public declare deletedAt: CreationOptional<Date>;
  public declare confirmedAt: CreationOptional<Date>;
  public declare lastLoginAt: CreationOptional<Date>;
  public declare passwordHash: CreationOptional<string>;
  public declare passwordUpdatedAt: CreationOptional<Date>;

  // TODO: We should ideally rely on this.changed(...)
  public _emailChanged?: NonAttribute<boolean>;
  public _emailWaitingForValidationChanged?: NonAttribute<boolean>;

  // Associations
  public declare collective?: Collective;
  declare getCollective: BelongsToGetAssociationMixin<Collective>;

  // Non-model attributes
  public rolesByCollectiveId?: NonAttribute<Record<string, string[]>>;

  /** Instance Methods */

  /**
   * Generate a JWT for user.
   *
   * @param {object} `payload` - data to attach to the token
   * @param {Boolean} `payload.traceless` - if token should update lastLoginAt information
   * @param {Number} `expiration` - expiration period in seconds
   */
  jwt = function (payload = undefined, expiration = undefined) {
    expiration = expiration || auth.TOKEN_EXPIRATION_LOGIN;
    return auth.createJwt(this.id, payload, expiration);
  };

  generateSessionToken = async function ({ sessionId = null } = {}) {
    if (!parseToBoolean(config.database.readOnly)) {
      await models.Activity.create({
        type: activities.USER_SIGNIN,
        UserId: this.id,
        FromCollectiveId: this.CollectiveId,
        CollectiveId: this.CollectiveId,
        data: { notify: false },
      });
    }

    return this.jwt({ sessionId }, auth.TOKEN_EXPIRATION_SESSION);
  };

  generateLoginLink = function (redirect = '/', websiteUrl) {
    const lastLoginAt = this.lastLoginAt ? this.lastLoginAt.getTime() : null;
    const token = this.jwt({ scope: 'login', lastLoginAt }, auth.TOKEN_EXPIRATION_LOGIN);
    // if a different websiteUrl is passed
    // we don't accept that in production to avoid fishing related issues
    if (websiteUrl && config.env !== 'production') {
      return `${websiteUrl}/signin/${token}?next=${redirect}`;
    } else {
      return `${config.host.website}/signin/${token}?next=${redirect}`;
    }
  };

  generateResetPasswordLink = function ({ websiteUrl = null } = {}) {
    const passwordUpdatedAt = this.passwordUpdatedAt ? this.passwordUpdatedAt.getTime() : null;
    const token = this.jwt({ scope: 'reset-password', passwordUpdatedAt }, auth.TOKEN_EXPIRATION_RESET_PASSWORD);
    // if a different websiteUrl is passed
    // we don't accept that in production to avoid fishing related issues
    if (websiteUrl && config.env !== 'production') {
      return `${websiteUrl}/reset-password/${token}`;
    } else {
      return `${config.host.website}/reset-password/${token}`;
    }
  };

  setPassword = async function (password, { userToken = null } = {}) {
    if (Buffer.from(password).length > 72) {
      throw new Error('Password is too long, should not be more than 72 bytes.');
    }

    const passwordHash = await bcrypt.hash(password, /* saltRounds */ 10);

    await this.update({ passwordHash, passwordUpdatedAt: new Date() });

    await models.Activity.create({
      type: activities.USER_PASSWORD_SET,
      UserId: this.id,
      FromCollectiveId: this.CollectiveId,
      CollectiveId: this.CollectiveId,
      UserTokenId: userToken?.id,
    });

    return this;
  };

  generateConnectedAccountVerifiedToken = function (connectedAccountId, username) {
    const payload = {
      scope: 'connected-account',
      connectedAccountId,
      username,
    };
    return this.jwt(payload, auth.TOKEN_EXPIRATION_CONNECTED_ACCOUNT);
  };

  getMemberships = function (options = {}) {
    const query = {
      where: {
        MemberCollectiveId: this.CollectiveId,
      },
      ...options,
    };
    return models.Member.findAll(query);
  };

  getIncognitoProfile = async function () {
    const collective = this.collective || (await this.getCollective());
    return collective.getIncognitoProfile();
  };

  populateRoles = async function () {
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

  hasRole = function (roles, CollectiveId) {
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
  isAdmin = function (CollectiveId) {
    const result = this.CollectiveId === Number(CollectiveId) || this.hasRole([roles.HOST, roles.ADMIN], CollectiveId);
    debug('isAdmin of CollectiveId', CollectiveId, '?', result);
    return result;
  };

  // Slightly better API than the former
  isAdminOfCollective = function (collective) {
    if (!collective) {
      return false;
    } else if (collective.type === 'EVENT' || collective.type === 'PROJECT') {
      return this.isAdmin(collective.id) || this.isAdmin(collective.ParentCollectiveId);
    } else {
      return this.isAdmin(collective.id);
    }
  };

  /**
   * Check if the user is an admin of the collective or its fiscal host
   */
  isAdminOfCollectiveOrHost = function (collective) {
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

  isAdminOfOpenCollectiveInc = function (): boolean {
    return this.hasRole([roles.ADMIN], 1) || this.hasRole([roles.ADMIN], 8686);
  };

  isRoot = function (): boolean {
    return Boolean(this.isAdminOfOpenCollectiveInc() && this.data?.isRoot);
  };

  isMember = function (CollectiveId) {
    const result =
      this.CollectiveId === CollectiveId || this.hasRole([roles.HOST, roles.ADMIN, roles.MEMBER], CollectiveId);
    debug('isMember of CollectiveId', CollectiveId, '?', result);
    return result;
  };

  // Slightly better API than the former
  isMemberOfCollective = function (collective) {
    if (collective.type === 'EVENT' || collective.type === 'PROJECT') {
      return this.isMember(collective.id) || this.isMember(collective.ParentCollectiveId);
    } else {
      return this.isMember(collective.id);
    }
  };

  /**
   * Limit the user account, preventing most actions on the platform
   * @param spamReport: an optional spam report to attach to the account limitation. See `server/lib/spam.ts`.
   */
  limitAccount = async function (spamReport = null) {
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
  limitFeature = async function (feature) {
    const features = get(this.data, 'features', {});
    features[feature] = false;

    logger.info(`Limiting feature ${feature} for user account ${this.id}`);

    this.changed('data', true);
    this.data = { ...this.data, features };
    return this.save();
  };

  /**
   * Remove limit from the user account, allowing a specific feature
   * @param feature:the feature to unlimit. See `server/constants/feature.ts`.
   */
  unlimitFeature = async function (feature) {
    const features = get(this.data, 'features', {});
    features[feature] = true;

    logger.info(`Unlimiting feature ${feature} for user account ${this.id}`);

    this.changed('data', true);
    this.data = { ...this.data, features };
    return this.save();
  };

  /**
   * Returns whether the User has any Orders with status of DISPUTED
   */
  hasDisputedOrders = async function () {
    const count = await sequelize.models.Order.count({
      where: { CreatedByUserId: this.id, status: OrderStatuses.DISPUTED },
    });
    return count > 0;
  };

  findRelatedUsersByIp = async function ({ include = undefined, where = null } = {}) {
    const ip = this.data?.lastSignInRequest?.ip || this.data?.creationRequest?.ip;
    return User.findAll({
      where: {
        ...where,
        id: { [Op.ne]: this.id },
        [Op.or]: [{ data: { creationRequest: { ip } } }, { data: { lastSignInRequest: { ip } } }],
      },
      include,
    });
  };

  findRelatedUsersByConnectedAccounts = async function () {
    const connectedAccounts = await models.ConnectedAccount.findAll({
      where: {
        CollectiveId: this.CollectiveId,
        service: { [Op.in]: [Service.GITHUB, Service.TWITTER, Service.PAYPAL] },
        username: { [Op.ne]: null },
      },
    });

    if (isEmpty(connectedAccounts)) {
      return [];
    }

    return User.findAll({
      where: {
        id: { [Op.ne]: this.id },
      },
      include: [
        {
          model: models.Collective,
          as: 'collective',
          required: true,
          include: [
            {
              model: models.ConnectedAccount,
              where: { [Op.or]: connectedAccounts.map(ca => pick(ca, ['service', 'username'])) },
              required: true,
            },
          ],
        },
      ],
    });
  };

  /**
   * Static Methods
   */
  static createMany = (users, defaultValues = {}) => {
    return Promise.all(users.map(u => User.create(defaults({}, u, defaultValues))));
  };

  static findOrCreateByEmail = (email, otherAttributes) => {
    if (!isValidEmail(email)) {
      return Promise.reject(new Error('Please provide a valid email address'));
    }
    debug('findOrCreateByEmail', email, 'other attributes: ', otherAttributes);
    return User.findByEmail(email).then(
      user => user || models.User.createUserWithCollective(Object.assign({}, { email }, otherAttributes)),
    );
  };

  static findByEmail = (email, transaction = undefined) => {
    return User.findOne({ where: { email: email.toLowerCase() }, transaction });
  };

  static createUserWithCollective = async (userData, transaction = undefined) => {
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
      type: types.USER,
      name: collectiveName,
      legalName: userData.legalName,
      image: userData.image,
      description: userData.description,
      longDescription: userData.longDescription,
      website: userData.website,
      twitterHandle: userData.twitterHandle,
      githubHandle: userData.githubHandle,
      repositoryUrl: userData.repositoryUrl,
      currency: userData.currency,
      hostFeePercent: userData.hostFeePercent,
      isActive: false,
      isHostAccount: Boolean(userData.isHostAccount),
      CreatedByUserId: userData.CreatedByUserId || user.id,
      data: { UserId: user.id },
      settings: userData.settings,
    };
    user.collective = await models.Collective.create(userCollectiveData, sequelizeParams);

    if (userData.location) {
      await user.collective.setLocation(userData.location);
    }

    // It's difficult to predict when the image will be updated by findImageForUser
    // So we skip that in test environment to make it more predictable
    if (!['ci', 'test'].includes(config.env)) {
      user.collective.findImageForUser(user);
    }
    user.CollectiveId = user.collective.id;
    await user.save(sequelizeParams);
    return user;
  };

  static splitName = name => {
    let firstName = null,
      lastName = null;
    if (name) {
      const tokens = name.split(' ');
      firstName = tokens[0];
      lastName = tokens.length > 1 ? tokens.slice(1).join(' ') : null;
    }
    return { firstName, lastName };
  };

  // Getters
  // Collective of type USER corresponding to this user
  // @deprecated use user.getCollective()
  get userCollective(): NonAttribute<Promise<Collective | Record<string, never>>> {
    return models.Collective.findByPk(this.CollectiveId).then(userCollective => {
      if (!userCollective) {
        logger.info(`No Collective attached to this user id ${this.id} (User.CollectiveId: ${this.CollectiveId})`);
        return {};
      }
      return userCollective;
    });
  }

  get hasTwoFactorAuthentication(): NonAttribute<boolean> {
    return this.twoFactorAuthToken !== null;
  }

  // @deprecated
  get name(): NonAttribute<Promise<string>> {
    return this.userCollective.then(c => c.name);
  }

  // @deprecated
  get twitterHandle(): NonAttribute<Promise<string>> {
    return this.userCollective.then(c => c.twitterHandle);
  }

  // @deprecated
  get githubHandle(): NonAttribute<Promise<string>> {
    return this.userCollective.then(c => c.githubHandle);
  }

  // @deprecated
  get repositoryUrl(): NonAttribute<Promise<string>> {
    return this.userCollective.then(c => c.repositoryUrl);
  }

  // @deprecated
  get website(): NonAttribute<Promise<string>> {
    return this.userCollective.then(c => c.website);
  }

  // @deprecated
  get description(): NonAttribute<Promise<string>> {
    return this.userCollective.then(c => c.description);
  }

  // @deprecated
  get longDescription(): NonAttribute<Promise<string>> {
    return this.userCollective.then(c => c.longDescription);
  }

  // @deprecated
  get image(): NonAttribute<Promise<string>> {
    return this.userCollective.then(c => c.image);
  }

  // Info (private).
  public get info(): NonAttribute<Partial<User>> {
    return {
      id: this.id,
      email: this.email,
      emailWaitingForValidation: this.emailWaitingForValidation,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }

  // Show (to any other user).
  public get show(): NonAttribute<Partial<User>> {
    return {
      id: this.id,
      CollectiveId: this.CollectiveId,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }

  public get minimal(): NonAttribute<{ id: number; email: string }> {
    return {
      id: this.id,
      email: this.email,
    };
  }

  // Used for the public collective
  public get public(): NonAttribute<{ id: number }> {
    return {
      id: this.id,
    };
  }
}

User.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },

    CollectiveId: {
      type: DataTypes.INTEGER,
      references: { model: 'Collectives', key: 'id' },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
    },

    email: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
      set(val: string) {
        if (val && val.toLowerCase) {
          this._emailChanged = true;
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
          if (
            this.emailChanged &&
            isEmailBurner(val.toLowerCase()) &&
            !emailLib.isAuthorizedEmailDomain(val.toLowerCase())
          ) {
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
      set(val: string) {
        if (val && val.toLowerCase) {
          this._emailWaitingForValidationChanged = true;
          this.setDataValue('emailWaitingForValidation', val.toLowerCase());
        } else if (val === null) {
          this.setDataValue('emailWaitingForValidation', null);
        }
      },
      validate: {
        isEmail: {
          msg: 'Email must be valid',
        },
        isBurnerEmail: function (val) {
          if (
            this.emailWaitingForValidationChanged &&
            isEmailBurner(val.toLowerCase()) &&
            !emailLib.isAuthorizedEmailDomain(val.toLowerCase())
          ) {
            throw new Error(
              'This email provider is not allowed on Open Collective. If you think that it should be, please email us at support@opencollective.com.',
            );
          }
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

    passwordHash: {
      type: DataTypes.STRING,
      allowNull: true,
    },

    passwordUpdatedAt: {
      type: DataTypes.DATE,
    },
  },
  {
    sequelize,
    paranoid: true,
  },
);

Temporal(User, sequelize);

export default User;
