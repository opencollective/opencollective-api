import { TaxType } from '@opencollective/taxes';
import Promise from 'bluebird';
import config from 'config';
import debugLib from 'debug';
import deepmerge from 'deepmerge';
import * as ics from 'ics';
import slugify from 'limax';
import { defaults, difference, differenceBy, get, includes, isNull, omit, pick, sum, sumBy, trim, unset } from 'lodash';
import moment from 'moment';
import fetch from 'node-fetch';
import prependHttp from 'prepend-http';
import Temporal from 'sequelize-temporal';
import { v4 as uuid } from 'uuid';
import { isISO31661Alpha2 } from 'validator';

import activities from '../constants/activities';
import { CollectiveTypesList, types } from '../constants/collectives';
import expenseStatus from '../constants/expense_status';
import expenseTypes from '../constants/expense_type';
import FEATURE from '../constants/feature';
import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../constants/paymentMethods';
import plans from '../constants/plans';
import roles, { MemberRoleLabels } from '../constants/roles';
import { hasOptedOutOfFeature, isFeatureAllowedForCollectiveType } from '../lib/allowed-features';
import {
  getBalanceAmount,
  getBalanceWithBlockedFundsAmount,
  getTotalAmountReceivedAmount,
  getTotalMoneyManagedAmount,
  getTotalNetAmountReceivedAmount,
  getYearlyIncome,
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
import {
  getHostFees,
  getHostFeeShare,
  getPendingHostFeeShare,
  getPendingPlatformTips,
  getPlatformTips,
} from '../lib/host-metrics';
import logger from '../lib/logger';
import queries from '../lib/queries';
import { buildSanitizerOptions, sanitizeHTML } from '../lib/sanitize-html';
import sequelize, { DataTypes, Op, Sequelize } from '../lib/sequelize';
import { collectiveSpamCheck, notifyTeamAboutSuspiciousCollective } from '../lib/spam';
import { canUseFeature } from '../lib/user-permissions';
import userlib from '../lib/userlib';
import { capitalize, cleanTags, formatCurrency, getDomain, md5 } from '../lib/utils';

import CustomDataTypes from './DataTypes';
import { PayoutMethodTypes } from './PayoutMethod';

const debug = debugLib('models:Collective');

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
  images: true,
  links: true,
  videoIframes: true,
});

function defineModel() {
  const { models } = sequelize;

  const Collective = sequelize.define(
    'Collective',
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
        set(slug) {
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
        set(name) {
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
        set(legalName) {
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
        set(longDescription) {
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
        set(expensePolicy) {
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
        set(contributionPolicy) {
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
        },
        get() {
          return this.getDataValue('backgroundImage');
        },
      },

      locationName: DataTypes.STRING,

      address: DataTypes.STRING,

      countryISO: {
        type: DataTypes.STRING,
        validate: {
          len: 2,
          isCountryISO(value) {
            if (!(isNull(value) || isISO31661Alpha2(value))) {
              throw new Error('Invalid Country ISO.');
            }
          },
        },
      },

      geoLocationLatLong: DataTypes.GEOMETRY('POINT'),

      settings: {
        type: DataTypes.JSONB,
        get() {
          return this.getDataValue('settings') || {};
        },
        set(value) {
          this.setDataValue('settings', filterCollectiveSettings(value));
        },
        validate: {
          validate(settings) {
            const error = validateSettings(settings);
            if (error) {
              throw new Error(error);
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

      twitterHandle: {
        type: DataTypes.STRING, // without the @ symbol. Ex: 'asood123'
        set(twitterHandle) {
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

      githubHandle: {
        type: DataTypes.STRING,
        set(githubHandle) {
          if (!githubHandle || githubHandle.length === 0) {
            this.setDataValue('githubHandle', null);
            return;
          }

          // Try to parse github URL, fallback on regular string
          const githubUrlRegex = /https?:\/\/github\.com\/([^/\s]+)(\/([^/\s]+))?/;
          const regexResult = githubHandle.match(githubUrlRegex);
          if (regexResult) {
            const [, username, , repository] = regexResult;
            const formattedHandle = repository ? `${username}/${repository}` : username;
            this.setDataValue('githubHandle', formattedHandle);
          } else {
            this.setDataValue('githubHandle', githubHandle.replace(/^@/, ''));
          }
        },
      },

      website: {
        type: DataTypes.STRING,
        get() {
          const website = this.getDataValue('website');
          return website ? prependHttp(website) : null;
        },
        set(url) {
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
        set(tags) {
          this.setDataValue('tags', cleanTags(tags));
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

      getterMethods: {
        location() {
          return {
            name: this.locationName,
            address: this.address,
            country: this.countryISO,
            structured: this.settings?.address,
            lat: this.geoLocationLatLong?.coordinates?.[0],
            long: this.geoLocationLatLong?.coordinates?.[1],
          };
        },

        previewImage() {
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
        },

        // Info.
        info() {
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
            locationName: this.locationName,
            address: this.address,
            geoLocationLatLong: this.geoLocationLatLong,
            startsAt: this.startsAt,
            endsAt: this.endsAt,
            timezone: this.timezone,
            status: this.status,
            createdAt: this.createdAt,
            updatedAt: this.updatedAt,
            isActive: this.isActive,
            isHostAccount: this.isHostAccount,
            slug: this.slug,
            tiers: this.tiers,
            settings: this.settings,
            website: this.website,
            twitterHandle: this.twitterHandle,
            githubHandle: this.githubHandle,
            publicUrl: this.publicUrl,
            hostFeePercent: this.hostFeePercent,
            platformFeePercent: this.platformFeePercent,
            tags: this.tags,
            HostCollectiveId: this.HostCollectiveId,
          };
        },
        card() {
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
        },
        // used to generate the invoice
        invoice() {
          return {
            id: this.id,
            createdAt: this.createdAt,
            name: this.name,
            slug: this.slug,
            image: this.image,
            backgroundImage: this.backgroundImage,
            publicUrl: this.publicUrl,
            locationName: this.locationName,
            address: this.address,
            description: this.description,
            settings: this.settings,
            currency: this.currency,
          };
        },
        minimal() {
          return {
            id: this.id,
            type: this.type,
            name: this.name,
            image: this.image,
            slug: this.slug,
            twitterHandle: this.twitterHandle,
            githubHandle: this.githubHandle,
            publicUrl: this.publicUrl,
          };
        },
        activity() {
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
            description: this.description,
            previewImage: this.previewImage,
          };
        },
        searchIndex() {
          return {
            id: this.id,
            name: this.name,
            description: this.description,
            currency: this.currency,
            slug: this.slug,
            type: this.type,
            tags: this.tags,
            locationName: this.locationName,
            balance: this.balance, // useful in ranking
            yearlyBudget: this.yearlyBudget,
            backersCount: this.backersCount,
          };
        },
      },

      hooks: {
        beforeValidate: instance => {
          if (instance.slug) {
            return Promise.resolve();
          }
          let potentialSlugs,
            useSlugify = true;
          if (instance.isIncognito) {
            useSlugify = false;
            potentialSlugs = [`incognito-${uuid().split('-')[0]}`];
          } else {
            potentialSlugs = [
              instance.slug,
              instance.image ? userlib.getUsernameFromGithubURL(instance.image) : null,
              instance.twitterHandle ? instance.twitterHandle.replace(/@/g, '') : null,
              instance.name ? instance.name.replace(/ /g, '-') : null,
            ];
          }
          return Collective.generateSlug(potentialSlugs, useSlugify).then(slug => {
            if (!slug) {
              return Promise.reject(
                new Error("We couldn't generate a unique slug for this collective", potentialSlugs),
              );
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
            return instance.update({ data: { ...instance.data, spamReport } }, { transaction: options.transaction });
          }
        },
      },
    },
  );

  /**
   * Instance Methods
   */

  /**
   * Returns the next goal with the progress and how much is missing (as one-time or monthly donation)
   * Used for the monthly reports to backers
   */
  Collective.prototype.getNextGoal = async function (until) {
    const goals = get(this, 'settings.goals');
    if (!goals) {
      return null;
    }
    const stats = {};
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
          stats.yearlyBudget = await this.getYearlyIncome();
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

  Collective.prototype.getParentCollective = function () {
    if (!this.ParentCollectiveId) {
      return Promise.resolve(null);
    }
    if (this.parentCollective) {
      return Promise.resolve(this.parentCollective);
    }
    return models.Collective.findByPk(this.ParentCollectiveId);
  };

  Collective.prototype.getICS = function () {
    if (this.type !== 'EVENT') {
      throw new Error('Can only generate ICS for collectives of type EVENT');
    }
    return new Promise(resolve => {
      return this.getParentCollective().then(parentCollective => {
        const url = `${config.host.website}/${parentCollective.slug}/events/${this.slug}`;
        const startDate = new Date(this.startsAt);
        const endDate = new Date(this.endsAt);
        const start = [
          startDate.getFullYear(),
          startDate.getMonth() + 1,
          startDate.getDate(),
          startDate.getHours(),
          startDate.getMinutes(),
        ];
        const end = [
          endDate.getFullYear(),
          endDate.getMonth() + 1,
          endDate.getDate(),
          endDate.getHours(),
          endDate.getMinutes(),
        ];
        let description = this.description || '';
        if (this.longDescription) {
          description += `\n\n${this.longDescription}`;
        }
        let location = this.location.name || '';
        if (this.location.address) {
          location += `, ${this.location.address}`;
        }
        if (this.location.country) {
          location += `, ${this.location.country}`;
        }
        const alarms = [
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
        const event = {
          title: this.name,
          description,
          start,
          end,
          location,
          url,
          status: 'CONFIRMED',
          organizer: {
            name: parentCollective.name,
            email: `no-reply@${parentCollective.slug}.opencollective.com`,
          },
          alarms,
        };
        if (this.location.lat) {
          event.geo = { lat: this.location.lat, lon: this.location.long };
        }
        ics.createEvent(event, (err, res) => {
          if (err) {
            logger.error(`Error while generating the ics file for event id ${this.id} (${url})`, err);
          }
          return resolve(res);
        });
      });
    });
  };

  // If no image has been provided, try to find an image using clearbit and save it
  Collective.prototype.findImage = function (force = false) {
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
  Collective.prototype.findImageForUser = function (user, force = false) {
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

  // Save image it if it returns 200
  Collective.prototype.checkAndUpdateImage = async function (image, force = false) {
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
  Collective.prototype.becomeHost = async function () {
    if (!this.isHostAccount) {
      const updatedValues = { isHostAccount: true, plan: 'start-plan-2021' };
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
        data: { collective: this.info },
      });
    }

    await this.activateBudget();

    return this;
  };

  Collective.prototype.getOrCreateHostPaymentMethod = async function () {
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
  Collective.prototype.deactivateAsHost = async function () {
    const hostedCollectives = await this.getHostedCollectivesCount();
    if (hostedCollectives >= 1) {
      throw new Error(
        `You can't deactivate hosting while still hosting ${hostedCollectives} other collectives. Please contact support: support@opencollective.com.`,
      );
    }

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
      data: { collective: this.info },
    });

    return this;
  };

  Collective.prototype.hasBudget = function () {
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
  Collective.prototype.activateBudget = async function () {
    if (!this.isHostAccount || ![types.ORGANIZATION].includes(this.type)) {
      return;
    }

    await this.update({
      isActive: true,
      HostCollectiveId: this.id,
      settings: { ...this.settings, hostCollective: { id: this.id } },
      approvedAt: new Date(),
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
  Collective.prototype.deactivateBudget = async function () {
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

    const collectivePaymentMethod = await models.PaymentMethod.findOne({
      where: {
        CollectiveId: this.id,
        service: 'opencollective',
        type: 'collective',
        deletedAt: null,
      },
    });

    if (collectivePaymentMethod) {
      await collectivePaymentMethod.destroy();
    }

    return this;
  };

  /**
   * Returns true if Collective is a host account open to applications.
   */
  Collective.prototype.canApply = async function () {
    return Boolean(this.isHostAccount && this.settings?.apply);
  };

  /**
   * Returns true if the collective can be used as a payout profile for an expense
   */
  Collective.prototype.canBeUsedAsPayoutProfile = function () {
    return !this.isIncognito;
  };

  /**
   *  Checks if the collective can be contacted.
   */
  Collective.prototype.canContact = async function () {
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
  Collective.prototype.isApproved = function () {
    if (this.type === types.EVENT) {
      throw new Error("isApproved must be called on event's parent collective");
    } else {
      return Boolean(this.HostCollectiveId && this.isActive && this.approvedAt);
    }
  };

  // This is quite ugly, and only needed for events.
  // I'd argue that we should store the event slug as `${parentCollectiveSlug}/events/${eventSlug}`
  Collective.prototype.getUrlPath = function () {
    if (this.type === types.EVENT) {
      return models.Collective.findByPk(this.ParentCollectiveId, {
        attributes: ['id', 'slug'],
      }).then(parent => {
        if (!parent) {
          logger.error(`Event (${this.id}) with an invalid parent (${this.ParentCollectiveId}).`);
          return `/collective/events/${this.slug}`;
        }
        return `/${parent.slug}/events/${this.slug}`;
      });
    } else {
      return Promise.resolve(`/${this.slug}`);
    }
  };

  // Returns the User model of the User that created this collective
  Collective.prototype.getUser = async function (queryParams) {
    if (this.type === types.USER) {
      return models.User.findOne({ where: { CollectiveId: this.id }, ...queryParams });
    } else {
      return null;
    }
  };

  Collective.prototype.getAdmins = async function () {
    const members = await models.Member.findAll({
      where: {
        CollectiveId: this.id,
        role: roles.ADMIN,
      },
      include: [{ model: models.Collective, as: 'memberCollective' }],
    });
    return members.map(member => member.memberCollective);
  };

  Collective.prototype.getMemberships = async function ({ role } = {}) {
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
   */
  Collective.prototype.getAdminUsers = async function ({ userQueryParams, paranoid = true } = {}) {
    if (this.type === 'USER' && !this.isIncognito) {
      // Incognito profiles rely on the `Members` entry to know which user it belongs to
      return [await this.getUser({ paranoid, ...userQueryParams })];
    }

    const collectiveId = ['EVENT', 'PROJECT'].includes(this.type) ? this.ParentCollectiveId : this.id;

    const admins = await models.Member.findAll({
      where: {
        CollectiveId: collectiveId,
        role: roles.ADMIN,
      },
      paranoid,
    });

    return models.User.findAll({
      where: { CollectiveId: { [Op.in]: admins.map(m => m.MemberCollectiveId) } },
      paranoid,
      ...userQueryParams,
    });
  };

  /**
   * Get the email addresses of the admins of this collective
   */
  Collective.prototype.getEmails = async function () {
    return this.getAdminUsers().then(users => users.map(u => u && u.email));
  };

  Collective.prototype.getChildren = function (query = {}) {
    return Collective.findAll({
      ...query,
      where: { ...query.where, ParentCollectiveId: this.id },
    });
  };

  Collective.prototype.getEvents = function (query = {}) {
    return this.getChildren({
      ...query,
      where: { ...query.where, type: types.EVENT },
    });
  };

  Collective.prototype.getProjects = function (query = {}) {
    return this.getChildren({
      ...query,
      where: { ...query.where, type: types.PROJECT },
    });
  };

  /**
   * Return stats about backers based on the Members table
   *  - stats.backers.lastMonth: number of backers by endDate
   *  - stats.backers.previousMonth: number of backers by startDate
   *  - stats.backers.new: the number of backers whose first donation was after startDate
   */
  Collective.prototype.getBackersStats = function (startDate, endDate) {
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
  Collective.prototype.getNewOrders = async function (startDate = 0, endDate = new Date(), where = {}) {
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
  Collective.prototype.getCancelledOrders = async function (startDate = 0, endDate = new Date()) {
    let orders = await models.Order.findAll({
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
  Collective.prototype.getBackersCount = function (options = {}) {
    const query = {
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
        const stats = { id: this.id };
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

  Collective.prototype.getIncomingOrders = function (options) {
    const query = deepmerge(
      {
        where: { CollectiveId: this.id },
      },
      options,
      { clone: false },
    );
    return models.Order.findAll(query);
  };

  Collective.prototype.getOutgoingOrders = function (options) {
    const query = deepmerge(
      {
        where: { FromCollectiveId: this.id },
      },
      options,
      { clone: false },
    );
    return models.Order.findAll(query);
  };

  Collective.prototype.getRoleForMemberCollective = function (MemberCollectiveId) {
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
  Collective.prototype.getTiersWithUsers = async function (
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

    const backerCollectives = await queries.getMembersWithTotalDonations(
      { CollectiveId: this.id, role: 'BACKER' },
      options,
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
  Collective.prototype.getBackerTier = function (backerCollective) {
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
  Collective.prototype.addUserWithRole = async function (
    user,
    role,
    defaultAttributes = {},
    context = {},
    transaction,
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
          await this.createMemberCreatedActivity(member, context, sequelizeParams);
        }
        break;

      case roles.MEMBER:
      case roles.ACCOUNTANT:
      case roles.ADMIN:
        if (![types.FUND, types.PROJECT, types.EVENT].includes(this.type)) {
          await this.sendNewMemberEmail(user, role, member, sequelizeParams);
        }
        break;
    }

    return member;
  };

  Collective.prototype.createMemberCreatedActivity = async function (member, context, sequelizeParams) {
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
        ...order.activity,
        tier: order.Tier && order.Tier.minimal,
        subscription: {
          interval: order.Subscription && order.Subscription.interval,
        },
      },
    };

    return models.Activity.create(
      { CollectiveId: this.id, type: activities.COLLECTIVE_MEMBER_CREATED, data },
      sequelizeParams,
    );
  };

  Collective.prototype.sendNewMemberEmail = async function (user, role, member, sequelizeParams) {
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
    const supportedTemplates = ['collective', 'organization'];
    const lowercaseType = this.type.toLowerCase();
    const typeForTemplate = supportedTemplates.includes(lowercaseType) ? lowercaseType : 'collective';
    const template = `${typeForTemplate}.newmember`;
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
        loginLink: `${config.host.website}/signin?next=/${memberUser.collective.slug}/edit`,
      },
      { bcc: remoteUser.email },
    );
  };

  /**
   * Used when creating a transactin to add a user to the collective as a backer if needed.
   * A new membership is registered for each `defaultAttributes.TierId`.
   */
  Collective.prototype.findOrAddUserWithRole = function (user, role, defaultAttributes, context, transaction) {
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
  Collective.prototype.getHostedCollectives = async function () {
    const hostedCollectives = await models.Member.findAll({
      where: { MemberCollectiveId: this.id, role: roles.HOST },
    });
    const hostedCollectiveIds = hostedCollectives.map(m => m.CollectiveId);
    return models.Collective.findAll({ where: { id: { [Op.in]: hostedCollectiveIds } } });
  };

  Collective.prototype.getHostedCollectiveAdmins = async function () {
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

  Collective.prototype.updateHostFee = async function (hostFeePercent, remoteUser) {
    if (typeof hostFeePercent === undefined || !remoteUser || hostFeePercent === this.hostFeePercent) {
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

  Collective.prototype.updatePlatformFee = async function (platformFeePercent, remoteUser) {
    if (typeof platformFeePercent === undefined || !remoteUser || platformFeePercent === this.platformFeePercent) {
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
  Collective.prototype.updateCurrency = async function (currency, remoteUser) {
    if (typeof currency === undefined || !remoteUser || !remoteUser.isAdmin(this.id)) {
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
  Collective.prototype.setCurrency = async function (currency) {
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
      let collectives = await this.getHostedCollectives();
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
    const tiers = await this.getTiers();
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
    const events = await this.getEvents();
    if (events.length > 0) {
      await Promise.map(events, event => event.setCurrency(currency), { concurrency: 3 });
    }
    const projects = await this.getProjects();
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
  Collective.prototype.addHost = async function (hostCollective, creatorUser, options) {
    if (this.HostCollectiveId) {
      throw new Error(`This collective already has a host (HostCollectiveId: ${this.HostCollectiveId})`);
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
      ...(shouldAutomaticallyApprove ? { isActive: true, approvedAt: new Date() } : null),
    };

    // events should take the currency of their parent collective, not necessarily the host of their host.
    if (this.type === 'COLLECTIVE') {
      updatedValues.currency = hostCollective.currency;
    }

    const promises = [models.Member.create(member), this.update(updatedValues)];

    // Invalidate current collective payment method if there's one
    await models.PaymentMethod.destroy({
      where: {
        CollectiveId: this.id,
        service: 'opencollective',
        type: 'collective',
        deletedAt: null,
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

    if (this.type === types.COLLECTIVE) {
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
            ]),
          },
          application: {
            message: options?.message,
            customData: options?.applicationData,
          },
        };

        // Record application
        promises.push(
          models.HostApplication.recordApplication(hostCollective, this, {
            message: options?.message,
            customData: options?.applicationData,
          }),
        );

        if (!options?.skipCollectiveApplyActivity) {
          promises.push(
            models.Activity.create({
              CollectiveId: this.id,
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
  Collective.prototype.changeHost = async function (newHostCollectiveId, remoteUser, options) {
    // Skip
    if (this.HostCollectiveId === newHostCollectiveId) {
      return this;
    }

    const balance = await this.getBalance();
    if (balance > 0) {
      throw new Error(`Unable to change host: you still have a balance of ${formatCurrency(balance, this.currency)}`);
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
      this.isHostAccount = false;
      this.plan = null;
      await models.ConnectedAccount.destroy({
        where: {
          service: 'stripe',
          CollectiveId: this.id,
        },
      });
    }

    // Prepare collective to receive a new host
    this.HostCollectiveId = null;
    this.isActive = false;
    this.approvedAt = null;
    this.hostFeePercent = null;
    this.platformFeePercent = null;

    // Prepare events and projects to receive a new host
    const events = await this.getEvents();
    if (events?.length > 0) {
      await Promise.all(events.map(e => e.changeHost(null)));
    }
    const projects = await this.getProjects();
    if (projects?.length > 0) {
      await Promise.all(projects.map(e => e.changeHost(null)));
    }

    if (newHostCollectiveId) {
      const newHostCollective = await models.Collective.findByPk(newHostCollectiveId);
      if (!newHostCollective) {
        throw new Error('Host not found');
      }
      if (!newHostCollective.isHostAccount) {
        await newHostCollective.becomeHost();
      }
      return this.addHost(newHostCollective, remoteUser, {
        message: options?.message,
        applicationData: options?.applicationData,
      });
    } else {
      // if we remove the host
      return this.save();
    }
  };

  // edit the list of members and admins of this collective (create/update/remove)
  // creates a User and a UserCollective if needed
  Collective.prototype.editMembers = async function (members, defaultAttributes = {}) {
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
    const [oldMembers, oldInvitations] = await Promise.all([
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
  Collective.prototype.editTiers = function (tiers) {
    // All kind of accounts can have Tiers

    if (!tiers) {
      return this.getTiers();
    }

    return this.getTiers()
      .then(oldTiers => {
        // remove the tiers that are not present anymore in the updated collective
        const diff = difference(
          oldTiers.map(t => t.id),
          tiers.map(t => t.id),
        );
        return models.Tier.update({ deletedAt: new Date() }, { where: { id: { [Op.in]: diff } } });
      })
      .then(() => {
        return Promise.map(tiers, tier => {
          if (tier.amountType === 'FIXED') {
            tier.presets = null;
            tier.minimumAmount = null;
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
  Collective.prototype.getExpensesForHost = function (
    status,
    startDate,
    endDate = new Date(),
    createdByUserId,
    excludedTypes,
  ) {
    const where = {
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

  Collective.prototype.getExpenses = function (
    status,
    startDate,
    endDate = new Date(),
    createdByUserId,
    excludedTypes,
  ) {
    const where = {
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

  Collective.prototype.getUpdates = function (status, startDate = 0, endDate = new Date()) {
    const where = {
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
  Collective.prototype.getPaymentMethod = async function (where, mustBeConfirmed = true) {
    const query = {
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
    } else if (paymentMethod.endDate && paymentMethod.endDate < new Date()) {
      throw new Error('Payment method expired');
    }
    return paymentMethod;
  };

  Collective.prototype.getBalanceWithBlockedFundsAmount = function (options) {
    return getBalanceWithBlockedFundsAmount(this, options);
  };

  Collective.prototype.getBalanceWithBlockedFunds = function (options) {
    return getBalanceWithBlockedFundsAmount(this, options).then(result => result.value);
  };

  Collective.prototype.getBalanceAmount = function (options) {
    return getBalanceAmount(this, options);
  };

  Collective.prototype.getBalance = function (options) {
    return getBalanceAmount(this, options).then(result => result.value);
  };

  Collective.prototype.getYearlyIncome = function () {
    return getYearlyIncome(this);
  };

  Collective.prototype.getTotalAmountReceivedAmount = function (options) {
    return getTotalAmountReceivedAmount(this, options);
  };

  Collective.prototype.getTotalAmountReceived = function (options) {
    return getTotalAmountReceivedAmount(this, options).then(result => result.value);
  };

  Collective.prototype.getTotalNetAmountReceivedAmount = function (options) {
    return getTotalNetAmountReceivedAmount(this, options);
  };

  Collective.prototype.getTotalNetAmountReceived = function (options) {
    return getTotalNetAmountReceivedAmount(this, options).then(result => result.value);
  };

  Collective.prototype.getTotalMoneyManaged = function (options) {
    return getTotalMoneyManagedAmount(this, options).then(result => result.value);
  };

  Collective.prototype.getTotalMoneyManagedAmount = function (options) {
    return getTotalMoneyManagedAmount(this, options);
  };

  /**
   * Get the total amount spent by this collective, either directly or by
   * others through generated gift cards.
   */
  Collective.prototype.getTotalAmountSpent = function (startDate, endDate) {
    endDate = endDate || new Date();
    const createdAt = startDate ? { [Op.lt]: endDate, [Op.gte]: startDate } : { [Op.lt]: endDate };

    return models.Transaction.findAll({
      attributes: [
        'currency',
        [Sequelize.fn('COALESCE', Sequelize.fn('SUM', Sequelize.col('netAmountInCollectiveCurrency')), 0), 'total'],
      ],
      group: ['currency'],
      where: {
        type: 'DEBIT',
        createdAt: createdAt,
        ExpenseId: null,
        [Op.or]: {
          CollectiveId: this.id,
          UsingGiftCardFromCollectiveId: this.id,
        },
      },
      raw: true,
    }).then(async result => {
      let totalAmount = 0;
      for (const amount of result) {
        let total = -parseInt(amount.total, 10);
        if (amount.currency !== this.currency) {
          const fxRate = await getFxRate(amount.currency, this.currency);
          total = fxRate * total;
        }
        totalAmount = total + totalAmount;
      }
      return Math.round(totalAmount);
    });
  };

  // Get the average monthly spending based on last 90 days
  Collective.prototype.getMonthlySpending = function () {
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
  Collective.prototype.transactionsWhereQuery = function (includeUsedGiftCardsEmittedByOthers = true) {
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
  Collective.prototype.getTransactions = function ({
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
    const query = { where: this.transactionsWhereQuery(includeUsedGiftCardsEmittedByOthers) };

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
  Collective.prototype.getTaxType = function () {
    if (this.settings?.VAT) {
      return TaxType.VAT;
    } else if (this.settings?.GST) {
      return TaxType.GST;
    }
  };

  Collective.prototype.getTotalTransactions = function (
    startDate,
    endDate,
    type,
    attribute = 'netAmountInCollectiveCurrency',
  ) {
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
  Collective.prototype.getLatestTransactions = function (since, until, tags) {
    const conditionOnCollective = {};
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

  Collective.prototype.isHost = function () {
    if (this.isHostAccount) {
      return Promise.resolve(true);
    }

    if (this.type !== 'ORGANIZATION' && this.type !== 'USER') {
      return Promise.resolve(false);
    }

    return models.Member.findOne({ where: { MemberCollectiveId: this.id, role: 'HOST' } }).then(r => Boolean(r));
  };

  Collective.prototype.isHostOf = function (CollectiveId) {
    return models.Collective.findOne({
      where: { id: CollectiveId, HostCollectiveId: this.id },
    }).then(r => Boolean(r));
  };

  Collective.prototype.getRelatedCollectives = function (
    limit = 3,
    minTotalDonationInCents = 10000,
    orderBy,
    orderDir,
  ) {
    return Collective.getCollectivesSummaryByTag(
      this.tags,
      limit,
      [this.id],
      minTotalDonationInCents,
      true,
      orderBy,
      orderDir,
    ).then(({ collectives }) => collectives);
  };

  // get the host of the parent collective if any, or of this collective
  Collective.prototype.getHostCollective = function () {
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

  Collective.prototype.getHostCollectiveId = function () {
    if (this.HostCollectiveId) {
      return Promise.resolve(this.HostCollectiveId);
    }
    return models.Collective.getHostCollectiveId(this.ParentCollectiveId || this.id).then(HostCollectiveId => {
      this.HostCollectiveId = HostCollectiveId;
      return HostCollectiveId;
    });
  };

  Collective.prototype.getHostStripeAccount = function () {
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

  Collective.prototype.getTopBackers = async function (since, until, limit) {
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

  Collective.prototype.getImageUrl = function (args = {}) {
    return getCollectiveAvatarUrl(this.slug, this.type, this.image, args);
  };

  Collective.prototype.getBackgroundImageUrl = function (args = {}) {
    if (!this.backgroundImage) {
      return null;
    }

    const sections = [config.host.images, this.slug];

    sections.push(md5(this.backgroundImage).substring(0, 7));

    sections.push('background');

    if (args.height) {
      sections.push(args.height);
    }

    return `${sections.join('/')}.${args.format || 'png'}`;
  };

  Collective.prototype.getHostedCollectivesCount = function () {
    // This method is intended for hosts
    if (!this.isHostAccount) {
      return Promise.resolve(null);
    }
    return models.Collective.count({
      where: { HostCollectiveId: this.id, type: types.COLLECTIVE, isActive: true },
    });
  };

  Collective.prototype.getTotalAddedFunds = async function () {
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

  Collective.prototype.getTotalTransferwisePayouts = async function () {
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

  Collective.prototype.getTotalBankTransfers = async function () {
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

  Collective.prototype.getPlan = async function () {
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
   * @param {Date} from Defaults to beginning of the current month.
   * @param {Date} [to] Optional, defaults to the end of the 'from' month and 'from' is reseted to the beginning of its month.
   */
  Collective.prototype.getHostMetrics = async function (from, to) {
    if (!this.isHostAccount || !this.isActive || this.type !== types.ORGANIZATION) {
      return null;
    }

    from = from ? moment(from) : moment().utc().startOf('month');
    to = to ? moment(to) : moment(from).utc().endOf('month');

    const plan = await this.getPlan();
    const hostFeeSharePercent = plan.hostFeeSharePercent || 0;

    const hostFees = await getHostFees(this, { startDate: from, endDate: to });

    const hostFeeShare = await getHostFeeShare(this, { startDate: from, endDate: to });
    const pendingHostFeeShare = await getPendingHostFeeShare(this, { startDate: from, endDate: to });
    const settledHostFeeShare = hostFeeShare - pendingHostFeeShare;

    const totalMoneyManaged = await this.getTotalMoneyManaged({ endDate: to });

    const platformTips = await getPlatformTips(this, { startDate: from, endDate: to });
    const pendingPlatformTips = await getPendingPlatformTips(this, { startDate: from, endDate: to });

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

  /**
   * Class Methods
   */
  Collective.createOrganization = async (collectiveData, adminUser, creator = {}) => {
    const CreatedByUserId = creator.id || adminUser.id;
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
    await models.Activity.create({
      type: activities.ORGANIZATION_COLLECTIVE_CREATED,
      UserId: adminUser.id,
      CollectiveId: collective.id,
      data: {
        collective: pick(collective, ['name', 'slug']),
      },
    });
    return collective;
  };

  Collective.createMany = (collectives, defaultValues) => {
    return Promise.map(collectives, u => Collective.create(defaults({}, u, defaultValues)), { concurrency: 1 }).catch(
      logger.error,
    );
  };

  Collective.getTopBackers = async (since, until, tags, limit) => {
    const backers = await queries.getTopBackers(since || 0, until || new Date(), tags, limit || 5);
    debug(
      'getTopBackers',
      backers.map(b => b.dataValues),
    );
    return backers;
  };

  Collective.prototype.doesUserHaveTotalExpensesOverThreshold = async function ({ threshold, year, UserId }) {
    const { PENDING, APPROVED, PAID, PROCESSING } = expenseStatus;
    const since = moment({ year });
    const until = moment({ year }).add(1, 'y');
    const status = [PENDING, APPROVED, PAID, PROCESSING];
    const excludedTypes = [expenseTypes.RECEIPT];

    const expenses = await this.getExpensesForHost(status, since, until, UserId, excludedTypes);

    const userTotal = sumBy(expenses, 'amount');

    return userTotal >= threshold;
  };

  Collective.getHostCollectiveId = async CollectiveId => {
    const res = await models.Member.findOne({
      attributes: ['MemberCollectiveId'],
      where: { CollectiveId, role: roles.HOST },
    });
    return res && res.MemberCollectiveId;
  };

  /*
   * If there is a username suggested, we'll check that it's valid or increase it's count
   * Otherwise, we'll suggest something.
   */
  Collective.generateSlug = (suggestions, useSlugify = true) => {
    /*
     * Checks a given slug in a list and if found, increments count and recursively checks again
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

    if (useSlugify) {
      suggestions = suggestions.map(slug => slugify(slug)); // Will also trim, lowercase and remove + signs
    }

    // fetch any matching slugs or slugs for the top choice in the list above
    return models.Collective.findAll({
      attributes: ['slug'],
      where: { slug: { [Op.startsWith]: suggestions[0] } },
      paranoid: false,
      raw: true,
    })
      .then(userObjectList => userObjectList.map(user => user.slug))
      .then(slugList => slugSuggestionHelper(suggestions[0], slugList, 0));
  };

  Collective.findBySlug = (slug, options = {}, throwIfMissing = true) => {
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

  Collective.getCollectivesSummaryByTag = (
    tags,
    limit = 3,
    excludeList = [],
    minTotalDonationInCents,
    randomOrder,
    orderBy,
    orderDir,
    offset,
  ) => {
    debug(
      'getCollectivesSummaryByTag',
      tags,
      limit,
      excludeList,
      minTotalDonationInCents,
      randomOrder,
      orderBy,
      orderDir,
      offset,
    );
    return queries
      .getCollectivesByTag(tags, limit, excludeList, minTotalDonationInCents, randomOrder, orderBy, orderDir, offset)
      .then(({ collectives, total }) => {
        debug('getCollectivesSummaryByTag', collectives && collectives.length, 'collectives found');
        return Promise.all(
          collectives.map(collective => {
            debug('getCollectivesSummaryByTag', 'collective', collective.slug);
            return Promise.all([
              collective.getYearlyIncome(),
              queries
                .getMembersWithTotalDonations({ CollectiveId: collective.id }, { role: 'BACKER' })
                .then(users => models.Tier.appendTier(collective, users)),
            ]).then(results => {
              const usersByRole = {};
              const users = results[1];
              users.map(user => {
                usersByRole[user.dataValues.role] = usersByRole[user.dataValues.role] || [];
                usersByRole[user.dataValues.role].push(user);
              });
              const collectiveInfo = collective.card;
              collectiveInfo.yearlyIncome = results[0];
              const backers = usersByRole[roles.BACKER] || [];
              collectiveInfo.backersAndSponsorsCount = backers.length;
              collectiveInfo.membersCount = (usersByRole[roles.ADMIN] || []).length;
              collectiveInfo.sponsorsCount = backers.filter(b => b.tier && b.tier.name.match(/sponsor/i)).length;
              collectiveInfo.backersCount = collectiveInfo.backersAndSponsorsCount - collectiveInfo.sponsorsCount;
              collectiveInfo.githubContributorsCount =
                collective.data && collective.data.githubContributors
                  ? Object.keys(collective.data.githubContributors).length
                  : 0;
              collectiveInfo.contributorsCount =
                collectiveInfo.membersCount +
                collectiveInfo.githubContributorsCount +
                collectiveInfo.backersAndSponsorsCount;
              return collectiveInfo;
            });
          }),
        ).then(allCollectives => ({
          total,
          collectives: allCollectives,
        }));
      });
  };

  Temporal(Collective, sequelize);

  return Collective;
}

// We're using the defineModel function to keep the indentation and have a clearer git history.
// Please consider this if you plan to refactor.
const Collective = defineModel();

export default Collective;
