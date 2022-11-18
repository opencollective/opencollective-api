import Promise from 'bluebird';
import debugLib from 'debug';
import slugify from 'limax';
import { defaults, min } from 'lodash';
import Temporal from 'sequelize-temporal';

import { maxInteger } from '../constants/math';
import orderStatus from '../constants/order_status';
import { buildSanitizerOptions, sanitizeHTML } from '../lib/sanitize-html';
import sequelize, { DataTypes, Op } from '../lib/sequelize';
import { capitalize, days, formatCurrency } from '../lib/utils';
import { isSupportedVideoProvider, supportedVideoProviders } from '../lib/validators';

import CustomDataTypes from './DataTypes';

const debug = debugLib('models:Tier');

const longDescriptionSanitizerOpts = buildSanitizerOptions({
  titles: true,
  basicTextFormatting: true,
  multilineTextFormatting: true,
  imagesInternal: true,
  links: true,
  videoIframes: true,
});

const { models } = sequelize;

const Tier = sequelize.define(
  'Tier',
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

    // human readable way to uniquely access a tier for a given collective or collective/event combo
    slug: {
      type: DataTypes.STRING,
      validate: {
        len: [1, 255],
      },
      set(slug) {
        if (slug && slug.toLowerCase) {
          this.setDataValue('slug', slugify(slug));
        }
      },
    },

    name: {
      type: DataTypes.STRING,
      allowNull: false,
      set(name) {
        this.setDataValue('name', name);

        if (!this.getDataValue('slug')) {
          // Try to generate the slug from the name. If it fails, for example if tier
          // name is '😵️' we gracefully fallback on tier type
          const slugFromName = slugify(name);
          const slug = slugFromName || slugify(this.type || 'TIER');
          this.setDataValue('slug', slug);
        }
      },
      validate: {
        isValidName(value) {
          if (!value || value.trim().length === 0) {
            throw new Error('Name field is required for all tiers');
          }
        },
      },
    },

    type: {
      type: DataTypes.STRING, // TIER, TICKET, DONATION, SERVICE, PRODUCT, MEMBERSHIP
      defaultValue: 'TIER',
    },

    description: {
      type: DataTypes.STRING(510),
      validate: {
        length(description) {
          if (description?.length > 510) {
            const tierName = this.getDataValue('name');
            throw new Error(`In "${tierName}" tier, the description is too long (must be less than 510 characters)`);
          }
        },
      },
    },

    longDescription: {
      type: DataTypes.TEXT,
      validate: {
        // Max length for around 1_000_000 characters ~4MB of text
        len: [0, 1000000],
      },
      set(content) {
        if (!content) {
          this.setDataValue('longDescription', null);
        } else {
          this.setDataValue('longDescription', sanitizeHTML(content, longDescriptionSanitizerOpts));
        }
      },
    },

    useStandalonePage: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },

    videoUrl: {
      type: DataTypes.STRING,
      validate: {
        isUrl: true,
        /** Ensure that the URL points toward a supported video provider */
        isSupportedProvider(url) {
          if (!url) {
            return;
          } else if (!isSupportedVideoProvider(url)) {
            throw new Error(`Only the following video providers are supported: ${supportedVideoProviders.join(', ')}`);
          }
        },
      },
      set(url) {
        // Store null if URL is empty
        this.setDataValue('videoUrl', url || null);
      },
    },

    button: DataTypes.STRING,

    amount: {
      type: DataTypes.INTEGER, // In cents
      allowNull: true,
      validate: {
        min: 0,
        validateFixedAmount(value) {
          if (this.type !== 'TICKET' && this.amountType === 'FIXED' && (value === null || value === undefined)) {
            throw new Error(`In ${this.name}'s tier, "Amount" is required`);
          }
        },
        validateFlexibleAmount(value) {
          if (this.amountType === 'FLEXIBLE' && this.presets && this.presets.indexOf(value) === -1) {
            throw new Error(`In ${this.name}'s tier, "Default amount" must be one of suggested values amounts`);
          }
        },
      },
    },

    presets: {
      type: DataTypes.ARRAY(DataTypes.INTEGER),
    },

    amountType: {
      type: DataTypes.ENUM('FLEXIBLE', 'FIXED'),
      allowNull: false,
      defaultValue: 'FIXED',
    },

    minimumAmount: {
      type: DataTypes.INTEGER,
      validate: {
        min: 0,
        isValidMinAmount(value) {
          const minPreset = this.presets ? Math.min(...this.presets) : null;
          if (this.amountType === 'FLEXIBLE' && value && minPreset < value) {
            throw new Error(`In ${this.name}'s tier, minimum amount cannot be less than minimum suggested amounts`);
          }
        },
      },
    },

    currency: CustomDataTypes(DataTypes).currency,

    interval: {
      type: DataTypes.STRING(8),
      validate: {
        isIn: {
          args: [['month', 'year', 'flexible']],
          msg: 'Must be month, year or flexible',
        },
        isValidTier(value) {
          if (this.amountType === 'FIXED' && value === 'flexible') {
            throw new Error(
              `In ${this.name}'s tier, "flexible" interval can not be selected with "fixed" amount type.`,
            );
          }
        },
      },
    },

    // Max quantity of tickets to sell (0 for unlimited)
    maxQuantity: {
      type: DataTypes.INTEGER,
      validate: {
        min: 0,
      },
    },

    // Goal to reach
    goal: {
      type: DataTypes.INTEGER,
      validate: {
        min: 0,
      },
    },

    customFields: {
      type: DataTypes.JSONB,
    },

    data: {
      type: DataTypes.JSONB,
    },

    startsAt: {
      type: DataTypes.DATE,
    },

    endsAt: {
      type: DataTypes.DATE,
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
  },
  {
    paranoid: true,

    getterMethods: {
      info() {
        return {
          id: this.id,
          name: this.name,
          description: this.description,
          amount: this.amount,
          interval: this.interval,
          currency: this.currency,
          maxQuantity: this.maxQuantity,
          startsAt: this.startsAt,
          endsAt: this.endsAt,
          createdAt: this.createdAt,
          updatedAt: this.updatedAt,
        };
      },

      minimal() {
        return {
          id: this.id,
          type: this.type,
          name: this.name,
        };
      },

      title() {
        return capitalize(this.name);
      },

      amountStr() {
        let str;
        if (this.amountType === 'FLEXIBLE') {
          str = `${formatCurrency(this.minimumAmount || 0, this.currency)}+`;
        } else {
          str = `${formatCurrency(this.amount || 0, this.currency)}`;
        }

        if (this.interval && this.interval !== 'flexible') {
          str += ` per ${this.interval}`;
        }
        return str;
      },
    },
  },
);

/**
 * Instance Methods
 */

/**
 * Check if a backer is active
 * True if there is an entry in the Members table for this Backer/Collective/Tier couple created before `until`
 * If this tier has an interval, returns true if the membership started within the month/year
 * or if the last transaction happened wihtin the month/year
 */
Tier.prototype.isBackerActive = function (backerCollective, until = new Date()) {
  return models.Member.findOne({
    where: {
      CollectiveId: this.CollectiveId,
      MemberCollectiveId: backerCollective.id,
      TierId: this.id,
      createdAt: { [Op.lte]: until },
    },
  }).then(membership => {
    if (!membership) {
      return false;
    }
    if (!this.interval) {
      return true;
    }
    if (this.interval === 'month' && days(membership.createdAt, until) <= 31) {
      return true;
    }
    if (this.interval === 'year' && days(membership.createdAt, until) <= 365) {
      return true;
    }
    return models.Order.findOne({
      where: {
        CollectiveId: this.CollectiveId,
        FromCollectiveId: backerCollective.id,
        TierId: this.id,
      },
    }).then(order => {
      if (!order) {
        return false;
      }
      return models.Transaction.findOne({
        where: { OrderId: order.id, CollectiveId: this.CollectiveId },
        order: [['createdAt', 'DESC']],
      }).then(transaction => {
        if (!transaction) {
          debug('No transaction found for order', order.dataValues);
          return false;
        }
        if (order.interval === 'month' && days(transaction.createdAt, until) <= 31) {
          return true;
        }
        if (order.interval === 'year' && days(transaction.createdAt, until) <= 365) {
          return true;
        }
        return false;
      });
    });
  });
};

Tier.prototype.availableQuantity = function () {
  if (!this.maxQuantity) {
    return Promise.resolve(maxInteger);
  }

  return models.Order.sum('quantity', {
    where: {
      TierId: this.id,
      status: { [Op.notIn]: [orderStatus.ERROR, orderStatus.CANCELLED, orderStatus.EXPIRED, orderStatus.REJECTED] },
      processedAt: { [Op.ne]: null },
    },
  }).then(usedQuantity => {
    debug('availableQuantity', 'usedQuantity:', usedQuantity, 'maxQuantity', this.maxQuantity);
    if (this.maxQuantity && usedQuantity) {
      return this.maxQuantity - usedQuantity;
    } else if (this.maxQuantity) {
      return this.maxQuantity;
    } else {
      return maxInteger; // GraphQL doesn't like infinity
    }
  });
};

Tier.prototype.checkAvailableQuantity = function (quantityNeeded = 1) {
  return this.availableQuantity().then(available => available - quantityNeeded >= 0);
};

Tier.prototype.setCurrency = async function (currency) {
  // Nothing to do
  if (currency === this.currency) {
    return this;
  }

  return this.update({ currency });
};

/**
 * To check if free contributions are possible for this tier
 */
Tier.prototype.requiresPayment = function () {
  if (this.amountType === 'FIXED') {
    return Boolean(this.amount);
  } else if (this.minimumAmount !== null) {
    return Boolean(this.minimumAmount);
  } else if (this.presets?.length && min(this.presets) === 0) {
    return false;
  } else {
    return true;
  }
};

/**
 * Class Methods
 */
Tier.createMany = (tiers, defaultValues = {}) => {
  return Promise.map(tiers, t => Tier.create(defaults({}, t, defaultValues)), { concurrency: 1 });
};

/**
 * Append tier to each backer in an array of backers
 */
Tier.appendTier = (collective, backerCollectives) => {
  const backerCollectivesIds = backerCollectives.map(b => b.id);
  debug('appendTier', collective.name, 'backers: ', backerCollectives.length);
  return models.Member.findAll({
    where: {
      MemberCollectiveId: { [Op.in]: backerCollectivesIds },
      CollectiveId: collective.id,
    },
    include: [{ model: models.Tier }],
  }).then(memberships => {
    const membershipsForBackerCollective = {};
    memberships.map(m => {
      membershipsForBackerCollective[m.MemberCollectiveId] = m.Tier;
    });
    return backerCollectives.map(backerCollective => {
      backerCollective.tier = membershipsForBackerCollective[backerCollective.id];
      debug('appendTier for', backerCollective.name, ':', backerCollective.tier && backerCollective.tier.slug);
      return backerCollective;
    });
  });
};

Temporal(Tier, sequelize);

export default Tier;
