import bcrypt from 'bcrypt';
import { isEmailBurner } from 'burner-email-providers';
import config from 'config';
import debugLib from 'debug';
import slugify from 'limax';
import { defaults, get, intersection, isEmpty, pick, uniq } from 'lodash';
import { CreationOptional, InferAttributes, InferCreationAttributes, NonAttribute } from 'sequelize';
import Temporal from 'sequelize-temporal';

import activities from '../constants/activities';
import { CollectiveType } from '../constants/collectives';
import { Service } from '../constants/connected-account';
import FEATURE from '../constants/feature';
import OrderStatuses from '../constants/order-status';
import PlatformConstants from '../constants/platform';
import MemberRoles from '../constants/roles';
import * as auth from '../lib/auth';
import emailLib from '../lib/email';
import logger from '../lib/logger';
import sequelize, { DataTypes, Model, Op } from '../lib/sequelize';
import twoFactorAuthLib from '../lib/two-factor-authentication';
import { isValidEmail, parseToBoolean } from '../lib/utils';

import Activity from './Activity';
import Collective from './Collective';
import ConnectedAccount from './ConnectedAccount';
import Member from './Member';
import Order from './Order';

const debug = debugLib('models:User');

type UserData = {
  creationRequest?: { ip: string };
  lastSignInRequest?: { ip: string };
  features?: Record<FEATURE, boolean>;
  limits?: {
    draftExpenses?: 'bypass';
  };
};

class User extends Model<InferAttributes<User>, InferCreationAttributes<User>> {
  declare public readonly id: CreationOptional<number>;
  declare public email: string;
  declare public emailWaitingForValidation: CreationOptional<string>;
  declare public emailConfirmationToken: CreationOptional<string>;
  /**
   * @deprecated use `UserTwoFactorAuthMethod`
   */
  declare public twoFactorAuthToken: CreationOptional<string>;
  /**
   * @deprecated use `UserTwoFactorAuthMethod`
   */
  declare public yubikeyDeviceId: CreationOptional<string>;
  declare public twoFactorAuthRecoveryCodes: CreationOptional<string[]>;
  declare public CollectiveId: number;
  declare public newsletterOptIn: boolean;
  declare public data: CreationOptional<Record<string, unknown> & UserData>;
  declare public createdAt: CreationOptional<Date>;
  declare public changelogViewDate: CreationOptional<Date>;
  declare public updatedAt: CreationOptional<Date>;
  declare public deletedAt: CreationOptional<Date>;
  declare public confirmedAt: CreationOptional<Date>;
  declare public lastLoginAt: CreationOptional<Date>;
  declare public passwordHash: CreationOptional<string>;
  declare public passwordUpdatedAt: CreationOptional<Date>;

  // TODO: We should ideally rely on this.changed(...)
  public _emailChanged?: NonAttribute<boolean>;
  public _emailWaitingForValidationChanged?: NonAttribute<boolean>;

  // Associations
  declare public collective?: Collective;

  // Non-model attributes
  public rolesByCollectiveId?: NonAttribute<Record<string, MemberRoles[]>>;

  /** Instance Methods */

  /**
   * Generate a JWT for user.
   *
   * @param {object} `payload` - data to attach to the token
   * @param {Number} `expiration` - expiration period in seconds
   */
  jwt = function (payload = undefined, expiration = undefined) {
    expiration = expiration || auth.TOKEN_EXPIRATION_LOGIN;
    payload = payload || {};
    payload.email = this.email; // Include email to easily invalidate all token types when email change
    return auth.createJwt(this.id, payload, expiration);
  };

  generateSessionToken = async function ({
    sessionId = null,
    createActivity = true,
    updateLastLoginAt = false,
    expiration = null,
    req = null,
  } = {}) {
    if (createActivity && !parseToBoolean(config.database.readOnly)) {
      await Activity.create({
        type: activities.USER_SIGNIN,
        UserId: this.id,
        FromCollectiveId: this.CollectiveId,
        CollectiveId: this.CollectiveId,
        data: { notify: false },
      });
    }

    if (updateLastLoginAt && req && !parseToBoolean(config.database.readOnly)) {
      await this.update({
        // The login was accepted, we can update lastLoginAt. This will invalidate all older login tokens.
        lastLoginAt: new Date(),
        data: { ...this.data, lastSignInRequest: { ip: req.ip, userAgent: req.header('user-agent') } },
      });
    }

    return this.jwt({ scope: 'session', sessionId }, expiration || auth.TOKEN_EXPIRATION_SESSION);
  };

  generateLoginLink = function (redirect = '/', websiteUrl) {
    const lastLoginAt = this.lastLoginAt ? this.lastLoginAt.getTime() : null;
    const token = this.jwt({ scope: 'login', lastLoginAt }, auth.TOKEN_EXPIRATION_LOGIN);
    // if a different websiteUrl is passed
    // we don't accept that in production or staging to avoid fishing related issues
    if (websiteUrl && !['production', 'staging'].includes(config.env)) {
      return `${websiteUrl}/signin/${token}?next=${redirect}`;
    } else {
      return `${config.host.website}/signin/${token}?next=${redirect}`;
    }
  };

  generateResetPasswordLink = function ({ websiteUrl = null } = {}) {
    const passwordUpdatedAt = this.passwordUpdatedAt ? this.passwordUpdatedAt.getTime() : null;
    const token = this.jwt(
      { scope: 'reset-password', passwordUpdatedAt, email: this.email },
      auth.TOKEN_EXPIRATION_RESET_PASSWORD,
    );

    // if a different websiteUrl is passed
    // we don't accept that in production to avoid fishing related issues
    if (websiteUrl && !['production', 'staging'].includes(config.env)) {
      return `${websiteUrl}/reset-password/${token}`;
    } else {
      return `${config.host.website}/reset-password/${token}`;
    }
  };

  setPassword = async function (password, { userToken = null } = {}) {
    const passwordBuffer = Buffer.from(password);
    if (passwordBuffer.length > 72) {
      throw new Error('Password is too long, should not be more than 72 bytes.');
    } else if (passwordBuffer.length < 6) {
      throw new Error('Password must be at least 6 characters long.');
    }

    const passwordHash = await bcrypt.hash(password, /* saltRounds */ 10);

    await this.update({ passwordHash, passwordUpdatedAt: new Date() });

    await Activity.create({
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
    return Member.findAll(query);
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
    const memberships = await Member.findAll({ where });
    memberships.map(m => {
      rolesByCollectiveId[m.CollectiveId] = rolesByCollectiveId[m.CollectiveId] || [];
      rolesByCollectiveId[m.CollectiveId].push(m.role);
      if (m.role === MemberRoles.ADMIN) {
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

  hasRoleInCollectiveOrHost = function (roles, collective) {
    if (!collective) {
      return false;
    } else {
      const collectiveIds = [collective.id];
      if (collective.HostCollectiveId) {
        collectiveIds.push(collective.HostCollectiveId);
      }
      if (collective.type === 'EVENT' || collective.type === 'PROJECT' || collective.type === 'VENDOR') {
        collectiveIds.push(collective.ParentCollectiveId);
      }

      return collectiveIds.some(collectiveId => this.hasRole(roles, collectiveId));
    }
  };

  getAdministratedCollectiveIds = function (): Array<number> {
    if (!this.rolesByCollectiveId) {
      logger.info("User.rolesByCollectiveId hasn't been populated.");
      logger.debug(new Error().stack);
      return [];
    } else {
      return uniq([
        this.CollectiveId,
        ...Object.keys(this.rolesByCollectiveId)
          .filter(CollectiveId => this.rolesByCollectiveId[CollectiveId].includes(MemberRoles.ADMIN))
          .map(Number),
      ]);
    }
  };

  // Adding some sugars
  isAdmin = function (CollectiveId: number | string) {
    const result =
      this.CollectiveId === Number(CollectiveId) || this.hasRole([MemberRoles.HOST, MemberRoles.ADMIN], CollectiveId);
    debug('isAdmin of CollectiveId', CollectiveId, '?', result);
    return result;
  };

  // Slightly better API than the former
  isAdminOfCollective = function (collective) {
    if (!collective) {
      return false;
    } else if (collective.type === 'EVENT' || collective.type === 'PROJECT' || collective.type === 'VENDOR') {
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

  isCommunityManager = function (collective: Collective) {
    if (!collective) {
      return false;
    } else if (collective.type === 'EVENT' || collective.type === 'PROJECT') {
      return (
        this.hasRole(MemberRoles.COMMUNITY_MANAGER, collective.id) ||
        this.hasRole([MemberRoles.COMMUNITY_MANAGER], collective.ParentCollectiveId)
      );
    } else {
      return this.hasRole(MemberRoles.COMMUNITY_MANAGER, collective.id);
    }
  };

  isAdminOfPlatform = function (): boolean {
    if (config.env === 'production') {
      return this.hasRole([MemberRoles.ADMIN], PlatformConstants.PlatformCollectiveId);
    } else {
      // In other envs (especially tests), we may still rely on the legacy OC Inc account set with ID 1
      return (
        this.hasRole([MemberRoles.ADMIN], 1) ||
        this.hasRole([MemberRoles.ADMIN], PlatformConstants.PlatformCollectiveId)
      );
    }
  };

  isAdminOfAnyPlatformAccount = function (): boolean {
    return PlatformConstants.AllPlatformCollectiveIds.some(id => this.hasRole([MemberRoles.ADMIN], id));
  };

  isRoot = function (): boolean {
    return Boolean(this.isAdminOfPlatform() && this.data?.isRoot);
  };

  isMember = function (CollectiveId) {
    const result =
      this.CollectiveId === CollectiveId ||
      this.hasRole([MemberRoles.HOST, MemberRoles.ADMIN, MemberRoles.MEMBER], CollectiveId);
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
  limitFeature = async function (feature, reason) {
    const features = get(this.data, 'features', {});
    const limitReasons = get(this.data, 'limitReasons') || [];

    features[feature] = false;
    limitReasons.push({ date: new Date().toISOString(), feature, reason });

    logger.info(`Limiting feature ${feature} for user account ${this.id}`);

    this.changed('data', true);
    this.data = { ...this.data, features, limitReasons };
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
    const count = await Order.count({
      where: { CreatedByUserId: this.id, status: OrderStatuses.DISPUTED },
    });
    return count > 0;
  };

  getLastKnownIp = function (): string {
    return this.data?.lastSignInRequest?.ip || this.data?.creationRequest?.ip;
  };

  findRelatedUsersByIp = async function ({ include = undefined, where = null } = {}) {
    const ip = this.getLastKnownIp();
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
    const connectedAccounts = await ConnectedAccount.findAll({
      where: {
        CollectiveId: this.CollectiveId,
        service: { [Op.in]: [Service.GITHUB, Service.PAYPAL] },
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
          model: Collective,
          as: 'collective',
          required: true,
          include: [
            {
              model: ConnectedAccount,
              where: { [Op.or]: connectedAccounts.map(ca => pick(ca, ['service', 'username'])) },
              required: true,
            },
          ],
        },
      ],
    });
  };

  getCollective = async function ({ loaders = null } = {}): Promise<Collective> {
    if (this.CollectiveId) {
      const collective = loaders
        ? await loaders.Collective.byId.load(this.CollectiveId)
        : await Collective.findByPk(this.CollectiveId);
      if (collective) {
        return collective;
      }
    }
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
      user => user || User.createUserWithCollective(Object.assign({}, { email }, otherAttributes)),
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
      type: CollectiveType.USER,
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
    user.collective = await Collective.create(userCollectiveData, sequelizeParams);

    if (userData.location) {
      await user.collective.setLocation(userData.location, transaction);
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

  hasTwoFactorAuthentication(): NonAttribute<Promise<boolean>> {
    return twoFactorAuthLib.userHasTwoFactorAuthEnabled(this);
  }

  // @deprecated
  get name(): NonAttribute<Promise<string>> {
    return this.getCollective().then(c => c.name);
  }

  // @deprecated
  get twitterHandle(): NonAttribute<Promise<string>> {
    return this.getCollective().then(c => c.twitterHandle);
  }

  // @deprecated
  get githubHandle(): NonAttribute<Promise<string>> {
    return this.getCollective().then(c => c.githubHandle);
  }

  // @deprecated
  get repositoryUrl(): NonAttribute<Promise<string>> {
    return this.getCollective().then(c => c.repositoryUrl);
  }

  // @deprecated
  get website(): NonAttribute<Promise<string>> {
    return this.getCollective().then(c => c.website);
  }

  // @deprecated
  get description(): NonAttribute<Promise<string>> {
    return this.getCollective().then(c => c.description);
  }

  // @deprecated
  get longDescription(): NonAttribute<Promise<string>> {
    return this.getCollective().then(c => c.longDescription);
  }

  // @deprecated
  get image(): NonAttribute<Promise<string>> {
    return this.getCollective().then(c => c.image);
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

    yubikeyDeviceId: {
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
