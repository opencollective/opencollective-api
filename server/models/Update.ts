import Promise from 'bluebird';
import config from 'config';
import slugify from 'limax';
import { defaults, pick } from 'lodash';
import Temporal from 'sequelize-temporal';

import activities from '../constants/activities';
import MemberRoles from '../constants/roles';
import * as errors from '../graphql/errors';
import logger from '../lib/logger';
import * as SQLQueries from '../lib/queries';
import { buildSanitizerOptions, generateSummaryForHTML, sanitizeHTML } from '../lib/sanitize-html';
import { reportErrorToSentry } from '../lib/sentry';
import sequelize, { DataTypes, Op, QueryTypes } from '../lib/sequelize';
import { sanitizeTags, validateTags } from '../lib/tags';

export const sanitizerOptions = buildSanitizerOptions({
  titles: true,
  mainTitles: true,
  basicTextFormatting: true,
  multilineTextFormatting: true,
  images: true,
  links: true,
  videoIframes: true,
});

export const UPDATE_NOTIFICATION_AUDIENCE = {
  ALL: 'ALL',
  COLLECTIVE_ADMINS: 'COLLECTIVE_ADMINS',
  FINANCIAL_CONTRIBUTORS: 'FINANCIAL_CONTRIBUTORS',
  NO_ONE: 'NO_ONE',
};

/**
 * Defines the roles targeted by an update notification. Admins of the parent collective are
 * always included, regardless of the values in this array.
 */
const PRIVATE_UPDATE_TARGET_ROLES = [
  MemberRoles.ADMIN,
  MemberRoles.MEMBER,
  MemberRoles.CONTRIBUTOR,
  MemberRoles.BACKER,
  MemberRoles.ATTENDEE,
];

const PUBLIC_UPDATE_TARGET_ROLES = [...PRIVATE_UPDATE_TARGET_ROLES, MemberRoles.FOLLOWER];

const { models } = sequelize;

const Update = sequelize.define(
  'Update',
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
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
    },

    CollectiveId: {
      type: DataTypes.INTEGER,
      references: {
        model: 'Collectives',
        key: 'id',
      },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
      allowNull: false,
    },

    TierId: {
      type: DataTypes.INTEGER,
      references: {
        model: 'Tiers',
        key: 'id',
      },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
      allowNull: true,
    },

    FromCollectiveId: {
      type: DataTypes.INTEGER,
      references: {
        model: 'Collectives',
        key: 'id',
      },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
      allowNull: true,
    },

    CreatedByUserId: {
      type: DataTypes.INTEGER,
      references: {
        model: 'Users',
        key: 'id',
      },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
      allowNull: true, // non authenticated users can create a Update
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

    title: {
      type: DataTypes.STRING,
      set(title) {
        this.setDataValue('title', title.replace(/\s+/g, ' ').trim());
      },
      validate: {
        len: [1, 255],
      },
    },

    html: {
      type: DataTypes.TEXT,
      set(html) {
        this.setDataValue('html', sanitizeHTML(html, sanitizerOptions));
        this.setDataValue('summary', generateSummaryForHTML(html, 240));
      },
    },

    image: DataTypes.STRING,

    isPrivate: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },

    isChangelog: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },

    notificationAudience: {
      type: DataTypes.STRING,
      defaultValue: null,
    },

    tags: {
      type: DataTypes.ARRAY(DataTypes.STRING),
      validate: {
        validateTags,
      },
      set: function (tags) {
        this.setDataValue('tags', sanitizeTags(tags));
      },
    },

    publishedAt: {
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

    makePublicOn: {
      type: DataTypes.DATE,
      defaultValue: null,
    },

    summary: {
      type: DataTypes.STRING,
    },
  },
  {
    paranoid: true,

    getterMethods: {
      // Info.
      info() {
        return {
          id: this.id,
          title: this.title,
          html: this.html,
          image: this.image,
          createdAt: this.createdAt,
          updatedAt: this.updatedAt,
          publishedAt: this.publishedAt,
          isPrivate: this.isPrivate,
          isChangelog: this.isChangelog,
          slug: this.slug,
          tags: this.tags,
          CollectiveId: this.CollectiveId,
        };
      },
      minimal() {
        return {
          id: this.id,
          publishedAt: this.publishedAt,
          title: this.title,
          image: this.image,
          slug: this.slug,
        };
      },
      activity() {
        return {
          id: this.id,
          slug: this.slug,
          title: this.title,
          html: this.html,
          notificationAudience: this.notificationAudience,
          CollectiveId: this.CollectiveId,
          FromCollectiveId: this.FromCollectiveId,
          TierId: this.TierId,
          isPrivate: this.isPrivate,
          isChangelog: this.isChangelog,
        };
      },
    },

    hooks: {
      beforeValidate: instance => {
        if (!instance.publishedAt || !instance.slug) {
          return instance.generateSlug();
        }
      },
      beforeUpdate: instance => {
        if (!instance.publishedAt || !instance.slug) {
          return instance.generateSlug();
        }
      },
      beforeDestroy: async instance => {
        const newSlug = `${instance.slug}-${Date.now()}`;
        instance.slug = newSlug;
        await instance.save({ paranoid: false, hooks: false });
      },
      afterCreate: instance => {
        models.Activity.create({
          type: activities.COLLECTIVE_UPDATE_CREATED,
          UserId: instance.CreatedByUserId,
          CollectiveId: instance.CollectiveId,
          FromCollectiveId: instance.FromCollectiveId,
          // TODO(InconsistentActivities): Should have HostCollectiveId
          data: {
            update: instance.activity,
          },
        });
      },
    },
  },
);

/**
 * Instance Methods
 */

// Edit an update
Update.prototype.edit = async function (remoteUser, newUpdateData) {
  if (newUpdateData.TierId) {
    const tier = await models.Tier.findByPk(newUpdateData.TierId);
    if (!tier) {
      throw new errors.ValidationFailed('Tier not found');
    }
    if (tier.CollectiveId !== this.CollectiveId) {
      throw new errors.ValidationFailed("Cannot link this update to a Tier that doesn't belong to this collective");
    }
  }

  const editableAttributes = ['TierId', 'title', 'html', 'tags', 'isPrivate', 'isChangelog', 'makePublicOn'];

  return await this.update({
    ...pick(newUpdateData, editableAttributes),
    LastEditedByUserId: remoteUser.id,
  });
};

// Publish update
Update.prototype.publish = async function (remoteUser, notificationAudience) {
  this.publishedAt = new Date();
  this.notificationAudience = notificationAudience;
  this.collective = this.collective || (await models.Collective.findByPk(this.CollectiveId));
  this.fromCollective = this.fromCollective || (await models.Collective.findByPk(this.FromCollectiveId));

  models.Activity.create({
    type: activities.COLLECTIVE_UPDATE_PUBLISHED,
    UserId: remoteUser.id,
    CollectiveId: this.CollectiveId,
    FromCollectiveId: this.FromCollectiveId,
    HostCollectiveId: this.collective.approvedAt ? this.collective.HostCollectiveId : null,
    data: {
      fromCollective: this.fromCollective.activity,
      collective: this.collective.activity,
      update: this.activity,
      url: `${config.host.website}/${this.collective.slug}/updates/${this.slug}`,
    },
  });
  return await this.save();
};

// Unpublish update
Update.prototype.unpublish = async function (remoteUser) {
  return this.update({ LastEditedByUserId: remoteUser.id, publishedAt: null });
};

Update.prototype.delete = async function (remoteUser) {
  await models.Comment.destroy({ where: { UpdateId: this.id } });
  await models.Update.update({ deletedAt: new Date(), LastEditedByUserId: remoteUser.id }, { where: { id: this.id } });

  return this;
};

// Returns the User model of the User that created this Update
Update.prototype.getUser = function () {
  return models.User.findByPk(this.CreatedByUserId);
};

Update.prototype.includeHostedAccountsInNotification = async function (notificationAudience) {
  this.collective = this.collective || (await this.getCollective());
  const audience = notificationAudience || this.notificationAudience || 'ALL';
  const audiencesForHostedAccounts = ['ALL', 'COLLECTIVE_ADMINS'];
  return Boolean(this.collective.isHostAccount && audiencesForHostedAccounts.includes(audience));
};

Update.prototype.getTargetMembersRoles = function (notificationAudience) {
  const audience = notificationAudience || this.notificationAudience || 'ALL';
  if (audience === 'COLLECTIVE_ADMINS') {
    return ['__NONE__'];
  } else if (this.isPrivate) {
    return PRIVATE_UPDATE_TARGET_ROLES;
  } else {
    return PUBLIC_UPDATE_TARGET_ROLES;
  }
};

/**
 * Get the member users to notify for this update.
 */
Update.prototype.getUsersToNotify = async function () {
  const audience = this.notificationAudience || 'ALL';

  if (audience === 'NO_ONE') {
    return [];
  }

  return sequelize.query(SQLQueries.usersToNotifyForUpdateSQLQuery, {
    type: sequelize.QueryTypes.SELECT,
    mapToModel: true,
    model: models.User,
    replacements: {
      collectiveId: this.CollectiveId,
      targetRoles: this.getTargetMembersRoles(),
      includeHostedAccounts: await this.includeHostedAccountsInNotification(),
      includeMembers: audience !== 'COLLECTIVE_ADMINS',
    },
  });
};

/**
 * Gets a summary of how many users will be notified about this update
 *
 * @argument notificationAudience - to override the update audience
 */
Update.prototype.countUsersToNotify = async function (notificationAudience) {
  this.collective = this.collective || (await this.getCollective());
  const audience = notificationAudience || this.notificationAudience || 'ALL';

  if (audience === 'NO_ONE') {
    return 0;
  }

  const [result] = await sequelize.query(SQLQueries.countUsersToNotifyForUpdateSQLQuery, {
    type: sequelize.QueryTypes.SELECT,
    replacements: {
      collectiveId: this.CollectiveId,
      targetRoles: this.getTargetMembersRoles(audience),
      includeHostedAccounts: await this.includeHostedAccountsInNotification(audience),
      includeMembers: audience !== 'COLLECTIVE_ADMINS',
    },
  });

  return result.count;
};

/**
 * Gets a summary of who will be notified about this update
 */
Update.prototype.getAudienceMembersStats = async function (audience) {
  const result = await sequelize.query(SQLQueries.countMembersToNotifyForUpdateSQLQuery, {
    type: sequelize.QueryTypes.SELECT,
    replacements: {
      collectiveId: this.CollectiveId,
      targetRoles: this.getTargetMembersRoles(audience),
    },
  });

  return result.reduce((stats, { type, count }) => {
    stats[type] = count;
    return stats;
  }, {});
};

/*
 * If there is a username suggested, we'll check that it's valid or increase it's count
 * Otherwise, we'll suggest something.
 */
Update.prototype.generateSlug = function () {
  if (!this.title) {
    return;
  }
  const suggestion = slugify(this.title.trim()).toLowerCase(/\./g, '');

  /*
   * Checks a given slug in a list and if found, increments count and recursively checks again
   */
  const slugSuggestionHelper = (slugToCheck, slugList, count) => {
    const slug = count > 0 ? `${slugToCheck}${count}` : slugToCheck;
    if (slugList.indexOf(slug) === -1) {
      return slug;
    } else {
      return slugSuggestionHelper(`${slugToCheck}`, slugList, count + 1);
    }
  };

  // fetch any matching slugs or slugs for the top choice in the list above
  return sequelize
    .query(
      `
        SELECT slug FROM "Updates" WHERE "CollectiveId"=${this.CollectiveId} AND slug like '${suggestion}%'
      `,
      {
        type: QueryTypes.SELECT,
      },
    )
    .then(updateObjectList => updateObjectList.map(update => update.slug))
    .then(slugList => slugSuggestionHelper(suggestion, slugList, 0))
    .then(slug => {
      if (!slug) {
        return Promise.reject(new Error("We couldn't generate a unique slug for this Update"));
      }
      this.slug = slug;
    });
};

Update.makeUpdatesPublic = function () {
  const today = new Date().setUTCHours(0, 0, 0, 0);
  return models.Update.update(
    {
      isPrivate: false,
    },
    {
      where: {
        isPrivate: true,
        makePublicOn: { [Op.lte]: today },
      },
    },
  ).then(([affectedCount]) => {
    logger.info(`Number of private updates made public: ${affectedCount}`);
  });
};

Update.createMany = (updates, defaultValues) => {
  return Promise.map(updates, u => Update.create(defaults({}, u, defaultValues)), { concurrency: 1 }).catch(err => {
    console.error(err);
    reportErrorToSentry(err);
  });
};

Temporal(Update, sequelize);

export default Update;
