import assert from 'assert';

import { TaxType } from '@opencollective/taxes';
import Promise from 'bluebird';
import config from 'config';
import debugLib from 'debug';
import deepmerge from 'deepmerge';
import * as ics from 'ics';
import slugify from 'limax';
import {
  cloneDeep,
  defaults,
  difference,
  differenceBy,
  differenceWith,
  get,
  includes,
  isNull,
  isUndefined,
  omit,
  pick,
  round,
  set,
  sum,
  sumBy,
  trim,
  unset,
} from 'lodash';
import moment from 'moment';
import fetch from 'node-fetch';
import prependHttp from 'prepend-http';
import {
  CreationOptional,
  FindOptions,
  HasManyGetAssociationsMixin,
  HasOneGetAssociationMixin,
  InferAttributes,
  InferCreationAttributes,
  Model,
  NonAttribute,
} from 'sequelize';
import Temporal from 'sequelize-temporal';
import { v4 as uuid } from 'uuid';
import validator from 'validator';

import activities from '../constants/activities';
import { CollectiveTypesList, types } from '../constants/collectives';
import { Service } from '../constants/connected_account';
import expenseStatus from '../constants/expense_status';
import expenseTypes from '../constants/expense_type';
import FEATURE from '../constants/feature';
import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../constants/paymentMethods';
import plans from '../constants/plans';
import POLICIES from '../constants/policies';
import roles, { MemberRoleLabels } from '../constants/roles';
import { hasOptedOutOfFeature, isFeatureAllowedForCollectiveType } from '../lib/allowed-features';
import {
  getBalanceAmount,
  getContributionsAndContributorsCount,
  getTotalAmountPaidExpenses,
  getTotalAmountReceivedAmount,
  getTotalAmountReceivedTimeSeries,
  getTotalAmountSpentAmount,
  getTotalMoneyManagedAmount,
  getYearlyBudgetAmount,
} from '../lib/budget';
import { purgeCacheForCollective } from '../lib/cache';
import {
  collectiveSlugReservedList,
  filterCollectiveSettings,
  getCollectiveAvatarUrl,
  isCollectiveSlugReserved,
  validateSettings,
} from '../lib/collectivelib';
import { invalidateContributorsCache } from '../lib/contributors';
import { getFxRate } from '../lib/currency';
import emailLib from '../lib/email';
import { formatAddress } from '../lib/format-address';
import { getGithubHandleFromUrl, getGithubUrlFromHandle } from '../lib/github';
import {
  getHostFees,
  getHostFeeShare,
  getPendingHostFeeShare,
  getPendingPlatformTips,
  getPlatformTips,
} from '../lib/host-metrics';
import { isValidUploadedImage } from '../lib/images';
import { mustUpdateLocation } from '../lib/location';
import logger from '../lib/logger';
import { getPolicy } from '../lib/policies';
import queries from '../lib/queries';
import { buildSanitizerOptions, sanitizeHTML, stripHTML } from '../lib/sanitize-html';
import { reportErrorToSentry, reportMessageToSentry } from '../lib/sentry';
import sequelize, { DataTypes, Op, Sequelize, Transaction } from '../lib/sequelize';
import { collectiveSpamCheck, notifyTeamAboutSuspiciousCollective } from '../lib/spam';
import { sanitizeTags, validateTags } from '../lib/tags';
import { canUseFeature } from '../lib/user-permissions';
import userlib from '../lib/userlib';
import { capitalize, formatCurrency, getDomain, md5 } from '../lib/utils';
import { Location as LocationType } from '../types/Location';

import ConnectedAccount from './ConnectedAccount';
import CustomDataTypes from './DataTypes';
import { HostApplicationStatus } from './HostApplication';
import LegalDocument from './LegalDocument';
import Location from './Location';
import Order from './Order';
import { PayoutMethodTypes } from './PayoutMethod';
import SocialLink, { SocialLinkType } from './SocialLink';

const debug = debugLib('models:Collective');

type Goal = {
  type: string;
  amount: number;
};

type Settings = {
  goals?: Array<Goal>;
  features?: {
    contactForm?: boolean;
  };
  transferwise?: {
    ignorePaymentProcessorFees?: boolean;
  };
  virtualcards?: {
    reminder?: boolean;
    autopause?: boolean;
  };
};

const defaultTiers = currency => {
  return [
    {
      type: 'TIER',
      name: 'backer',
      slug: 'backers',
      amount: 500,
      presets: [500, 1000, 2500, 5000],
      interval: 'month',
      currency: currency,
      minimumAmount: 500,
      amountType: 'FLEXIBLE',
    },
    {
      type: 'TIER',
      name: 'sponsor',
      slug: 'sponsors',
      amount: 10000,
      presets: [10000, 25000, 50000],
      interval: 'month',
      currency: currency,
      minimumAmount: 10000,
      amountType: 'FLEXIBLE',
    },
  ];
};

const policiesSanitizeOptions = buildSanitizerOptions({
  basicTextFormatting: true,
  multilineTextFormatting: true,
  links: true,
});

const longDescriptionSanitizerOptions = buildSanitizerOptions({
  titles: true,
  basicTextFormatting: true,
  multilineTextFormatting: true,
  imagesInternal: true,
  links: true,
  videoIframes: true,
});

const customMessageSanitizeOptions = buildSanitizerOptions({
  titles: true,
  basicTextFormatting: true,
  multilineTextFormatting: true,
  images: true,
  links: true,
});

const sanitizeSettingsValue = value => {
  if (value?.customEmailMessage) {
    value.customEmailMessage = sanitizeHTML(value.customEmailMessage, customMessageSanitizeOptions);
  }
  return value;
};

const { models } = sequelize;

class Collective extends Model<
  InferAttributes<
    Collective,
    { omit: 'info' | 'previewImage' | 'cards' | 'invoice' | 'minimal' | 'activity' | 'searchIndex' }
  >,
  InferCreationAttributes<Collective>
> {
  public declare id: number;
  public declare type: types;
  public declare slug: string;
  public declare name: string;
  public declare legalName: string;
  public declare company: string;

  public declare CreatedByUserId: number;
  public declare LastEditedByUserId: number;
  public declare ParentCollectiveId: number;
  public declare HostCollectiveId: number;

  public declare hostFeePercent: number;
  public declare platformFeePercent: number;
  public declare description: string;
  public declare longDescription: string;
  public declare expensePolicy: string;
  public declare contributionPolicy: string;
  public declare currency: string;
  public declare image: string;
  public declare backgroundImage: string;
  public declare countryISO: string;
  public declare settings: Settings;
  public declare isPledged: boolean;
  public declare data: any;
  public declare startsAt: Date;
  public declare endsAt: Date;
  public declare timezone: string;
  public declare isActive: boolean;
  public declare isIncognito: boolean;
  public declare approvedAt: Date;
  public declare twitterHandle: string;
  public declare githubHandle: string;
  public declare repositoryUrl: string;
  public declare website: string;
  public declare publicUrl: string;
  public declare tags: Array<string>;
  public declare monthlySpending: number;
  public declare deactivatedAt: Date;
  public declare isHostAccount: boolean;
  public declare plan: string;

  public declare createdAt: CreationOptional<Date>;
  public declare updatedAt: CreationOptional<Date>;
  public declare deletedAt?: CreationOptional<Date>;

  public declare host?: NonAttribute<Collective>;

  public declare members?: NonAttribute<Array<typeof models.Member>>;
  public declare getMembers: HasManyGetAssociationsMixin<typeof models.Member>;

  public declare legalDocuments?: NonAttribute<LegalDocument[]>;

  public declare getConnectedAccounts: HasManyGetAssociationsMixin<ConnectedAccount>;

  public declare getLocation: HasOneGetAssociationMixin<Location>;
  public declare location?: LocationType;

  public declare parent?: NonAttribute<Collective>;
  public declare children?: NonAttribute<Collective[]>;

  static async createOrganization(collectiveData, adminUser, creator) {
    const CreatedByUserId = creator?.id || adminUser.id;
    const collective = await Collective.create({
      CreatedByUserId,
      ...collectiveData,
      type: types.ORGANIZATION,
      isActive: true,
    });
    await models.Member.create({
      CreatedByUserId,
      CollectiveId: collective.id,
      MemberCollectiveId: adminUser.CollectiveId,
      role: roles.ADMIN,
    });
    await collective.generateCollectiveCreatedActivity(creator || adminUser, null, { collective: collective.info });
    return collective;
  }

  static createMany = (collectives, defaultValues, sequelizeParams) => {
    return Promise.map(collectives, u => Collective.create(defaults({}, u, defaultValues), sequelizeParams), {
      concurrency: 1,
    }).catch(error => {
      logger.error(error);
      reportErrorToSentry(error);
    });
  };

  static getTopBackers = async (since, until, tags, limit) => {
    const backers = await queries.getTopBackers(since || 0, until || new Date(), tags, limit || 5);
    debug(
      'getTopBackers',
      backers.map(b => b.dataValues),
    );
    return backers;
  };

  static getHostCollectiveId = async CollectiveId => {
    const res = await models.Member.findOne({
      attributes: ['MemberCollectiveId'],
      where: { CollectiveId, role: roles.HOST },
    });
    return res && res.MemberCollectiveId;
  };

  /*
   * Generates best unique slug by checking a base slug and adding a count if it is reserved/non-unique.
   * If multiple suggestions are provided, the first non-null suggestion is used as the base.
   *
   * @param [array] suggestions Array of suggested base slugs in order of priority.
   */
  static generateSlug = (suggestions, useSlugify = true) => {
    /*
     * Checks a given slug against existing and reserved slugs. Increments count if non-unique/reserved and
     * recursively checks again until acceptable slug is found.
     */
    const slugSuggestionHelper = (slugToCheck, slugList, count) => {
      const slug = count > 0 ? `${slugToCheck}${count}` : slugToCheck;
      if (slugList.indexOf(slug) === -1 && !isCollectiveSlugReserved(slug)) {
        return slug;
      } else {
        return slugSuggestionHelper(`${slugToCheck}`, slugList, count + 1);
      }
    };

    suggestions = suggestions.filter(slug => (slug ? true : false)); // filter out any nulls
    let baseSlug = suggestions[0]; // Use the first non-null suggestion as the base

    if (useSlugify) {
      baseSlug = slugify(baseSlug); // Will also trim, lowercase and remove + signs
    }

    // fetch any existing slugs which match or start with baseSlug. Used as list for helper function.
    return models.Collective.findAll({
      attributes: ['slug'],
      where: { slug: { [Op.startsWith]: baseSlug } },
      paranoid: false,
      raw: true,
    })
      .then(userObjectList => userObjectList.map(user => user.slug))
      .then(slugList => slugSuggestionHelper(baseSlug, slugList, 0));
  };

  static findBySlug = (slug, options = {}, throwIfMissing = true) => {
    if (!slug || slug.length < 1) {
      return Promise.resolve(null);
    }
    return Collective.findOne({
      where: { slug: slug.toLowerCase() },
      ...options,
    }).then(collective => {
      if (!collective && throwIfMissing) {
        throw new Error(`No collective found with slug ${slug}`);
      }
      return collective;
    });
  };

  get previewImage() {
    if (!this.image) {
      return null;
    }

    const cloudinaryBaseUrl = 'https://res.cloudinary.com/opencollective/image/fetch';

    const format = this.image.match(/\.png$/) ? 'png' : 'jpg';

    const queryurl =
      this.type === 'USER'
        ? '/c_thumb,g_face,h_48,r_max,w_48,bo_3px_solid_white/c_thumb,h_48,r_max,w_48,bo_2px_solid_rgb:66C71A/e_trim'
        : '/h_96,c_fill';

    return `${cloudinaryBaseUrl}${queryurl}/f_${format}/${encodeURIComponent(this.image)}`;
  }

  get info() {
    return {
      id: this.id,
      name: this.name,
      description: this.description,
      longDescription: this.longDescription,
      currency: this.currency,
      image: this.image,
      previewImage: this.previewImage,
      data: this.data,
      backgroundImage: this.backgroundImage,
      startsAt: this.startsAt,
      endsAt: this.endsAt,
      timezone: this.timezone,
      status: (this as any).status,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      isActive: this.isActive,
      isHostAccount: this.isHostAccount,
      slug: this.slug,
      tiers: (this as any).tiers,
      type: this.type,
      settings: this.settings,
      website: this.website,
      twitterHandle: this.twitterHandle,
      githubHandle: this.githubHandle,
      repositoryUrl: this.repositoryUrl,
      publicUrl: this.publicUrl,
      hostFeePercent: this.hostFeePercent,
      platformFeePercent: this.platformFeePercent,
      tags: this.tags,
      HostCollectiveId: this.HostCollectiveId,
    };
  }

  get cards() {
    return {
      id: this.id,
      createdAt: this.createdAt,
      name: this.name,
      slug: this.slug,
      image: this.image,
      backgroundImage: this.backgroundImage,
      publicUrl: this.publicUrl,
      description: this.description,
      settings: this.settings,
      currency: this.currency,
    };
  }

  get invoice() {
    // TODO: Not used?
    return {
      id: this.id,
      createdAt: this.createdAt,
      name: this.name,
      slug: this.slug,
      image: this.image,
      backgroundImage: this.backgroundImage,
      publicUrl: this.publicUrl,
      description: this.description,
      settings: this.settings,
      currency: this.currency,
    };
  }

  get minimal() {
    return {
      id: this.id,
      type: this.type,
      name: this.name,
      image: this.image,
      slug: this.slug,
      isIncognito: this.isIncognito,
      twitterHandle: this.twitterHandle,
      githubHandle: this.githubHandle,
      repositoryUrl: this.repositoryUrl,
      publicUrl: this.publicUrl,
    };
  }

  get activity() {
    return {
      id: this.id,
      type: this.type,
      slug: this.slug,
      name: this.name,
      company: this.company,
      website: this.website,
      isIncognito: this.isIncognito,
      twitterHandle: this.twitterHandle,
      githubHandle: this.githubHandle,
      repositoryUrl: this.repositoryUrl,
      description: this.description,
      previewImage: this.previewImage,
    };
  }

  get searchIndex() {
    // TODO: Not used?
    return {
      id: this.id,
      name: this.name,
      description: this.description,
      currency: this.currency,
      slug: this.slug,
      type: this.type,
      tags: this.tags,
      balance: (this as any).balance, // useful in ranking
      yearlyBudget: (this as any).yearlyBudget,
      backersCount: (this as any).backersCount,
    };
  }

  /**
   * Instance Methods
   */

  /**
   * Returns the next goal with the progress and how much is missing (as one-time or monthly donation)
   * Used for the monthly reports to backers
   */
  getNextGoal = async function (until) {
    const goals = <Array<Goal>>get(this, 'settings.goals');
    if (!goals) {
      return null;
    }
    const stats: { balance?: number; yearlyBudget?: number } = {};
    goals.sort((a, b) => {
      if (a.amount < b.amount) {
        return -1;
      } else {
        return 1;
      }
    });

    let nextGoal;
    await Promise.each(goals, async goal => {
      if (nextGoal) {
        return;
      }
      if (goal.type === 'balance') {
        if (!stats.balance) {
          stats.balance = await this.getBalance({ endDate: until });
        }
        if (stats.balance < goal.amount) {
          nextGoal = goal;
          nextGoal.progress = Math.round((stats.balance / goal.amount) * 100) / 100;
          nextGoal.percentage = `${Math.round(nextGoal.progress * 100)}%`;
          nextGoal.missing = { amount: goal.amount - stats.balance };
          return;
        }
      }
      if (goal.type === 'yearlyBudget') {
        if (!stats.yearlyBudget) {
          stats.yearlyBudget = await this.getYearlyBudget();
        }
        if (stats.yearlyBudget < goal.amount) {
          nextGoal = goal;
          nextGoal.progress = Math.round((stats.yearlyBudget / goal.amount) * 100) / 100;
          nextGoal.percentage = `${Math.round(nextGoal.progress * 100)}%`;
          nextGoal.missing = {
            amount: Math.round((goal.amount - stats.yearlyBudget) / 12),
            interval: 'month',
          };
          nextGoal.interval = 'year';
          return;
        }
      }
    });
    return nextGoal;
  };

  updateSocialLinks = async function (socialLinks) {
    if (socialLinks.length > 10) {
      throw new Error('account cannot set more than 10 social links');
    }

    if (socialLinks.length === 0) {
      await models.SocialLink.destroy({
        where: {
          CollectiveId: this.id,
        },
      });
      return [];
    }

    return await sequelize.transaction(async transaction => {
      const existingLinks = await SocialLink.findAll({
        where: {
          CollectiveId: this.id,
        },
        transaction,
        lock: true,
      });

      const isSameLink = (link1: SocialLink, link2: SocialLink) => link1.url === link2.url && link1.type === link2.type;
      const removedLinks = differenceWith(existingLinks, socialLinks, isSameLink);

      if (removedLinks.length !== 0) {
        await models.SocialLink.destroy({
          where: {
            CollectiveId: this.id,
            [Op.and]: {
              [Op.or]: removedLinks.map(rl => ({
                url: rl.url,
                type: rl.type,
              })),
            },
          },
          transaction,
        });
      }

      const updatedSocialLinks = await models.SocialLink.bulkCreate(
        socialLinks.map((socialLink, order) => ({
          url: socialLink.url,
          type: socialLink.type,
          CollectiveId: this.id,
          order,
        })),
        {
          updateOnDuplicate: ['order'],
          transaction,
        },
      );

      // updates deprecated collective fields with social links until references to these fields are migrated.
      const collectiveFields: {
        twitterHandle?: string;
        githubHandle?: string;
        website?: string;
        repositoryUrl?: string;
      } = {};

      const twitterSocialLink = updatedSocialLinks.find(sl => sl.type === SocialLinkType.TWITTER);
      if (twitterSocialLink && twitterSocialLink.url) {
        const match = twitterSocialLink.url.match(/https:\/\/twitter.com\/([^/]*)[/]?$/);
        if (match && match.length === 2) {
          collectiveFields.twitterHandle = match[1];
        }
      }

      const githubSocialLink = updatedSocialLinks.find(sl => sl.type === SocialLinkType.GITHUB);
      if (githubSocialLink && githubSocialLink.url) {
        collectiveFields.githubHandle = getGithubHandleFromUrl(githubSocialLink.url);
      }

      const websiteSocialLink = updatedSocialLinks.find(sl => sl.type === SocialLinkType.WEBSITE);
      if (websiteSocialLink && websiteSocialLink.url) {
        collectiveFields.website = websiteSocialLink.url;
      }

      const repositorySocialLink = updatedSocialLinks.find(sl =>
        [SocialLinkType.GIT, SocialLinkType.GITHUB, SocialLinkType.GITLAB].includes(sl.type),
      );
      if (repositorySocialLink && repositorySocialLink.url) {
        collectiveFields.repositoryUrl = repositorySocialLink.url;
      }

      await this.update(
        {
          ...collectiveFields,
        },
        {
          transaction,
        },
      );

      return updatedSocialLinks;
    });
  };

  getParentCollective = async function (options = undefined) {
    if (!this.ParentCollectiveId) {
      return null;
    } else if (options) {
      return models.Collective.findByPk(this.ParentCollectiveId, options);
    } else if (this.parentCollective) {
      return this.parentCollective;
    } else {
      this.parentCollective = await models.Collective.findByPk(this.ParentCollectiveId);
      return this.parentCollective;
    }
  };

  getICS = function () {
    if (this.type !== 'EVENT') {
      throw new Error('Can only generate ICS for collectives of type EVENT');
    }
    return new Promise(resolve => {
      return this.getParentCollective().then(async parentCollective => {
        const url = `${config.host.website}/${parentCollective.slug}/events/${this.slug}`;
        const startDate = new Date(this.startsAt);
        const endDate = new Date(this.endsAt);
        const start: ics.DateArray = [
          startDate.getFullYear(),
          startDate.getMonth() + 1,
          startDate.getDate(),
          startDate.getHours(),
          startDate.getMinutes(),
        ];
        const end: ics.DateArray = [
          endDate.getFullYear(),
          endDate.getMonth() + 1,
          endDate.getDate(),
          endDate.getHours(),
          endDate.getMinutes(),
        ];

        // Build description as HTML
        const descriptionParts = [this.description, this.longDescription].filter(Boolean);
        if (this.data?.privateInstructions) {
          descriptionParts.push(`Private instructions:\n${stripHTML(this.data.privateInstructions)}`);
        }

        const location = await this.getLocation();
        let locationString = location?.name || '';
        if (location?.address) {
          locationString += `, ${location.address}`;
        }
        if (location?.country) {
          locationString += `, ${location.country}`;
        }
        const alarms: Array<ics.Alarm> = [
          {
            action: 'audio',
            trigger: { hours: 24, minutes: 0, before: true },
            repeat: 2,
            attachType: 'VALUE=URI',
            attach: 'Glass',
          },
          {
            action: 'audio',
            trigger: { hours: 72, minutes: 0, before: true },
            repeat: 2,
            attachType: 'VALUE=URI',
            attach: 'Glass',
          },
        ];
        const event: ics.EventAttributes = {
          title: this.name,
          description: descriptionParts.join('\n\n'),
          start,
          end,
          location: locationString,
          url,
          status: 'CONFIRMED',
          organizer: {
            name: parentCollective.name,
            email: `no-reply@opencollective.com`,
          },
          alarms,
        };
        if (location?.lat) {
          event.geo = { lat: location.lat, lon: location.long };
        }
        ics.createEvent(event, (err, res) => {
          if (err) {
            logger.error(`Error while generating the ics file for event id ${this.id} (${url})`, err);
            reportErrorToSentry(err, { extra: { eventId: this.id, url } });
          }
          return resolve(res);
        });
      });
    });
  };

  // If no image has been provided, try to find an image using clearbit and save it
  findImage = function (force = false) {
    if (this.getDataValue('image')) {
      return;
    }

    if (this.type === 'ORGANIZATION' && this.website && !this.website.match(/^https:\/\/twitter\.com\//)) {
      const image = `https://logo.clearbit.com/${getDomain(this.website)}`;
      return this.checkAndUpdateImage(image, force);
    }

    return Promise.resolve();
  };

  // If no image has been provided, try to find an image using gravatar and save it
  findImageForUser = function (user, force = false) {
    if (this.getDataValue('image')) {
      return;
    }

    if (this.type === 'USER') {
      if (user && user.email && this.name && this.name !== 'incognito') {
        const emailHash = md5(user.email.toLowerCase().trim());
        const avatar = `https://www.gravatar.com/avatar/${emailHash}?default=404`;
        return this.checkAndUpdateImage(avatar, force);
      }
    }

    return Promise.resolve();
  };

  /**
   * Returns the incognito member for this collective (or null if none exists).
   * Be careful: the link between an account and the incognito profile is a private information.
   */
  getIncognitoMember = async function ({ transaction }: { transaction?: Transaction } = {}) {
    return models.Member.findOne({
      transaction,
      where: {
        [this.isIncognito ? 'CollectiveId' : 'MemberCollectiveId']: this.id,
        role: roles.ADMIN,
      },
      include: [
        { association: 'memberCollective', required: true, where: { type: types.USER, isIncognito: false } },
        { association: 'collective', required: true, where: { type: types.USER, isIncognito: true } },
      ],
    });
  };

  /**
   * Returns the incognito profile for this collective (or null if none exists).
   * Be careful: the link between an account and the incognito profile is a private information.
   */
  getIncognitoProfile = async function ({ transaction }: { transaction?: Transaction } = {}) {
    if (this.type !== types.USER) {
      return null;
    } else if (this.isIncognito) {
      return this;
    } else {
      const incognitoMember = await this.getIncognitoMember({ transaction });
      return incognitoMember?.collective || null;
    }
  };

  /**
   * Returns the incognito profile for this collective, creating it if necessary
   */
  getOrCreateIncognitoProfile = async function ({ transaction }: { transaction?: Transaction } = {}) {
    if (this.type !== types.USER) {
      throw new Error(`Incognito profiles can only be created for users (not ${this.type})`);
    }

    // Always run in a transaction (we manually start one below if not provided)
    const getOrCreateIncognitoProfileInTransaction = async transaction => {
      const existingProfile = await this.getIncognitoProfile({ transaction });
      if (existingProfile) {
        return existingProfile;
      }

      const user = await this.getUser({ transaction }); // Ideally we should store the user that created the profile (can be a root admin), but User.getIncognitoProfile relies on this
      const account = await models.Collective.create(
        {
          name: 'Incognito',
          currency: this.currency,
          type: types.USER,
          isIncognito: true,
          settings: null,
          CreatedByUserId: user.id,
        },
        { transaction },
      );

      await models.Member.create(
        {
          MemberCollectiveId: user.CollectiveId,
          CollectiveId: account.id,
          role: roles.ADMIN,
          CreatedByUserId: user.id,
        },
        { transaction },
      );

      return account;
    };

    if (transaction) {
      return getOrCreateIncognitoProfileInTransaction(transaction);
    } else {
      return sequelize.transaction(getOrCreateIncognitoProfileInTransaction);
    }
  };

  // Save image it if it returns 200
  checkAndUpdateImage = async function (image, force = false) {
    if (force || !['e2e', 'ci', 'test'].includes(process.env.OC_ENV)) {
      try {
        const response = await fetch(image);
        if (response.status !== 200) {
          throw new Error(`status=${response.status}`);
        }
        const body = await response.text();
        if (body.length === 0) {
          throw new Error(`length=0`);
        }
        return this.update({ image });
      } catch (err) {
        logger.info(`collective.checkAndUpdateImage: Unable to fetch ${image} (${err.message})`);
      }
    }
  };

  // run when attaching a Stripe Account to this user/organization collective
  // this Payment Method will be used for "Add Funds"
  becomeHost = async function () {
    if (!['USER', 'ORGANIZATION', 'COLLECTIVE'].includes(this.type)) {
      throw new Error('This account type cannot become a host');
    } else if (this.HostCollectiveId && this.HostCollectiveId !== this.id) {
      throw new Error('This account is already attached to another host, please remove host first');
    }

    if (!this.isHostAccount) {
      const updatedValues = {
        isHostAccount: true,
        plan: 'start-plan-2021',
        hostFeePercent: undefined,
        platformFeePercent: undefined,
      };
      // hostFeePercent and platformFeePercent are not supposed to be set at this point
      // but we're dealing with legacy tests here
      if (this.hostFeePercent === null) {
        updatedValues.hostFeePercent = config.fees.default.hostPercent;
      }
      if (this.platformFeePercent === null) {
        updatedValues.platformFeePercent = config.fees.default.platformPercent;
      }
      await this.update(updatedValues);
    }

    await this.getOrCreateHostPaymentMethod();

    if (this.type === 'ORGANIZATION' || this.type === 'USER') {
      await models.Activity.create({
        type: activities.ACTIVATED_COLLECTIVE_AS_HOST,
        CollectiveId: this.id,
        FromCollectiveId: this.id,
        data: { collective: this.info },
      });
    } else if (this.type === types.COLLECTIVE) {
      await models.Activity.create({
        type: activities.ACTIVATED_COLLECTIVE_AS_INDEPENDENT,
        CollectiveId: this.id,
        FromCollectiveId: this.id,
        data: { collective: this.info },
      });
    }

    await this.activateBudget();

    return this;
  };

  getOrCreateHostPaymentMethod = async function () {
    const hostPaymentMethod = await models.PaymentMethod.findOne({
      where: { service: 'opencollective', type: 'host', CollectiveId: this.id, currency: this.currency },
    });

    if (hostPaymentMethod) {
      return hostPaymentMethod;
    }

    return models.PaymentMethod.create({
      CollectiveId: this.id,
      service: 'opencollective',
      type: 'host',
      name: `${this.name} (Host)`,
      primary: true,
      currency: this.currency,
    });
  };

  /**
   * If the collective is a host, it needs to remove existing hosted collectives before
   * deactivating it as a host.
   */
  deactivateAsHost = async function () {
    const hostedCollectives = await this.getHostedCollectivesCount();
    if (hostedCollectives >= 1) {
      throw new Error(
        `You can't deactivate hosting while still hosting ${hostedCollectives} other collectives. Please contact support: support@opencollective.com.`,
      );
    }

    // Make sure we clean up all pending applications
    await models.HostApplication.update(
      { status: HostApplicationStatus.EXPIRED },
      { where: { HostCollectiveId: this.id } },
    );

    await models.Member.destroy({ where: { MemberCollectiveId: this.id, role: 'HOST' } });

    await models.Collective.update(
      { HostCollectiveId: null },
      { hooks: false, where: { HostCollectiveId: this.id, isActive: false } },
    );

    // TODO unsubscribe from OpenCollective tier plan.

    await this.deactivateBudget();

    const settings = { ...this.settings };
    unset(settings, 'paymentMethods.manual');

    await this.update({ isHostAccount: false, plan: null, settings });

    await models.PayoutMethod.destroy({
      where: {
        data: { isManualBankTransfer: true },
        CollectiveId: this.id,
      },
    });

    await models.ConnectedAccount.destroy({
      where: {
        service: 'stripe',
        CollectiveId: this.id,
      },
    });

    await models.Activity.create({
      type: activities.DEACTIVATED_COLLECTIVE_AS_HOST,
      CollectiveId: this.id,
      FromCollectiveId: this.id,
      data: { collective: this.info },
    });

    return this;
  };

  enableFeature = async function (feature, { transaction }: { transaction?: Transaction } = {}) {
    assert(FEATURE[feature], `Feature ${feature} is not supported`);

    const children = await this.getChildren({ transaction });
    const processCollective = account =>
      account.update({ data: omit(cloneDeep(account.data || {}), `features.${feature}`) }, { transaction });

    return Promise.all([this, ...children].map(processCollective));
  };

  disableFeature = async function (feature, { transaction }: { transaction?: Transaction } = {}) {
    assert(FEATURE[feature], `Feature ${feature} is not supported`);

    const children = await this.getChildren({ transaction });
    const processCollective = account =>
      account.update({ data: set(cloneDeep(account.data || {}), `features.${feature}`, false) }, { transaction });

    return Promise.all([this, ...children].map(processCollective));
  };

  freeze = async function (message) {
    if (this.data?.features?.[FEATURE.ALL] === false) {
      throw new Error('This account is already frozen');
    }

    const host = this.host || (await this.getHostCollective());
    await sequelize.transaction(async transaction => {
      await this.disableFeature(FEATURE.ALL, { transaction });

      // Create the notification
      await models.Activity.create(
        {
          type: activities.COLLECTIVE_FROZEN,
          CollectiveId: this.id,
          HostCollectiveId: host.id,
          data: { collective: this.info, host: host.info, message },
        },
        { transaction },
      );
    });
  };

  unfreeze = async function (message) {
    if (this.data?.features?.[FEATURE.ALL] !== false) {
      throw new Error('This account is already unfrozen');
    }

    const host = this.host || (await this.getHostCollective());
    await sequelize.transaction(async transaction => {
      await this.enableFeature(FEATURE.ALL, { transaction });

      await models.Activity.create(
        {
          type: activities.COLLECTIVE_UNFROZEN,
          CollectiveId: this.id,
          HostCollectiveId: host.id,
          data: { collective: this.info, host: host.info, message },
        },
        { transaction },
      );
    });
  };

  hasBudget = function () {
    if ([types.COLLECTIVE, types.EVENT, types.PROJECT, types.FUND].includes(this.type)) {
      return true;
    } else if (this.type === types.ORGANIZATION) {
      return this.isHostAccount && this.isActive;
    } else {
      return false;
    }
  };

  /**
   * Activate Budget (so the "Host Organization" can receive financial contributions and manage expenses)
   */
  activateBudget = async function () {
    if (!this.isHostAccount || ![types.ORGANIZATION].includes(this.type) || this.HostCollectiveId !== this.id) {
      return;
    }

    await this.update({
      isActive: true,
      HostCollectiveId: this.id,
      settings: { ...this.settings, hostCollective: { id: this.id } },
      approvedAt: new Date(),
    });

    await models.PaymentMethod.destroy({
      where: {
        CollectiveId: this.id,
        service: 'opencollective',
        type: 'collective',
      },
    });

    await models.PaymentMethod.create({
      CollectiveId: this.id,
      service: 'opencollective',
      type: 'collective',
      name: `${capitalize(this.name)} (${capitalize(this.type.toLowerCase())})`,
      primary: true,
      currency: this.currency,
    });

    return this;
  };

  /**
   * Deactivate Budget
   */
  deactivateBudget = async function () {
    await this.update({
      isActive: false,
      HostCollectiveId: null,
      settings: omit(this.settings, ['hostCollective']),
      approvedAt: null,
    });

    await models.Member.destroy({
      where: {
        role: roles.HOST,
        MemberCollectiveId: this.id,
        CollectiveId: this.id,
      },
    });

    await models.PaymentMethod.destroy({
      where: {
        CollectiveId: this.id,
        service: 'opencollective',
        type: 'collective',
      },
    });

    return this;
  };

  /**
   * Returns true if Collective is a host account open to applications.
   */
  canApply = async function () {
    return Boolean(this.isHostAccount && this.settings?.apply);
  };

  /**
   * Returns true if the collective can be used as a payout profile for an expense
   */
  canBeUsedAsPayoutProfile = function () {
    return !this.isIncognito;
  };

  /**
   *  Checks if the collective can be contacted.
   */
  canContact = async function () {
    if (!this.isActive) {
      return false;
    } else if (hasOptedOutOfFeature(this, FEATURE.CONTACT_FORM)) {
      return false;
    } else {
      return isFeatureAllowedForCollectiveType(this.type, FEATURE.CONTACT_FORM) || (await this.isHost());
    }
  };

  /**
   * Checks if the has been approved by a host.
   * This function will throw if you try to call it with an event, as you should check the
   * `isApproved` of the `parentCollective` instead.
   */
  isApproved = function () {
    if (this.type === types.EVENT) {
      throw new Error("isApproved must be called on event's parent collective");
    } else if (this.id === this.HostCollectiveId) {
      return true;
    } else {
      return Boolean(this.HostCollectiveId && this.isActive && this.approvedAt);
    }
  };

  // This is quite ugly, and only needed for events.
  // I'd argue that we should store the event slug as `${parentCollectiveSlug}/events/${eventSlug}`
  getUrlPath = async function () {
    if (this.type === types.EVENT || this.type === types.PROJECT) {
      const parent = await this.getParentCollective({ attributes: ['id', 'slug'] });
      const pathType = {
        [types.EVENT]: 'events',
        [types.PROJECT]: 'projects',
      };
      if (!parent) {
        logger.error(`${this.type} (${this.id}) with an invalid parent (${this.ParentCollectiveId}).`);
        reportMessageToSentry('Event/project has invalid parent', { extra: { collective: this.info } });
        return `/collective/${pathType[this.type]}/${this.slug}`;
      }
      return `/${parent.slug}/${pathType[this.type]}/${this.slug}`;
    } else {
      return `/${this.slug}`;
    }
  };

  // Returns the User model of the User that created this collective
  getUser = async function (queryParams = undefined) {
    if (this.type === types.USER) {
      return models.User.findOne({ where: { CollectiveId: this.id }, ...queryParams });
    } else {
      return null;
    }
  };

  getAdmins = async function () {
    const members = await models.Member.findAll({
      where: {
        CollectiveId: this.id,
        role: roles.ADMIN,
      },
      include: [{ model: models.Collective, as: 'memberCollective' }],
    });
    return members.map(member => member.memberCollective);
  };

  getMemberships = async function ({ role }: { role?: string } = {}) {
    const members = await models.Member.findAll({
      where: {
        MemberCollectiveId: this.id,
        role: role,
      },
      include: [{ model: models.Collective, as: 'collective' }],
    });
    return members.map(member => member.collective);
  };

  /**
   * Get the admin users { id, email } of this collective
   *
   */
  getAdminUsers = async function ({
    collectiveAttributes,
    paranoid = true,
  }: {
    collectiveAttributes?: any;
    paranoid?: boolean;
  } = {}) {
    if (this.type === 'USER' && !this.isIncognito) {
      // Incognito profiles rely on the `Members` entry to know which user it belongs to
      return [
        await this.getUser({
          paranoid,
          include: !isUndefined(collectiveAttributes)
            ? [{ association: 'collective', required: true, attributes: collectiveAttributes }]
            : [],
        }),
      ];
    } else {
      return this.getMembersUsers({
        CollectiveId: ['EVENT', 'PROJECT'].includes(this.type) ? this.ParentCollectiveId : this.id,
        role: roles.ADMIN,
        collectiveAttributes,
        paranoid,
      });
    }
  };

  /**
   * Returns all the users that are members of this collective for the given roles
   * If a collective profile (COLLECTIVE, ORGANIZATION, etc) matches the given roles,
   * nothing is returned for them.
   */
  getMembersUsers = async function ({
    CollectiveId = this.id,
    role = [],
    collectiveAttributes = [], // Don't include the member collective by default. Pass `null` to fetch all attributes.
    paranoid = true,
  } = {}) {
    return models.User.findAll({
      group: ['User.id', 'collective.id'],
      order: [['id', 'ASC']], // Not needed, but it's always nice to have a consistent order (e.g. for tests)
      paranoid,
      include: [
        {
          association: 'collective',
          required: true,
          attributes: collectiveAttributes,
          paranoid,
          include: [
            {
              association: 'memberships',
              required: true,
              attributes: [],
              paranoid,
              where: { CollectiveId, role },
            },
          ],
        },
      ],
    });
  };

  getChildren = function (query: FindOptions<any> = {}) {
    return Collective.findAll({
      order: [
        ['createdAt', 'DESC'],
        ['id', 'DESC'],
      ],
      ...query,
      where: { ...query.where, ParentCollectiveId: this.id },
    });
  };

  getEvents = function (query: FindOptions<any> = {}) {
    return this.getChildren({
      order: [
        ['startsAt', 'DESC'],
        ['endsAt', 'DESC'],
        ['id', 'DESC'],
      ],
      ...query,
      where: { ...query.where, type: types.EVENT },
    });
  };

  getProjects = function (query: FindOptions<any> = {}) {
    return this.getChildren({
      ...query,
      order: [
        ['deactivatedAt', 'DESC'], // Will put active projects first, ordering the others by deactivation date
        ['createdAt', 'DESC'],
        ['id', 'DESC'],
      ],
      where: { ...query.where, type: types.PROJECT },
    });
  };

  /**
   * Return stats about backers based on the Members table
   *  - stats.backers.lastMonth: number of backers by endDate
   *  - stats.backers.previousMonth: number of backers by startDate
   *  - stats.backers.new: the number of backers whose first donation was after startDate
   */
  getBackersStats = function (startDate, endDate) {
    const getBackersUntil = until =>
      models.Member.count({
        where: {
          CollectiveId: this.id,
          role: roles.BACKER,
          createdAt: { [Op.lt]: until },
        },
      });

    return Promise.all([getBackersUntil(startDate), getBackersUntil(endDate)]).then(results => {
      return {
        backers: {
          lastMonth: results[1],
          previousMonth: results[0],
          new: results[1] - results[0],
        },
      };
    });
  };

  /**
   * Get new orders in last time period
   * @param {*} startDate beginning of the time period
   * @param {*} endDate end of the time period
   */
  getNewOrders = async function (startDate = 0, endDate = new Date(), where = {}) {
    const orders = await models.Order.findAll({
      where: {
        CollectiveId: this.id,
        FromCollectiveId: { [Op.ne]: this.id },
        createdAt: { [Op.gte]: startDate, [Op.lt]: endDate },
        ...where,
      },
      paranoid: false,
      include: [{ model: models.Collective, as: 'fromCollective' }, { model: models.Tier }],
    });
    orders.sort((a, b) => {
      if (a.dataValues.totalAmount > b.dataValues.totalAmount) {
        return -1;
      } else {
        return 1;
      }
    });

    // Prepare objects to consumption in templates
    return orders.map(order => ({
      ...order.info,
      fromCollective: order.fromCollective.info,
      Tier: order.Tier ? order.Tier.info : null,
    }));
  };

  /**
   * Get orders whose subscription was cancelled during last time period
   * @param {*} startDate beginning of the time period
   * @param {*} endDate end of the time period
   */
  getCancelledOrders = async function (startDate = 0, endDate = new Date()) {
    let orders = <Array<any>>await models.Order.findAll({
      where: {
        CollectiveId: this.id,
      },
      include: [
        {
          model: models.Subscription,
          required: true,
          where: {
            deactivatedAt: { [Op.gte]: startDate, [Op.lt]: endDate },
          },
        },
        {
          model: models.Collective,
          as: 'fromCollective',
        },
        {
          model: models.Tier,
        },
      ],
    });

    orders = await Promise.map(orders, async order => {
      order.totalTransactions = await order.getTotalTransactions();
      return order;
    });

    orders.sort((a, b) => {
      if (a.dataValues.totalAmount > b.dataValues.totalAmount) {
        return -1;
      } else {
        return 1;
      }
    });

    // Prepare objects to consumption in templates
    return orders.map(order => ({
      ...order.info,
      fromCollective: order.fromCollective.info,
      Tier: order.Tier ? order.Tier.info : null,
      totalTransactions: order.totalTransactions,
    }));
  };

  /**
   * Get the total number of backers (individuals or organizations that have given money to the collective)
   * @params: { type, since, until }
   * type: COLLECTIVE/USER/ORGANIZATION or an array of types
   * until: date till when to count the number of backers
   */
  getBackersCount = function (options: any = {}) {
    const query = <any>{
      attributes: [[Sequelize.fn('COUNT', Sequelize.fn('DISTINCT', Sequelize.col('FromCollectiveId'))), 'count']],
      where: {
        CollectiveId: this.id,
        FromCollectiveId: { [Op.ne]: this.HostCollectiveId },
        type: 'CREDIT',
      },
    };

    if (options.since) {
      query.where.createdAt = query.where.createdAt || {};
      query.where.createdAt[Op.gte] = options.since;
    }
    if (options.until) {
      query.where.createdAt = query.where.createdAt || {};
      query.where.createdAt[Op.lt] = options.until;
    }

    if (options.type) {
      const types = typeof options.type === 'string' ? [options.type] : options.type;
      query.include = [
        {
          model: models.Collective,
          as: 'fromCollective',
          attributes: [],
          required: true,
          where: { type: { [Op.in]: types } },
        },
      ];
      query.raw = true; // need this otherwise it automatically also fetches Transaction.id which messes up everything
    }

    let method;
    if (options.group) {
      query.attributes.push('fromCollective.type');
      query.include = [
        {
          model: models.Collective,
          as: 'fromCollective',
          attributes: [],
          required: true,
        },
      ];
      query.raw = true; // need this otherwise it automatically also fetches Transaction.id which messes up everything
      query.group = options.group;
      method = 'findAll';
    } else {
      method = 'findOne';
    }

    return models.Transaction[method](query).then(res => {
      if (options.group) {
        const stats = { id: this.id, all: undefined };
        let all = 0;
        // when it's a raw query, the result is not in dataValues
        res.forEach(r => {
          stats[r.type] = r.count;
          all += r.count;
        });
        stats.all = all;
        debug('getBackersCount', stats);
        return stats;
      } else {
        const result = res.dataValues || res || {};
        debug('getBackersCount', result);
        if (!result.count) {
          return 0;
        }
        return Promise.resolve(Number(result.count));
      }
    });
  };

  getIncomingOrders = function (options) {
    const query = deepmerge(
      {
        where: { CollectiveId: this.id },
      },
      options,
      { clone: false },
    );
    return models.Order.findAll(query);
  };

  getOutgoingOrders = function (options) {
    const query = deepmerge(
      {
        where: { FromCollectiveId: this.id },
      },
      options,
      { clone: false },
    );
    return models.Order.findAll(query);
  };

  getRoleForMemberCollective = function (MemberCollectiveId) {
    if (!MemberCollectiveId) {
      return null;
    }
    return models.Member.findOne({
      where: { MemberCollectiveId, CollectiveId: this.id },
    }).then(member => member.role);
  };

  /**
   * returns the tiers with their users
   * e.g. collective.tiers = [
   *  { name: 'core contributor', users: [ {UserObject} ], range: [], ... },
   *  { name: 'backer', users: [ {UserObject}, {UserObject} ], range: [], ... }
   * ]
   */
  getTiersWithUsers = async function (
    options = {
      active: false,
      attributes: ['id', 'username', 'image', 'firstDonation', 'lastDonation', 'totalDonations', 'website'],
    },
  ) {
    const tiersById = {};

    // Get the list of tiers for the collective (including deleted ones)
    const tiers = await models.Tier.findAll({ where: { CollectiveId: this.id }, paranoid: false });
    for (const tier of tiers) {
      tiersById[tier.id] = tier;
    }

    const backerCollectives = <Array<any>>(
      await queries.getMembersWithTotalDonations({ CollectiveId: this.id, role: 'BACKER' }, options)
    );

    // Map the users to their respective tier
    await Promise.map(backerCollectives, backerCollective => {
      const include = options.active ? [{ model: models.Subscription, attributes: ['isActive'] }] : [];
      return models.Order.findOne({
        attributes: ['TierId'],
        where: {
          FromCollectiveId: backerCollective.id,
          CollectiveId: this.id,
          TierId: { [Op.ne]: null },
        },
        include,
      }).then(order => {
        if (!order) {
          debug('Collective.getTiersWithUsers: no order for a tier for ', {
            FromCollectiveId: backerCollective.id,
            CollectiveId: this.id,
          });
          return null;
        }
        const TierId = order.TierId;
        tiersById[TierId] = tiersById[TierId] || order.Tier;
        if (!tiersById[TierId]) {
          logger.error(">>> Couldn't find a tier with id", order.TierId, 'collective: ', this.slug);
          tiersById[TierId] = { dataValues: { users: [] } };
        }
        tiersById[TierId].dataValues.users = tiersById[TierId].dataValues.users || [];
        if (options.active) {
          backerCollective.isActive = order.Subscription.isActive;
        }
        debug('adding to tier', TierId, 'backer: ', backerCollective.dataValues.slug);
        tiersById[TierId].dataValues.users.push(backerCollective.dataValues);
      });
    });

    return Object.values(tiersById);
  };

  /**
   * Get the Tier object of a user
   * @param {*} user
   */
  getBackerTier = function (backerCollective) {
    if (backerCollective.role && backerCollective.role !== 'BACKER') {
      return backerCollective;
    }
    return models.Order.findOne({
      where: {
        FromCollectiveId: backerCollective.id,
        CollectiveId: this.id,
      },
      include: [{ model: models.Tier }],
    }).then(order => order && order.Tier);
  };

  /**
   * Add User to the Collective
   * @post Member( { CreatedByUserId: user.id, MemberCollectiveId: user.CollectiveId, CollectiveId: this.id })
   * @param {*} user { id, CollectiveId }
   * @param {*} role
   * @param {*} defaultAttributes
   */
  addUserWithRole = async function (
    user,
    role,
    defaultAttributes: { TierId?: any } = {},
    context: {
      skipActivity?: any;
    } = {},
    transaction = undefined,
  ) {
    if (role === roles.HOST) {
      return logger.info('Please use Collective.addHost(hostCollective, remoteUser);');
    }

    const sequelizeParams = transaction ? { transaction } : undefined;

    const memberAttributes = {
      role,
      CreatedByUserId: user.id,
      MemberCollectiveId: user.CollectiveId,
      CollectiveId: this.id,
      ...defaultAttributes,
    };

    const existingMember = await models.Member.findOne({
      where: {
        role,
        MemberCollectiveId: user.CollectiveId,
        CollectiveId: this.id,
        TierId: defaultAttributes?.TierId || null,
      },
    });

    if (existingMember) {
      return existingMember;
    }

    debug('addUserWithRole', user.id, role, 'member', memberAttributes);

    const member = await models.Member.create(memberAttributes, sequelizeParams);

    switch (role) {
      case roles.BACKER:
      case roles.ATTENDEE:
        if (!context.skipActivity) {
          await this.createMemberCreatedActivity(member, user, context, sequelizeParams);
        }
        break;

      case roles.MEMBER:
      case roles.ACCOUNTANT:
      case roles.ADMIN: {
        if (![types.FUND, types.PROJECT, types.EVENT].includes(this.type)) {
          await this.sendNewMemberEmail(user, role, member, sequelizeParams);
        }

        // Sanitization: Clean memberships of children collectives
        const children = await this.getChildren();
        if (children.length > 0) {
          await models.Member.destroy({
            where: {
              MemberCollectiveId: user.CollectiveId,
              CollectiveId: children.map(c => c.id),
              role,
            },
          });
        }

        break;
      }
    }

    return member;
  };

  createMemberCreatedActivity = async function (member, user, context, sequelizeParams) {
    // We refetch to preserve historic behavior and make sure it's up to date
    let order;
    if (context.order) {
      order = await models.Order.findOne(
        {
          where: { id: context.order.id },
          include: [{ model: models.Tier }, { model: models.Subscription }],
        },
        sequelizeParams,
      );
    }

    const urlPath = await this.getUrlPath();
    const memberCollective = await models.Collective.findByPk(member.MemberCollectiveId, sequelizeParams);

    let memberCollectiveUser;
    if (memberCollective.type === types.USER && !memberCollective.isIncognito) {
      memberCollectiveUser = await models.User.findOne({ where: { CollectiveId: memberCollective.id } });
    }

    const data = {
      collective: { ...this.minimal, urlPath },
      member: {
        ...member.info,
        memberCollective: memberCollective.activity,
        memberCollectiveUser: memberCollectiveUser ? memberCollectiveUser.info : undefined,
      },
      order: order && {
        ...order.info,
        tier: order.Tier && order.Tier.minimal,
        subscription: {
          interval: order.Subscription && order.Subscription.interval,
        },
      },
    };

    return models.Activity.create(
      {
        type: activities.COLLECTIVE_MEMBER_CREATED,
        FromCollectiveId: memberCollective.id,
        HostCollectiveId: this.approvedAt ? this.HostCollectiveId : null,
        UserId: user.id,
        CollectiveId: this.id,
        data,
      },
      sequelizeParams,
    );
  };

  sendNewMemberEmail = async function (user, role, member, sequelizeParams) {
    const remoteUser = await models.User.findByPk(
      member.CreatedByUserId,
      { include: [{ model: models.Collective, as: 'collective' }] },
      sequelizeParams,
    );

    const memberUser = await models.User.findByPk(
      user.id,
      { include: [{ model: models.Collective, as: 'collective' }] },
      sequelizeParams,
    );

    // We don't notify if the new member is the logged in user
    if (get(remoteUser, 'collective.id') === get(memberUser, 'collective.id')) {
      return;
    }

    // We only send the notification for new member for role MEMBER and ADMIN
    const lowercaseType = this.type.toLowerCase();
    const template = lowercaseType === 'organization' ? 'organization.newmember' : 'collective.newmember';
    return emailLib.send(
      template,
      memberUser.email,
      {
        remoteUser: {
          email: remoteUser.email,
          collective: pick(remoteUser.collective, ['slug', 'name', 'image']),
        },
        role: MemberRoleLabels[role] || role.toLowerCase(),
        isAdmin: role === roles.ADMIN,
        collective: {
          slug: this.slug,
          name: this.name,
          type: lowercaseType,
        },
        recipient: {
          collective: memberUser.collective.activity,
        },
      },
      { bcc: remoteUser.email },
    );
  };

  /**
   * Used when creating a transactin to add a user to the collective as a backer if needed.
   * A new membership is registered for each `defaultAttributes.TierId`.
   */
  findOrAddUserWithRole = function (user, role, defaultAttributes, context, transaction) {
    return models.Member.findOne({
      where: {
        role,
        MemberCollectiveId: user.CollectiveId,
        CollectiveId: this.id,
        TierId: get(defaultAttributes, 'TierId', null),
      },
    }).then(Member => {
      if (!Member) {
        return this.addUserWithRole(user, role, defaultAttributes, context, transaction);
      } else {
        return Member;
      }
    });
  };

  /**
   * Get Hosted Collectives
   *
   * It's expected that child Collectives like EVENTS are returned
   */
  getHostedCollectives = async function (queryParams = {}) {
    return models.Collective.findAll({
      ...queryParams,
      where: { isActive: true, HostCollectiveId: this.id, approvedAt: { [Op.not]: null } },
    });
  };

  getHostedCollectiveAdmins = async function () {
    const adminMembersIds = await models.Member.findAll({
      where: { MemberCollectiveId: this.id, role: roles.HOST },
    }).then(async collectives => {
      const hostedCollectiveIds = collectives.map(c => c.CollectiveId);
      return models.Member.findAll({
        where: {
          CollectiveId: { [Op.in]: hostedCollectiveIds },
          role: roles.ADMIN,
        },
      }).then(admins => admins.map(a => a.MemberCollectiveId));
    });

    return models.User.findAll({ where: { CollectiveId: { [Op.in]: adminMembersIds } } });
  };

  setLocation = async function (locationInput: LocationType, transaction?: any) {
    const sequelizeParams = transaction ? { transaction } : undefined;

    const location = await this.getLocation();

    if (!mustUpdateLocation(location, locationInput)) {
      return;
    }

    const promises = [];

    if (location) {
      promises.push(location.destroy(sequelizeParams));
    }

    if (locationInput) {
      const { name, country, lat, long, structured } = locationInput;
      let { address } = locationInput;

      // Set Collective.countryISO
      this.countryISO = country;
      this.save();

      // Set formatted address
      if (!address) {
        address = await formatAddress({ structured, country });
      }

      promises.push(
        models.Location.create(
          {
            CollectiveId: this.id,
            name: name || null,
            country: country || null,
            geoLocationLatLong: lat || long ? { type: 'Point', coordinates: [lat, long] } : null,
            address: address || null,
            structured,
          },
          sequelizeParams,
        ),
      );
    }

    await Promise.all(promises);
  };

  updateHostFee = async function (hostFeePercent, remoteUser) {
    if (typeof hostFeePercent === 'undefined' || !remoteUser || hostFeePercent === this.hostFeePercent) {
      return;
    }
    if ([types.COLLECTIVE, types.EVENT, types.FUND, types.PROJECT].includes(this.type)) {
      // only an admin of the host of the collective can edit `hostFeePercent` of a COLLECTIVE
      if (!remoteUser || !remoteUser.isAdmin(this.HostCollectiveId)) {
        throw new Error('Only an admin of the host collective can edit the host fee for this collective');
      }
      return this.update({ hostFeePercent });
    } else {
      const isHost = await this.isHost();
      if (isHost) {
        if (!remoteUser.isAdmin(this.id)) {
          throw new Error('You must be an admin of this host to change the host fee');
        }

        await models.Collective.update(
          { hostFeePercent },
          {
            hooks: false,
            where: {
              HostCollectiveId: this.id,
              approvedAt: { [Op.not]: null },
              data: {
                useCustomHostFee: { [Op.not]: true },
              },
            },
          },
        );

        // Update host
        return this.update({ hostFeePercent });
      }
    }
    return this;
  };

  updatePlatformFee = async function (platformFeePercent, remoteUser) {
    if (typeof platformFeePercent === 'undefined' || !remoteUser || platformFeePercent === this.platformFeePercent) {
      return;
    }
    if ([types.COLLECTIVE, types.EVENT, types.FUND, types.PROJECT].includes(this.type)) {
      // only an admin of the host of the collective can edit `platformFeePercent` of a COLLECTIVE
      if (!remoteUser || !remoteUser.isAdmin(this.HostCollectiveId)) {
        throw new Error('Only an admin of the host collective can edit the host fee for this collective');
      }
      return this.update({ platformFeePercent });
    } else {
      const isHost = await this.isHost();
      if (isHost) {
        if (!remoteUser.isAdmin(this.id)) {
          throw new Error('You must be an admin of this host to change the platform fee');
        }

        await models.Collective.update(
          { platformFeePercent },
          {
            hooks: false,
            where: {
              HostCollectiveId: this.id,
              approvedAt: { [Op.not]: null },
              data: {
                useCustomPlatformFee: { [Op.not]: true },
              },
            },
          },
        );

        // Update host
        return this.update({ platformFeePercent });
      }
    }
    return this;
  };

  /**
   * Update the currency of a "Collective" row (account)
   *
   * This is a safe version that can only be used by Users and Organizations that are not hosts
   */
  updateCurrency = async function (currency, remoteUser) {
    if (typeof currency === 'undefined' || !remoteUser || !remoteUser.isAdmin(this.id)) {
      return this;
    }

    if ([types.COLLECTIVE, types.FUND].includes(this.type) && this.isActive) {
      throw new Error(
        `Active Collectives or Funds can't edit their currency. Contact support@opencollective.com if it's an issue.`,
      );
    }

    const isHost = await this.isHost();
    if (isHost) {
      throw new Error(`Fiscal Hosts can't edit their currency. Contact support@opencollective.com if it's an issue.`);
    }

    return this.setCurrency(currency);
  };

  /**
   * Set the currency of a "Collective" row (account)
   *
   * This is meant to be used internally, no access control.
   */
  setCurrency = async function (currency) {
    if (currency === this.currency) {
      return this;
    }

    const isHost = await this.isHost();
    if (isHost) {
      // We only expect currency change at the beginning of the history of the Host
      // We're however good with it if currency is already recorded as hostCurrency in the ledger
      const transactionCount = await models.Transaction.count({
        where: { HostCollectiveId: this.id, hostCurrency: { [Op.not]: currency } },
      });
      if (transactionCount > 0) {
        throw new Error(
          'You cannot change the currency of an Host with transactions. Please contact support@opencollective.com.',
        );
      }
      let collectives = <Array<any>>await this.getHostedCollectives();
      collectives = collectives.filter(collective => collective.id !== this.id);
      // We use setCurrency so that it will cascade to Tiers
      if (collectives.length > 0) {
        await Promise.map(
          collectives,
          async collective => {
            const collectiveTransactionCount = await models.Transaction.count({
              where: { CollectiveId: collective.id },
            });
            // We only proceed with Collectives without Transactions
            if (collectiveTransactionCount === 0) {
              return collective.setCurrency(currency);
            }
          },
          { concurrency: 3 },
        );
      }
    }

    // What about transactions?
    // No, the currency should not matter, and for the Hosts it's forbidden to change currency

    // Update tiers, skip or delete when they are already used?
    const tiers = <Array<any>>await this.getTiers();
    if (tiers.length > 0) {
      await Promise.map(
        tiers,
        async tier => {
          // We only proceed with Tiers without Orders
          const orderCount = await models.Order.count({ where: { TierId: tier.id } });
          if (orderCount === 0) {
            return tier.setCurrency(currency);
          }
        },
        { concurrency: 3 },
      );
    }

    // Cascade currency to events and projects
    const events = <Array<any>>await this.getEvents();
    if (events.length > 0) {
      await Promise.map(events, event => event.setCurrency(currency), { concurrency: 3 });
    }
    const projects = <Array<any>>await this.getProjects();
    if (projects.length > 0) {
      await Promise.map(projects, project => project.setCurrency(currency), { concurrency: 3 });
    }

    return this.update({ currency });
  };

  /**
   * Add the host in the Members table and updates HostCollectiveId
   * @param {*} hostCollective instanceof models.Collective
   * @param {*} creatorUser { id } (optional, falls back to hostCollective.CreatedByUserId)
   * @param {object} [options] (optional, to peform specific actions)
   */
  addHost = async function (hostCollective, creatorUser, options = undefined) {
    if (this.HostCollectiveId) {
      throw new Error(`This collective already has a host (HostCollectiveId: ${this.HostCollectiveId})`);
    } else if (this.isHostAccount) {
      throw new Error(`This collective already is a host`);
    }

    const member = {
      role: roles.HOST,
      CreatedByUserId: creatorUser ? creatorUser.id : hostCollective.CreatedByUserId,
      MemberCollectiveId: hostCollective.id,
      CollectiveId: this.id,
    };

    let shouldAutomaticallyApprove = options?.shouldAutomaticallyApprove;

    // If not forced, let's check for cases where we can still safely automatically approve collective
    if (!shouldAutomaticallyApprove) {
      if (creatorUser.isAdmin(hostCollective.id)) {
        // If user is admin of the host, we can automatically approve
        shouldAutomaticallyApprove = true;
      } else if (this.ParentCollectiveId && creatorUser.isAdmin(this.ParentCollectiveId)) {
        // If there's a parent collective already approved by the host and user is admin of it, we can also approve
        const parentCollective = await models.Collective.findByPk(this.ParentCollectiveId);
        if (parentCollective && parentCollective.HostCollectiveId === hostCollective.id && parentCollective.isActive) {
          shouldAutomaticallyApprove = true;
        }
      }
    }

    // If we can't automatically approve the collective and it is not open to new applications, reject it
    if (!shouldAutomaticallyApprove && !hostCollective.canApply()) {
      throw new Error('This host is not open to applications');
    }

    const updatedValues = {
      HostCollectiveId: hostCollective.id,
      hostFeePercent: hostCollective.hostFeePercent,
      platformFeePercent: hostCollective.platformFeePercent,
      currency: undefined,
      ...(shouldAutomaticallyApprove ? { isActive: true, approvedAt: new Date() } : null),
    };

    // events should take the currency of their parent collective, not necessarily the one from their host.
    if ([types.COLLECTIVE, types.FUND].includes(this.type)) {
      updatedValues.currency = hostCollective.currency;
    }

    const promises = [models.Member.create(member), this.update(updatedValues)];

    // If collective does not have enough admins, block it from receiving contributions when automatically approving
    if (shouldAutomaticallyApprove) {
      const adminCount = await models.Member.count({
        where: {
          CollectiveId: this.id,
          role: roles.ADMIN,
        },
      });
      const policy = await getPolicy(hostCollective, POLICIES.COLLECTIVE_MINIMUM_ADMINS);
      if (policy?.freeze && policy.numberOfAdmins > adminCount) {
        promises.push(this.disableFeature(FEATURE.RECEIVE_FINANCIAL_CONTRIBUTIONS));
      }
    }

    // Invalidate current collective payment method if there's one
    await models.PaymentMethod.destroy({
      where: {
        CollectiveId: this.id,
        service: 'opencollective',
        type: 'collective',
      },
    });

    // Create the new payment method with host's currency
    if ([types.COLLECTIVE, types.FUND, types.EVENT, types.PROJECT].includes(this.type)) {
      promises.push(
        models.PaymentMethod.create({
          CollectiveId: this.id,
          service: 'opencollective',
          type: 'collective',
          name: `${capitalize(this.name)} (${capitalize(this.type.toLowerCase())})`,
          primary: true,
          currency: hostCollective.currency,
        }),
      );
    }

    if ([types.COLLECTIVE, types.FUND].includes(this.type)) {
      let tiers = await this.getTiers();
      if (!tiers || tiers.length === 0) {
        tiers = defaultTiers(hostCollective.currency);
        promises.push(models.Tier.createMany(tiers, { CollectiveId: this.id }));
      } else {
        // if the collective already had some tiers, we delete the ones that don't have the same currency
        // and we recreate new ones
        tiers.map(t => {
          if (t.currency !== hostCollective.currency) {
            const newTierData = omit(t.dataValues, ['id']);
            newTierData.currency = hostCollective.currency;
            promises.push(models.Tier.create(newTierData));
            promises.push(t.destroy());
          }
        });
      }
      if (!updatedValues.isActive) {
        if (!creatorUser.collective && creatorUser.getCollective) {
          creatorUser.collective = await creatorUser.getCollective();
        }
        const data = {
          host: pick(hostCollective, ['id', 'name', 'slug', 'hostFeePercent']),
          collective: pick(this, [
            'id',
            'slug',
            'name',
            'currency',
            'hostFeePercent',
            'description',
            'twitterHandle',
            'githubHandle',
            'website',
            'tags',
            'data',
            'settings',
          ]),
          user: {
            email: creatorUser.email,
            collective: pick(creatorUser.collective, [
              'id',
              'slug',
              'name',
              'website',
              'twitterHandle',
              'githubHandle',
              'repositoryUrl',
            ]),
          },
          application: {
            message: options?.message,
            customData: options?.applicationData,
          },
        };

        // Record application
        promises.push(
          models.HostApplication.recordApplication(hostCollective, this, creatorUser, {
            message: options?.message,
            customData: options?.applicationData,
          }),
        );

        if (!options?.skipCollectiveApplyActivity && !shouldAutomaticallyApprove) {
          promises.push(
            models.Activity.create({
              UserId: creatorUser.id,
              CollectiveId: this.id,
              HostCollectiveId: hostCollective.id,
              type: activities.COLLECTIVE_APPLY,
              data,
            }),
          );
        }
      }
    }

    await Promise.all(promises);

    // Cascade host update to events and projects
    // Passing platformFeePercent through options so we don't request the parent collective on every children update
    const events = await this.getEvents();
    if (events?.length > 0) {
      await Promise.all(
        events.map(e =>
          e.addHost(hostCollective, creatorUser, { platformFeePercent: updatedValues.platformFeePercent }),
        ),
      );
    }
    const projects = await this.getProjects();
    if (projects?.length > 0) {
      await Promise.all(
        projects.map(e =>
          e.addHost(hostCollective, creatorUser, { platformFeePercent: updatedValues.platformFeePercent }),
        ),
      );
    }

    return this;
  };

  /**
   * Change or remove host of the collective (only if balance === 0)
   * Note: when changing host, we also set the collective.isActive to false
   *       unless the remoteUser is an admin of the host
   * @param {*} newHostCollective: { id }
   * @param {*} remoteUser { id }
   */
  changeHost = async function (newHostCollectiveId, remoteUser = undefined, options = undefined) {
    // Skip
    if (this.HostCollectiveId === newHostCollectiveId) {
      return this;
    }

    const balance = await this.getBalance();
    if (balance > 0) {
      if (options?.isChildren) {
        throw new Error(
          `Unable to change host: your ${this.type.toLowerCase()} "${
            this.name
          }" still has a balance of ${formatCurrency(balance, this.currency)}`,
        );
      } else {
        throw new Error(`Unable to change host: you still have a balance of ${formatCurrency(balance, this.currency)}`);
      }
    }

    await models.Member.destroy({
      where: {
        CollectiveId: this.id,
        MemberCollectiveId: this.HostCollectiveId,
        role: roles.HOST,
      },
    });

    // Self Hosted Collective
    if (this.id === this.HostCollectiveId) {
      await models.ConnectedAccount.destroy({
        where: {
          service: 'stripe',
          CollectiveId: this.id,
        },
      });
    }

    await Order.cancelNonTransferableActiveOrdersByCollectiveId(this.id);

    const virtualCards = await models.VirtualCard.findAll({ where: { CollectiveId: this.id } });
    await Promise.all(virtualCards.map(virtualCard => virtualCard.delete()));

    // Prepare events and projects to receive a new host
    const events = await this.getEvents();
    if (events?.length > 0) {
      await Promise.all(events.map(e => e.changeHost(null, remoteUser, { isChildren: true })));
    }
    const projects = await this.getProjects();
    if (projects?.length > 0) {
      await Promise.all(projects.map(e => e.changeHost(null, remoteUser, { isChildren: true })));
    }

    // Reset current host
    await this.update({
      HostCollectiveId: null,
      isActive: false,
      approvedAt: null,
      hostFeePercent: null,
      platformFeePercent: null,
      isHostAccount: false,
      plan: null,
    });

    // Add new host
    if (newHostCollectiveId) {
      const newHostCollective = await models.Collective.findByPk(newHostCollectiveId);
      if (!newHostCollective) {
        throw new Error('Host not found');
      } else if (!newHostCollective.isHostAccount) {
        if (remoteUser.isAdminOfCollective(newHostCollective)) {
          await newHostCollective.becomeHost();
        } else {
          throw new Error(`You need to be an admin of ${newHostCollective.name} to turn it into a host`);
        }
      }
      return this.addHost(newHostCollective, remoteUser, {
        message: options?.message,
        applicationData: options?.applicationData,
        shouldAutomaticallyApprove: options?.shouldAutomaticallyApprove,
      });
    }
  };

  // edit the list of members and admins of this collective (create/update/remove)
  // creates a User and a UserCollective if needed
  editMembers = async function (members, defaultAttributes: { remoteUserCollectiveId?: any } = {}) {
    if (!members || members.length === 0) {
      return null;
    }

    if (members.filter(m => m.role === roles.ADMIN).length === 0) {
      throw new Error('There must be at least one admin for the account');
    }

    const allowedRoles = [roles.ADMIN, roles.MEMBER, roles.ACCOUNTANT];

    // Ensure only ADMIN and MEMBER roles are used here
    members.forEach(member => {
      if (!allowedRoles.includes(member.role)) {
        throw new Error(`Cant edit or create membership with role ${member.role}`);
      }
    });

    // Load existing data
    const [oldMembers, oldInvitations] = <[Array<any>, Array<any>]>await Promise.all([
      this.getMembers({ where: { role: { [Op.in]: allowedRoles } } }),
      models.MemberInvitation.findAll({
        where: { CollectiveId: this.id, role: { [Op.in]: allowedRoles } },
      }),
    ]);

    // remove the members that are not present anymore
    const { remoteUserCollectiveId } = defaultAttributes;
    const diff = differenceBy(oldMembers, members, m => m.id);
    if (diff.length > 0) {
      const nbAdminsBefore = oldMembers.filter(m => m.role === roles.ADMIN && m.id).length;
      const nbAdmins = members.filter(m => m.role === roles.ADMIN && m.id).length;
      if (nbAdminsBefore && !nbAdmins) {
        throw new Error('There must be at least one admin for the account');
      }

      debug('editMembers', 'delete', diff);
      const diffMemberIds = diff.map(m => m.id);
      await models.Member.update({ deletedAt: new Date() }, { where: { id: { [Op.in]: diffMemberIds } } });
    }

    // Remove the invitations that are not present anymore
    const invitationsDiff = oldInvitations.filter(invitation => {
      return !members.some(
        m => !m.id && m.member && m.member.id === invitation.MemberCollectiveId && m.role === invitation.role,
      );
    });

    if (invitationsDiff.length > 0) {
      await models.MemberInvitation.update(
        { deletedAt: new Date() },
        {
          where: {
            id: { [Op.in]: invitationsDiff.map(i => i.id) },
            CollectiveId: this.id,
          },
        },
      );
    }

    // Add new members
    for (const member of members) {
      const memberAttributes = {
        ...defaultAttributes,
        description: member.description,
        since: member.since,
        role: member.role,
      };

      if (member.id) {
        // Edit an existing membership (edit the role/description)
        const editableAttributes = pick(member, ['role', 'description', 'since']);
        debug('editMembers', 'update member', member.id, editableAttributes);
        await models.Member.update(editableAttributes, {
          where: {
            id: member.id,
            CollectiveId: this.id,
            role: { [Op.in]: allowedRoles },
          },
        });
      } else if (remoteUserCollectiveId && member.member?.id === remoteUserCollectiveId) {
        // When users try to add themselves (ie. when creating a collective) we don't need to send an invitation
        await models.Member.create({
          ...memberAttributes,
          MemberCollectiveId: member.member.id,
          CollectiveId: this.id,
        });
      } else if (member.member?.id) {
        // Create new membership invitation
        await models.MemberInvitation.invite(this, { ...memberAttributes, MemberCollectiveId: member.member.id });
      } else if (member.member?.email) {
        // Add user by email
        const user = await models.User.findOne({
          include: { model: models.Collective, as: 'collective', where: { type: types.USER, isIncognito: false } },
          where: { email: member.member.email },
        });

        if (user) {
          // If user exists for this email, send an invitation
          await models.MemberInvitation.invite(this, { ...memberAttributes, MemberCollectiveId: user.collective.id });
        } else {
          // Otherwise create and add the user directly
          const userFields = ['email', 'name', 'company', 'website'];
          const user = await models.User.createUserWithCollective(pick(member.member, userFields));
          await this.addUserWithRole(user, member.role, {
            ...memberAttributes,
            MemberCollectiveId: user.collective.id,
          });
        }
      } else {
        throw new Error('Invited member collective has not been set');
      }
    }

    /**
     * Because we don't update the model directly (we use Model.update(..., {where}))
     * when removing members, Member's `afterUpdate` hook is not triggered. Therefore it
     * is necessary to update the cache used in the collective page so that removed team
     * members don't persist in the Team section on the frontend.
     */
    invalidateContributorsCache(this.id);
    purgeCacheForCollective(this.slug);

    return this.getMembers({
      where: { role: { [Op.in]: allowedRoles } },
    });
  };

  // edit the tiers of this collective (create/update/remove)
  editTiers = function (tiers?: Array<any>) {
    // All kind of accounts can have Tiers

    if (!tiers) {
      return this.getTiers();
    }

    return <Promise<Array<any>>>this.getTiers()
      .then(oldTiers => {
        // remove the tiers that are not present anymore in the updated collective
        const diff = difference(
          oldTiers.map(t => t.id),
          tiers.map(t => t.id),
        );
        if (diff.length > 0) {
          return models.Tier.destroy({ where: { id: { [Op.in]: diff } } });
        }
      })
      .then(() => {
        return Promise.map(tiers, tier => {
          if (tier.amountType === 'FIXED') {
            tier.presets = null;
            tier.minimumAmount = null;
          }
          if (tier.invoiceTemplate) {
            tier.data = { ...tier.data, invoiceTemplate: tier.invoiceTemplate };
          }
          if (tier.id) {
            return models.Tier.update(tier, { where: { id: tier.id, CollectiveId: this.id } });
          } else {
            tier.CollectiveId = this.id;
            tier.currency = tier.currency || this.currency;
            return models.Tier.create(tier);
          }
        });
      })
      .then(() => this.getTiers());
  };

  // Where `this` collective is a type == ORGANIZATION collective.
  getExpensesForHost = function (status, startDate, endDate = new Date(), createdByUserId, excludedTypes) {
    const where: any = {
      createdAt: { [Op.lt]: endDate },
    };
    if (status) {
      where.status = status;
    }
    if (startDate) {
      where.createdAt[Op.gte] = startDate;
    }
    if (createdByUserId) {
      where.UserId = createdByUserId;
    }
    if (excludedTypes) {
      where.type = { [Op.or]: [{ [Op.eq]: null }, { [Op.notIn]: excludedTypes }] };
    }

    return models.Expense.findAll({
      where,
      order: [['createdAt', 'DESC']],
      include: [
        {
          model: models.Collective,
          as: 'collective',
          where: { HostCollectiveId: this.id },
        },
      ],
    });
  };

  getExpenses = function (status, startDate, endDate = new Date(), createdByUserId, excludedTypes) {
    const where: any = {
      createdAt: { [Op.lt]: endDate },
      CollectiveId: this.id,
    };
    if (status) {
      where.status = status;
    }
    if (startDate) {
      where.createdAt[Op.gte] = startDate;
    }
    if (createdByUserId) {
      where.UserId = createdByUserId;
    }
    if (excludedTypes) {
      where.type = { [Op.or]: [{ [Op.eq]: null }, { [Op.notIn]: excludedTypes }] };
    }

    return models.Expense.findAll({
      where,
      order: [['createdAt', 'DESC']],
    });
  };

  getUpdates = function (status, startDate = 0, endDate = new Date()) {
    const where: any = {
      createdAt: { [Op.lt]: endDate },
      CollectiveId: this.id,
    };
    if (startDate) {
      where.createdAt[Op.gte] = startDate;
    }
    if (status === 'published') {
      where.publishedAt = { [Op.ne]: null };
    }

    return models.Update.findAll({
      where,
      order: [['createdAt', 'DESC']],
    });
  };

  // Returns the last payment method that has been confirmed attached to this collective
  getPaymentMethod = async function (where, mustBeConfirmed = true) {
    const query: any = {
      where: {
        ...where,
        CollectiveId: this.id,
      },
    };
    if (mustBeConfirmed) {
      query.where.confirmedAt = { [Op.ne]: null };
      query.order = [['confirmedAt', 'DESC']];
    } else {
      query.order = [['createdAt', 'DESC']];
    }
    const paymentMethod = await models.PaymentMethod.findOne(query);
    if (!paymentMethod) {
      throw new Error('No payment method found');
    } else if (paymentMethod.expiryDate && paymentMethod.expiryDate < new Date()) {
      throw new Error('Payment method expired');
    }
    return paymentMethod;
  };

  getBalanceWithBlockedFundsAmount = function (options) {
    return getBalanceAmount(this, { ...options, withBlockedFunds: true });
  };

  getBalanceWithBlockedFunds = function (options: any = {}) {
    return getBalanceAmount(this, { ...options, withBlockedFunds: true }).then(result => result.value);
  };

  getBalanceAmount = function (options: any = {}) {
    return getBalanceAmount(this, options);
  };

  getBalance = function (options: any = {}) {
    return getBalanceAmount(this, options).then(result => result.value);
  };

  getYearlyBudgetAmount = function () {
    return getYearlyBudgetAmount(this);
  };

  getYearlyBudget = function () {
    return getYearlyBudgetAmount(this).then(result => result.value);
  };

  getTotalAmountReceivedAmount = function (options) {
    return getTotalAmountReceivedAmount(this, options);
  };

  getTotalAmountReceived = function (options) {
    return getTotalAmountReceivedAmount(this, options).then(result => result.value);
  };

  getTotalAmountSpentAmount = function (options) {
    return getTotalAmountSpentAmount(this, options);
  };

  getTotalAmountSpent = function (options) {
    return getTotalAmountSpentAmount(this, options).then(result => Math.abs(result.value));
  };

  getTotalPaidExpensesAmount = function (options) {
    return getTotalAmountPaidExpenses(this, options);
  };

  getTotalPaidExpenses = function (options) {
    return getTotalAmountPaidExpenses(this, options).then(result => result.value);
  };

  getTotalAmountReceivedTimeSeries = function (options) {
    return getTotalAmountReceivedTimeSeries(this, options);
  };

  getContributionsAndContributorsCount = function (options) {
    return getContributionsAndContributorsCount(this, options);
  };

  getTotalMoneyManaged = function (options) {
    return getTotalMoneyManagedAmount(this, options).then(result => result.value);
  };

  getTotalMoneyManagedAmount = function (options) {
    return getTotalMoneyManagedAmount(this, options);
  };

  // Get the average monthly spending based on last 90 days
  getMonthlySpending = function () {
    return queries
      .getCollectivesOrderedByMonthlySpending({
        where: { id: this.id },
        limit: 1,
      })
      .then(res => res.collectives[0] && res.collectives[0].dataValues.monthlySpending);
  };

  /**
   * A sequelize OR condition that will select all collective transactions:
   * - Debit transactions made by collective
   * - Debit transactions made using a gift card from collective
   * - Credit transactions made to collective
   *
   * @param {bool} includeUsedGiftCardsEmittedByOthers will remove transactions using gift
   *  cards from other collectives when set to false.
   */
  transactionsWhereQuery = function (includeUsedGiftCardsEmittedByOthers = true) {
    const debitTransactionOrQuery = includeUsedGiftCardsEmittedByOthers
      ? // Include all transactions made by this collective or using one of its
        // gift cards
        { CollectiveId: this.id, UsingGiftCardFromCollectiveId: this.id }
      : // Either Collective made the transaction without using a gift card,
        // or a transaction was made using one of its gift cards - but don't
        // include gift cards used emitted by other collectives
        [{ CollectiveId: this.id, UsingGiftCardFromCollectiveId: null }, { UsingGiftCardFromCollectiveId: this.id }];

    return {
      [Op.or]: [
        // Debit transactions
        {
          type: 'DEBIT',
          [Op.or]: debitTransactionOrQuery,
        },
        // Credit transactions
        {
          type: 'CREDIT',
          CollectiveId: this.id,
        },
      ],
    };
  };

  /**
   * Get all transactions for this collective.
   */
  getTransactions = function ({
    HostCollectiveId,
    startDate,
    endDate,
    type,
    offset,
    limit,
    attributes,
    kinds,
    order = [['createdAt', 'DESC']],
    includeUsedGiftCardsEmittedByOthers = true,
    includeExpenseTransactions = true,
  }) {
    // Base query
    const query: any = { where: this.transactionsWhereQuery(includeUsedGiftCardsEmittedByOthers) };

    // Select attributes
    if (attributes) {
      query.attributes = attributes;
    }

    // Hide expenses transactions on demand
    if (includeExpenseTransactions === false) {
      query.where.ExpenseId = null;
    }

    // Filter on host
    if (HostCollectiveId) {
      query.where.HostCollectiveId = HostCollectiveId;
    }

    // Filter on kind
    if (kinds) {
      query.where.kind = kinds;
    }

    // Filter on date
    if (startDate && endDate) {
      query.where.createdAt = { [Op.gte]: startDate, [Op.lt]: endDate };
    } else if (startDate) {
      query.where.createdAt = { [Op.gte]: startDate };
    } else if (endDate) {
      query.where.createdAt = { [Op.lt]: endDate };
    }

    // Filter on type
    if (type) {
      query.where.type = type;
    }

    // Pagination
    if (limit) {
      query.limit = limit;
    }
    if (offset) {
      query.offset = offset;
    }

    // OrderBy
    if (order) {
      query.order = order;
    }

    return models.Transaction.findAll(query);
  };

  /**
   * Returns the main tax type for this collective
   */
  getTaxType = function () {
    if (this.settings?.VAT) {
      return TaxType.VAT;
    } else if (this.settings?.GST) {
      return TaxType.GST;
    }
  };

  getTotalTransactions = function (startDate, endDate, type, attribute = 'netAmountInCollectiveCurrency') {
    endDate = endDate || new Date();
    const where = {
      ...this.transactionsWhereQuery(),
      createdAt: { [Op.lt]: endDate },
    };
    if (startDate) {
      where.createdAt[Op.gte] = startDate;
    }
    if (type === 'donation') {
      where.amount = { [Op.gt]: 0 };
    }
    if (type === 'expense') {
      where.amount = { [Op.lt]: 0 };
    }
    return models.Transaction.findOne({
      attributes: [[Sequelize.fn('COALESCE', Sequelize.fn('SUM', Sequelize.col(attribute)), 0), 'total']],
      where,
    }).then(result => Promise.resolve(parseInt(result.toJSON().total, 10)));
  };

  /**
   * Get the latest transactions made by this collective
   * @param {*} since
   * @param {*} until
   * @param {*} tags if not null, only takes into account donations made to collectives that contains one of those tags
   */
  getLatestTransactions = function (since, until, tags) {
    const conditionOnCollective: any = {};
    if (tags) {
      conditionOnCollective.tags = { [Op.overlap]: tags };
    }
    return models.Transaction.findAll({
      where: {
        FromCollectiveId: this.id,
        createdAt: { [Op.gte]: since || 0, [Op.lt]: until || new Date() },
      },
      order: [['amount', 'DESC']],
      include: [
        {
          model: models.Collective,
          as: 'collective',
          where: conditionOnCollective,
        },
      ],
    });
  };

  isHost = function () {
    if (this.isHostAccount) {
      return Promise.resolve(true);
    }

    if (this.type !== 'ORGANIZATION' && this.type !== 'USER') {
      return Promise.resolve(false);
    }

    return models.Member.findOne({ where: { MemberCollectiveId: this.id, role: 'HOST' } }).then(r => Boolean(r));
  };

  isHostOf = function (CollectiveId) {
    return models.Collective.findOne({
      where: { id: CollectiveId, HostCollectiveId: this.id },
    }).then(r => Boolean(r));
  };

  // get the host of the parent collective if any, or of this collective
  getHostCollective = async function ({ returnEvenIfNotApproved = false } = {}) {
    if (!this.isActive && !returnEvenIfNotApproved) {
      return null;
    }

    if (this.HostCollectiveId) {
      return models.Collective.findByPk(this.HostCollectiveId);
    }
    return models.Member.findOne({
      attributes: ['MemberCollectiveId'],
      where: { role: roles.HOST, CollectiveId: this.ParentCollectiveId },
      include: [{ model: models.Collective, as: 'memberCollective' }],
    }).then(m => {
      if (m && m.memberCollective) {
        return m.memberCollective;
      }
      return this.isHost().then(isHost => (isHost ? this : null));
    });
  };

  getHostCollectiveId = async function ({ returnEvenIfNotApproved = false } = {}) {
    if (!this.isActive && !returnEvenIfNotApproved) {
      return null;
    }

    if (this.HostCollectiveId) {
      return Promise.resolve(this.HostCollectiveId);
    }
    return models.Collective.getHostCollectiveId(this.ParentCollectiveId || this.id).then(HostCollectiveId => {
      this.HostCollectiveId = HostCollectiveId;
      return HostCollectiveId;
    });
  };

  getCustomerStripeAccount = function (hostStripeAccount, sequelizeOptions = {}) {
    return models.ConnectedAccount.findOne({
      where: {
        clientId: hostStripeAccount,
        CollectiveId: this.id,
        service: Service.STRIPE_CUSTOMER,
      },
      ...sequelizeOptions,
    });
  };

  getHostStripeAccount = function () {
    let HostCollectiveId;
    return this.getHostCollectiveId()
      .then(id => {
        HostCollectiveId = id;
        debug('getHostStripeAccount for collective', this.slug, `(id: ${this.id})`, 'HostCollectiveId', id);
        return (
          id &&
          models.ConnectedAccount.findOne({
            where: { service: 'stripe', CollectiveId: id },
            order: [['createdAt', 'DESC']],
          })
        );
      })
      .then(stripeAccount => {
        debug('getHostStripeAccount', 'using stripe account', stripeAccount && stripeAccount.username);
        if (!stripeAccount || !stripeAccount.token) {
          return Promise.reject(
            new Error(
              `The host for the ${this.name} collective has no Stripe account set up (HostCollectiveId: ${HostCollectiveId})`,
            ),
          );
        } else if (config.env !== 'production' && includes(stripeAccount.token, 'live')) {
          return Promise.reject(new Error(`You can't use a Stripe live key on ${config.env}`));
        } else {
          return stripeAccount;
        }
      });
  };

  getAccountForPaymentProvider = async function (provider) {
    const connectedAccount = await models.ConnectedAccount.findOne({
      where: { service: provider, CollectiveId: this.id },
    });

    if (!connectedAccount) {
      throw new Error(`Host ${this.slug} is not connected to ${provider}`);
    }

    return connectedAccount;
  };

  getTopBackers = async function (since, until, limit) {
    const backers = await queries.getMembersWithTotalDonations(
      { CollectiveId: this.id, role: 'BACKER' },
      { since, until, limit },
    );
    debug(
      'getTopBackers',
      backers.map(b => b.dataValues),
    );
    return backers;
  };

  getImageUrl = function (args = {}) {
    return getCollectiveAvatarUrl(this.slug, this.type, this.image, args);
  };

  getBackgroundImageUrl = function (args: any = {}) {
    if (!this.backgroundImage) {
      return null;
    }

    const sections = [config.host.images, this.slug];

    sections.push(md5(this.backgroundImage).substring(0, 7));

    sections.push('background');

    if (args.height) {
      sections.push(args.height);
    }

    // Re-use original image format if supported, default to png otherwise
    let format = args.format;
    if (!format) {
      format = this.backgroundImage.split('.').pop();
      if (!['jpg', 'png'].includes(format)) {
        format = 'png';
      }
    }

    return `${sections.join('/')}.${format}`;
  };

  getHostedCollectivesCount = function () {
    // This method is intended for hosts
    if (!this.isHostAccount) {
      return Promise.resolve(null);
    }
    return models.Collective.count({
      where: {
        HostCollectiveId: this.id,
        type: [types.COLLECTIVE, types.FUND],
        isActive: true,
        approvedAt: { [Op.not]: null },
      },
    });
  };

  getTotalAddedFunds = async function () {
    // This method is intended for hosts
    if (!this.isHostAccount) {
      return Promise.resolve(null);
    }

    const transactions = await models.Transaction.findAll({
      attributes: [
        [Sequelize.col('Transaction.currency'), 'currency'],
        [Sequelize.fn('COALESCE', Sequelize.fn('SUM', Sequelize.col('amount')), 0), 'total'],
      ],
      group: [Sequelize.col('Transaction.currency')],
      where: {
        HostCollectiveId: this.id,
        type: 'CREDIT',
      },
      include: [
        {
          model: models.Order,
          attributes: [],
          where: { status: 'PAID' },
          include: [
            {
              model: models.PaymentMethod,
              as: 'paymentMethod',
              attributes: [],
              // This is the main characteristic of Added Funds
              // Some older usage before 2017 doesn't have it but it's ok
              where: {
                service: PAYMENT_METHOD_SERVICE.OPENCOLLECTIVE,
                type: PAYMENT_METHOD_TYPE.HOST,
                CollectiveId: this.id,
              },
            },
          ],
        },
      ],
      raw: true,
    });

    const processOtherCurrency = async t => {
      const fx = await getFxRate(t.currency, 'USD');
      return Math.round(t.total * fx);
    };
    const total = sum(await Promise.all(transactions.map(processOtherCurrency)));
    return total;
  };

  getTotalTransferwisePayouts = async function () {
    // This method is intended for hosts
    if (!this.isHostAccount) {
      return Promise.resolve(null);
    }

    const transactions = await models.Transaction.findAll({
      attributes: [
        [Sequelize.col('Transaction.currency'), 'currency'],
        [Sequelize.fn('COALESCE', Sequelize.fn('SUM', Sequelize.col('Transaction.amount')), 0), 'total'],
      ],
      group: [Sequelize.col('Transaction.currency')],
      where: {
        HostCollectiveId: this.id,
        type: 'DEBIT',
      },
      include: [
        {
          model: models.Expense,
          attributes: [],
          where: { status: 'PAID' },
          include: [
            {
              model: models.PayoutMethod,
              attributes: [],
              where: {
                type: PayoutMethodTypes.BANK_ACCOUNT,
              },
            },
          ],
        },
      ],
      raw: true,
    });

    const processTransaction = async t => {
      const fx = await getFxRate(t.currency, 'USD');
      return Math.round(t.total * fx);
    };
    const total = Math.abs(sum(await Promise.all(transactions.map(processTransaction))));
    return total;
  };

  getTotalBankTransfers = async function () {
    // This method is intended for hosts
    if (!this.isHostAccount) {
      return Promise.resolve(null);
    }

    const transactions = await models.Transaction.findAll({
      attributes: [
        [Sequelize.col('Transaction.currency'), 'currency'],
        [Sequelize.fn('COALESCE', Sequelize.fn('SUM', Sequelize.col('amount')), 0), 'total'],
      ],
      group: [Sequelize.col('Transaction.currency')],
      where: {
        HostCollectiveId: this.id,
        type: 'CREDIT',
      },
      include: [
        {
          model: models.Order,
          attributes: [],
          where: {
            status: 'PAID',
            PaymentMethodId: null, // This is the main chracteristic of Bank Transfers
            totalAmount: { [Op.gte]: 0 }, // Skip Free Tiers which also have PaymentMethodId=null
            processedAt: { [Op.gte]: '2018-11-01' }, // Skip old entries that predate Bank Transfers
          },
        },
      ],
      raw: true,
    });

    const processTransaction = async t => {
      const fx = await getFxRate(t.currency, 'USD');
      return Math.round(t.total * fx);
    };
    const total = sum(await Promise.all(transactions.map(processTransaction)));
    return total;
  };

  getPlan = async function () {
    if (this.plan) {
      const planData = plans[this.plan];
      if (planData) {
        const extraPlanData = get(this.data, 'plan', {});
        const plan = {
          id: this.id,
          name: this.plan,
          hostedCollectives: 0,
          addedFunds: 0,
          bankTransfers: 0,
          transferwisePayouts: 0,
          ...planData,
          ...extraPlanData,
        };
        return plan;
      }
    }

    const plan = {
      id: this.id,
      name: 'default',
      hostedCollectives: 0,
      addedFunds: 0,
      bankTransfers: 0,
      transferwisePayouts: 0,
      ...plans.default,
    };

    return plan;
  };

  /**
   * Returns financial metrics from the Host collective.
   * @param {Date} from The start date from which the metrics should be calculated.
   * @param {Date} to The end date upto which the metrics should be calculated.
   * @param {[Integer]} [collectiveIds] Optional, a list of collective ids for which the metrics are returned.
   */
  getHostMetrics = async function (from, to, collectiveIds) {
    if (!this.isHostAccount || !this.isActive || this.type !== types.ORGANIZATION) {
      return null;
    }
    from = from ? moment(from) : null;
    to = to ? moment(to) : null;

    const plan = await this.getPlan();
    const hostFeeSharePercent = plan.hostFeeSharePercent || 0;

    const hostFees = await getHostFees(this, { startDate: from, endDate: to, fromCollectiveIds: collectiveIds });

    const hostFeeShare = await getHostFeeShare(this, {
      startDate: from,
      endDate: to,
      collectiveIds,
    });
    const pendingHostFeeShare = await getPendingHostFeeShare(this, {
      startDate: from,
      endDate: to,
      collectiveIds,
    });
    const settledHostFeeShare = hostFeeShare - pendingHostFeeShare;

    const totalMoneyManaged = await this.getTotalMoneyManaged({ endDate: to, collectiveIds });

    const platformTips = await getPlatformTips(this, { startDate: from, endDate: to, collectiveIds });
    const pendingPlatformTips = await getPendingPlatformTips(this, { startDate: from, endDate: to, collectiveIds });

    // We don't support platform fees anymore
    const platformFees = 0;
    const pendingPlatformFees = 0;

    const metrics = {
      hostFees,
      platformFees,
      pendingPlatformFees,
      platformTips,
      pendingPlatformTips,
      hostFeeShare,
      pendingHostFeeShare,
      settledHostFeeShare,
      hostFeeSharePercent,
      totalMoneyManaged,
    };

    return metrics;
  };

  setPolicies = async function (policies) {
    for (const policy of Object.keys(policies)) {
      if (!POLICIES[policy]) {
        throw new Error(`Policy ${policy} is not supported`);
      }
    }

    return this.update({ data: { ...this.data, policies: policies } });
  };

  generateCollectiveCreatedActivity = async function (user, userToken, data = null) {
    let type = activities.COLLECTIVE_CREATED;
    if (this.type === 'ORGANIZATION') {
      type = activities.ORGANIZATION_COLLECTIVE_CREATED;
    }

    return models.Activity.create({
      type,
      UserId: user.id,
      UserTokenId: userToken?.id,
      CollectiveId: this.id,
      HostCollectiveId: this.approvedAt ? this.HostCollectiveId : null,
      data,
    });
  };

  doesUserHaveTotalExpensesOverThreshold = async function ({ threshold, year, UserId }) {
    const { PENDING, APPROVED, PAID, PROCESSING } = expenseStatus;
    const since = moment({ year });
    const until = moment({ year }).add(1, 'y');
    const status = [PENDING, APPROVED, PAID, PROCESSING];
    const excludedTypes = [expenseTypes.RECEIPT];

    const expenses = await this.getExpensesForHost(status, since, until, UserId, excludedTypes);

    const userTotal = sumBy(expenses, 'amount');

    return userTotal >= threshold;
  };
}

Collective.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },

    type: {
      type: DataTypes.STRING,
      defaultValue: 'COLLECTIVE',
      validate: {
        isIn: {
          args: [CollectiveTypesList],
          msg: `Must be one of: ${CollectiveTypesList}`,
        },
      },
    },

    slug: {
      type: DataTypes.STRING,
      unique: true,
      allowNull: false,
      set(slug: string) {
        if (slug && slug.toLowerCase) {
          this.setDataValue('slug', slug.toLowerCase().replace(/ /g, '-').replace(/\./g, ''));
        }
      },
      validate: {
        len: [1, 255],
        isLowercase: true,
        notIn: {
          args: [collectiveSlugReservedList],
          msg: 'The slug given for this collective is a reserved keyword',
        },
        isValid(value) {
          if (!/^[\w-]+$/.test(value)) {
            throw new Error('Slug may only contain alphanumeric characters or hyphens.');
          }
          if (trim(value, '-') !== value) {
            throw new Error('Slug can not start nor end with hyphen.');
          }
        },
      },
    },

    /** Public name */
    name: {
      type: DataTypes.STRING,
      set(name: string) {
        this.setDataValue('name', name.replace(/\s+/g, ' ').trim());
      },
      validate: {
        len: [0, 255],
      },
    },

    /** Private, legal name. Used for expense receipts, taxes, etc. */
    legalName: {
      type: DataTypes.STRING,
      allowNull: true,
      set(legalName: string) {
        const cleanLegalName = legalName?.replace(/\s+/g, ' ').trim();
        this.setDataValue('legalName', cleanLegalName || null);
      },
      validate: {
        len: [0, 255],
      },
    },

    company: DataTypes.STRING,

    CreatedByUserId: {
      type: DataTypes.INTEGER,
      references: {
        model: 'Users',
        key: 'id',
      },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
      allowNull: true, // non authenticated users can create a collective
    },

    LastEditedByUserId: {
      type: DataTypes.INTEGER,
      references: {
        model: 'Users',
        key: 'id',
      },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
      allowNull: true, // needs to be true because of old rows
    },

    ParentCollectiveId: {
      type: DataTypes.INTEGER,
      references: {
        model: 'Collectives',
        key: 'id',
      },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
    },

    HostCollectiveId: {
      type: DataTypes.INTEGER,
      references: {
        model: 'Collectives',
        key: 'id',
      },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
    },

    hostFeePercent: {
      type: DataTypes.FLOAT,
      set(hostFeePercent: number) {
        if (hostFeePercent) {
          this.setDataValue('hostFeePercent', round(hostFeePercent, 2));
        } else {
          this.setDataValue('hostFeePercent', hostFeePercent);
        }
      },
      validate: {
        min: 0,
        max: 100,
      },
    },

    platformFeePercent: {
      type: DataTypes.INTEGER,
      validate: {
        min: 0,
        max: 100,
      },
    },

    description: DataTypes.STRING, // max 95 characters

    longDescription: {
      type: DataTypes.TEXT,
      set(longDescription: string) {
        if (longDescription) {
          this.setDataValue('longDescription', sanitizeHTML(longDescription, longDescriptionSanitizerOptions));
        } else {
          this.setDataValue('longDescription', null);
        }
      },
    },

    expensePolicy: {
      type: DataTypes.TEXT, // HTML
      validate: {
        len: [0, 50000], // just to prevent people from putting a lot of text in there
      },
      set(expensePolicy: string) {
        if (expensePolicy) {
          this.setDataValue('expensePolicy', sanitizeHTML(expensePolicy, policiesSanitizeOptions));
        } else {
          this.setDataValue('expensePolicy', null);
        }
      },
    },

    contributionPolicy: {
      type: DataTypes.TEXT, // HTML
      validate: {
        len: [0, 50000], // just to prevent people from putting a lot of text in there
      },
      set(contributionPolicy: string) {
        if (contributionPolicy) {
          this.setDataValue('contributionPolicy', sanitizeHTML(contributionPolicy, policiesSanitizeOptions));
        } else {
          this.setDataValue('contributionPolicy', null);
        }
      },
    },

    currency: CustomDataTypes(DataTypes).currency,

    image: {
      type: DataTypes.STRING,
      validate: {
        isUrl: true,
        isValidImage(url) {
          // Only validate for new images
          if (!url || url === this.image) {
            return;
          } else if (!isValidUploadedImage(url, { allowTrustedThirdPartyImages: true })) {
            throw new Error('The image URL is not valid');
          }
        },
      },
      get() {
        const image = this.getDataValue('image');
        // Warning: some tests really want that value to be undefined and not null
        if (image) {
          return image;
        }
      },
    },

    backgroundImage: {
      type: DataTypes.STRING,
      validate: {
        isUrl: true,
        isValidImage(url) {
          // Only validate for new images
          if (!url || url === this.backgroundImage) {
            return;
          } else if (!isValidUploadedImage(url, { allowTrustedThirdPartyImages: true })) {
            throw new Error('The background image URL is not valid');
          }
        },
      },
      get() {
        return this.getDataValue('backgroundImage');
      },
    },

    countryISO: {
      type: DataTypes.STRING,
      validate: {
        len: [2, 2],
        isCountryISO(value) {
          if (!(isNull(value) || validator.isISO31661Alpha2(value))) {
            throw new Error('Invalid Country ISO.');
          }
        },
      },
    },

    settings: {
      type: DataTypes.JSONB,
      get() {
        return this.getDataValue('settings') || {};
      },
      set(value: Settings) {
        sanitizeSettingsValue(value);
        this.setDataValue('settings', filterCollectiveSettings(value));
      },
      validate: {
        validate(settings) {
          const error = validateSettings(settings);
          if (error) {
            throw new Error(error as string);
          }
        },
      },
    },

    isPledged: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },

    data: {
      type: DataTypes.JSONB,
      allowNull: true,
    },

    startsAt: {
      type: DataTypes.DATE,
    },

    endsAt: {
      type: DataTypes.DATE,
    },

    timezone: DataTypes.STRING,

    createdAt: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    },

    updatedAt: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    },

    isActive: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },

    isIncognito: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },

    approvedAt: {
      type: DataTypes.DATE,
    },

    /**
     * @deprecated Use collective social links instead
     */
    twitterHandle: {
      type: DataTypes.STRING, // without the @ symbol. Ex: 'asood123'
      set(twitterHandle: string) {
        if (!twitterHandle || twitterHandle.length === 0) {
          this.setDataValue('twitterHandle', null);
          return;
        }

        // Try to parse Twitter URL, fallback on regular string
        const twitterRegex = /https?:\/\/twitter\.com\/([^/\s]+)/;
        const regexResult = twitterHandle.match(twitterRegex);
        if (regexResult) {
          const [, username] = regexResult;
          this.setDataValue('twitterHandle', username);
        } else {
          this.setDataValue('twitterHandle', twitterHandle.replace(/^@/, ''));
        }
      },
      validate: {
        is: /^[A-Za-z0-9_]{1,15}$/,
      },
    },

    /**
     * @deprecated Use collective social links instead
     */
    githubHandle: {
      type: DataTypes.VIRTUAL,
      get() {
        return getGithubHandleFromUrl(this.repositoryUrl);
      },
      set(input: string) {
        const cleanInput = input?.trim();
        const githubUrl = getGithubUrlFromHandle(cleanInput);
        if (githubUrl) {
          this.setDataValue('repositoryUrl', githubUrl);
        } else {
          this.setDataValue('repositoryUrl', null);
        }
      },
    },

    /**
     * @deprecated Use collective social links instead
     */
    repositoryUrl: {
      type: DataTypes.STRING,
      validate: {
        notEmpty: true,
        isUrl: {
          msg: 'Repository URL must be a valid URL',
        },
      },
      set(repositoryUrl: string) {
        if (repositoryUrl) {
          this.setDataValue('repositoryUrl', prependHttp(repositoryUrl, { https: true }).trim());
        } else {
          this.setDataValue('repositoryUrl', null);
        }
      },
    },

    /**
     * @deprecated Use collective social links instead
     */
    website: {
      type: DataTypes.STRING,
      get() {
        const website = this.getDataValue('website');
        return website ? prependHttp(website) : null;
      },
      set(url: string) {
        if (url) {
          this.setDataValue('website', prependHttp(url, { https: true }));
        } else {
          this.setDataValue('website', null);
        }
      },
      validate: {
        isUrl: true,
      },
    },

    publicUrl: {
      type: new DataTypes.VIRTUAL(DataTypes.STRING, ['slug']),
      get() {
        return `${config.host.website}/${this.get('slug')}`;
      },
    },

    tags: {
      type: DataTypes.ARRAY(DataTypes.STRING),
      set(tags: string | Array<string>) {
        const sanitizedTags = sanitizeTags(tags);
        validateTags(sanitizedTags);
        this.setDataValue('tags', sanitizedTags);
      },
    },

    monthlySpending: {
      type: new DataTypes.VIRTUAL(DataTypes.INTEGER),
    },

    deactivatedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },

    isHostAccount: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },

    plan: {
      type: DataTypes.STRING,
      allowNull: true,
    },
  },
  {
    paranoid: true,
    sequelize,
    hooks: {
      beforeValidate: instance => {
        if (instance.slug) {
          return Promise.resolve();
        }
        let potentialSlugs,
          useSlugify = true;
        // Populate potentialSlugs, priority of choices is the same as order in the array
        if (instance.isIncognito) {
          useSlugify = false;
          potentialSlugs = [`incognito-${uuid().split('-')[0]}`];
        } else {
          potentialSlugs = [
            instance.name ? instance.name.replace(/ /g, '-') : null,
            instance.image ? userlib.getUsernameFromGithubURL(instance.image) : null,
            instance.twitterHandle ? instance.twitterHandle.replace(/@/g, '') : null,
          ];
        }
        return Collective.generateSlug(potentialSlugs, useSlugify).then(slug => {
          if (!slug) {
            return Promise.reject(new Error("We couldn't generate a unique slug for this collective", potentialSlugs));
          }
          instance.slug = slug;
          return Promise.resolve();
        });
      },
      beforeDestroy: async instance => {
        const newSlug = `${instance.slug}-${Date.now()}`;
        await instance.update({ slug: newSlug });
      },
      beforeCreate: async instance => {
        // Make sure user is not prevented from creating collectives
        const user = instance.CreatedByUserId && (await models.User.findByPk(instance.CreatedByUserId));
        if (user && !canUseFeature(user, FEATURE.CREATE_COLLECTIVE)) {
          throw new Error("You're not authorized to create new collectives at the moment.");
        }

        // Check if collective is spam
        const spamReport = await collectiveSpamCheck(instance, 'Collective.beforeCreate');
        // If 100% sure that it's a spam
        if (spamReport.score > 0) {
          notifyTeamAboutSuspiciousCollective(spamReport);
          instance.data = { ...instance.data, spamReport };
        }
      },
      afterCreate: async (instance, options) => {
        instance.findImage();
        if ([types.COLLECTIVE, types.FUND, types.EVENT, types.PROJECT].includes(instance.type)) {
          await models.PaymentMethod.create(
            {
              CollectiveId: instance.id,
              service: 'opencollective',
              type: 'collective',
              name: `${instance.name} (${capitalize(instance.type.toLowerCase())})`,
              primary: true,
              currency: instance.currency,
            },
            { transaction: options.transaction },
          );
        }
        return null;
      },
      afterUpdate: async (instance, options) => {
        const spamReport = await collectiveSpamCheck(instance, 'Collective.afterUpdate');
        if (spamReport.score > 0 && spamReport.score > (instance.data?.spamReport?.score || 0)) {
          notifyTeamAboutSuspiciousCollective(spamReport);
          await instance.update({ data: { ...instance.data, spamReport } }, { transaction: options.transaction });
        }
      },
    },
  },
);

Temporal(Collective, sequelize);

export default Collective;
