import debugLib from 'debug';
import { compact, defaults, isNil, keys, pick, pickBy, reject, uniq } from 'lodash-es';
import prependHttp from 'prepend-http';
import { CreationOptional, InferAttributes, InferCreationAttributes } from 'sequelize';
import validator from 'validator';

import ActivityTypes, { ActivitiesPerClass, ActivityClasses, TransactionalActivities } from '../constants/activities.js';
import channels from '../constants/channels.js';
import { ValidationFailed } from '../graphql/errors.js';
import sequelize, { DataTypes, Model, Op } from '../lib/sequelize.js';
import { getRootDomain } from '../lib/url-utils.js';

import models, { Collective } from './index.js';
import User from './User.js';

const debug = debugLib('models:Notification');

const DEFAULT_ACTIVE_STATE_BY_CHANNEL = {
  [channels.EMAIL]: true,
  [channels.SLACK]: false,
  [channels.TWITTER]: false,
  [channels.WEBHOOK]: false,
};

export class Notification extends Model<InferAttributes<Notification>, InferCreationAttributes<Notification>> {
  public declare readonly id: CreationOptional<number>;
  public declare channel: channels;
  public declare type: ActivityTypes | ActivityClasses | string;
  public declare active: boolean;
  public declare createdAt: CreationOptional<Date>;
  public declare CollectiveId: CreationOptional<number>;
  public declare UserId: CreationOptional<number>;
  public declare webhookUrl: CreationOptional<string>;
  public declare User?: User;
  public declare Collective?: Collective;

  getUser() {
    return models.User.findByPk(this.UserId);
  }

  static async createMany(
    notifications: InferCreationAttributes<Notification>[],
    defaultValues?: InferCreationAttributes<Notification>,
  ): Promise<Notification[]> {
    return Promise.all(notifications.map(u => Notification.create(defaults({}, u, defaultValues))));
  }

  static async unsubscribe(
    type: ActivityTypes | ActivityClasses,
    channel: channels,
    UserId: number = null,
    CollectiveId: number = null,
    webhookUrl: string = null,
  ) {
    const isClass = Object.values(ActivityClasses).includes(type as ActivityClasses);
    if (TransactionalActivities.includes(type as ActivityTypes)) {
      throw new Error(`Cannot remove transactional activity ${type}`);
    } else if (channel === channels.EMAIL && !UserId) {
      throw new Error(`You need to pass UserId if unsubscribing from email`);
    }

    return sequelize.transaction(async transaction => {
      let notification = await Notification.findOne({
        where: { UserId, CollectiveId, type, channel, webhookUrl },
        transaction,
      });

      if (DEFAULT_ACTIVE_STATE_BY_CHANNEL[channel] === true) {
        if (!notification) {
          notification = await Notification.create(
            { UserId, CollectiveId, type, channel, active: false, webhookUrl },
            { transaction },
          );
        } else if (notification.active === true) {
          await notification.update({ active: false }, { transaction });
        }

        // If user is unsubscribing from ActivityClass, remove existing Notifications for any included ActivityType
        if ((isClass || type === ActivityTypes.ACTIVITY_ALL) && UserId) {
          await Notification.destroy({
            where: {
              type: isClass ? { [Op.in]: ActivitiesPerClass[type] } : { [Op.ne]: ActivityTypes.ACTIVITY_ALL },
              UserId,
              CollectiveId,
              channel,
            },
            transaction,
          });
        }
      } else {
        await Notification.destroy({
          where: { type, channel, UserId, CollectiveId, active: true, webhookUrl },
          transaction,
        });
      }

      return notification;
    });
  }

  static async subscribe(
    type: ActivityTypes | ActivityClasses,
    channel: channels,
    UserId: number = null,
    CollectiveId: number = null,
    webhookUrl: string = null,
  ) {
    if (channel === channels.EMAIL && !UserId) {
      throw new Error(`You need to pass UserId if subscribing to email`);
    }

    const isClass = Object.values(ActivityClasses).includes(type as ActivityClasses);
    return sequelize.transaction(async transaction => {
      if (DEFAULT_ACTIVE_STATE_BY_CHANNEL[channel] === true) {
        await Notification.destroy({ where: { type, channel, UserId, CollectiveId, active: false }, transaction });

        // If subscribing from ActivityClass, remove existing unsubscription for its ActivityTypes
        if ((isClass || type === ActivityTypes.ACTIVITY_ALL) && UserId) {
          await Notification.destroy({
            where: {
              type: isClass ? { [Op.in]: ActivitiesPerClass[type] } : { [Op.ne]: ActivityTypes.ACTIVITY_ALL },
              channel,
              UserId,
              CollectiveId,
              active: false,
            },
            transaction,
          });
        }
      } else {
        let notification = await Notification.findOne({
          where: { UserId, CollectiveId, type, channel, webhookUrl },
          transaction,
        });
        if (!notification) {
          notification = await Notification.create(
            { UserId, CollectiveId, type, channel, active: true, webhookUrl },
            { transaction },
          );
        } else if (notification.active === false) {
          await notification.update({ active: true }, { transaction });
        }
      }
    });
  }

  /**
   * Get the list of subscribers to a mailing list
   * (e.g. backers@:collectiveSlug.opencollective.com, :eventSlug@:collectiveSlug.opencollective.com)
   * We exclude users that have unsubscribed (by looking for rows in the Notifications table that are active: false)
   */
  static async getSubscribers(collectiveSlug: string | number, mailinglist: string) {
    const findByAttribute = typeof collectiveSlug === 'string' ? 'findBySlug' : 'findById';
    const collective = await models.Collective[findByAttribute](collectiveSlug);

    const getMembersForEvent = mailinglist =>
      models.Collective.findOne({
        where: { slug: mailinglist, type: 'EVENT' },
      }).then(event => {
        if (!event) {
          throw new Error('mailinglist_not_found');
        }
        debug('getMembersForEvent', event.slug);
        return event.getMembers();
      });

    debug('getSubscribers', findByAttribute, collectiveSlug, 'found:', collective.slug, 'mailinglist:', mailinglist);
    const excludeUnsubscribed = members => {
      debug('excludeUnsubscribed: need to filter', members && members.length, 'members');
      if (!members || members.length === 0) {
        return [];
      }

      return Notification.getUnsubscribersUserIds(`mailinglist.${mailinglist}`, collective.id).then(excludeIds => {
        debug('excluding', excludeIds.length, 'members');
        return members.filter(m => excludeIds.indexOf(m.CreatedByUserId) === -1);
      });
    };

    const getMembersForMailingList = () => {
      switch (mailinglist) {
        case 'backers':
          return collective.getMembers({ where: { role: 'BACKER' } });
        case 'admins':
          return collective.getMembers({ where: { role: 'ADMIN' } });
        default:
          return getMembersForEvent(mailinglist);
      }
    };

    return getMembersForMailingList().then(excludeUnsubscribed);
  }

  static async getSubscribersUsers(collectiveSlug: string, mailinglist: string) {
    debug('getSubscribersUsers', collectiveSlug, mailinglist);
    const memberships = await Notification.getSubscribers(collectiveSlug, mailinglist);
    if (!memberships || memberships.length === 0) {
      return [];
    }
    return models.User.findAll({
      where: {
        CollectiveId: { [Op.in]: memberships.map(m => m.MemberCollectiveId) },
      },
    });
  }

  static async getSubscribersCollectives(collectiveSlug: string, mailinglist: string) {
    debug('getSubscribersCollectives', collectiveSlug, mailinglist);
    const memberships = await Notification.getSubscribers(collectiveSlug, mailinglist);
    if (!memberships || memberships.length === 0) {
      return [];
    }
    return models.Collective.findAll({
      where: {
        id: { [Op.in]: memberships.map(m => m.MemberCollectiveId) },
      },
    });
  }

  /**
   * Get an array of all the UserId that have unsubscribed from the `notificationType` notification for (optional) CollectiveId
   * @deprecated: use getUnsubscribers instead
   */
  static async getUnsubscribersUserIds(notificationType: string, CollectiveId?: number) {
    debug('getUnsubscribersUserIds', notificationType, CollectiveId);
    const notifications = await Notification.findAll({
      attributes: ['UserId'],
      where: {
        CollectiveId,
        type: notificationType,
        active: false,
      },
    });

    return notifications.map(us => us.UserId);
  }

  static async getUnsubscribers(_where: {
    type?: ActivityClasses | ActivityTypes;
    CollectiveId?: number;
    UserId?: number | number[];
    channel?: channels;
    attributes?: string[];
  }) {
    debug('getUnsubscribers', _where);
    // Enforce that there are no unsubscribers for transactional activities.
    // These are the activities we're required to notify users about.
    if (TransactionalActivities.includes(_where.type as ActivityTypes)) {
      return [];
    }

    const getUsers = notifications => notifications.map(notification => notification.User);

    const userAttributes = _where.attributes && uniq([..._where.attributes, 'id']);
    const include = [{ model: models.User, required: true, attributes: userAttributes }];
    const where = { active: false, ...pick(_where, ['UserId', 'channel']) };

    const classes = keys(pickBy(ActivitiesPerClass, array => array.includes(_where.type as ActivityTypes)));
    where['type'] = compact([_where.type, `${_where.type}.for.host`, ...classes]);

    const collective = _where.CollectiveId && (await models.Collective.findByPk(_where.CollectiveId));
    if (collective) {
      // When looking for Notifications about specific Collective, we're also including the Collective parent and
      // it's host because:
      //   1. A user who unsubscribes from a Collective activity should not receive activities from its events or
      //      projects either;
      //   2. A Host admin can unsubscribe from their host related activities, including hosted collectives' activities
      //      by unsubscribing straight to the Host;
      where['CollectiveId'] = compact([collective.id, collective.ParentCollectiveId, collective.HostCollectiveId]);

      // If a User provided, we also want to include "global Notifications settings" in the search. A user can
      // set their global setting by creating a Notification that has no specific Collective attached.
      if (where['UserId']) {
        where['CollectiveId'].push(null);
      }

      // Also consider users who unsubscribed from ALL activities in this collective.
      where['type'].push(ActivityTypes.ACTIVITY_ALL);
    }

    debug('getUnsubscribers', where);
    const unsubs = await Notification.findAll({
      where,
      include,
    }).then(getUsers);

    // Here we find all the exceptions related to the specific collective. These are users that may have
    // unsubscribed to this activity through a global setting or a host wide rule but explicitly created
    // a notification rule for this collective or parent collective.
    const subs = collective
      ? await Notification.findAll({
          where: { ...where, active: true, CollectiveId: [collective.id, collective.ParentCollectiveId] },
          include,
        }).then(getUsers)
      : [];

    return reject(unsubs, unsub => subs.some(user => unsub.id === user.id));
  }

  /**
   * Check if notification with `notificationType` and `user` is active.
   */
  static isActive(notificationType: string, user: User, collective?: Collective) {
    debug('isActive', notificationType, user.id);
    const where = {
      type: notificationType,
      UserId: user.id,
    };

    if (collective && collective.id) {
      where['CollectiveId'] = collective.id;
    }

    return Notification.findOne({ where }).then(notification => {
      if (notification) {
        return notification.active;
      } else {
        return true;
      }
    });
  }

  /**
   * Counts registered webhooks for a user, for a collective.
   */
  static countRegisteredWebhooks(CollectiveId: number) {
    return models.Notification.count({ where: { CollectiveId, channel: channels.WEBHOOK } });
  }
}

Notification.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },

    channel: {
      defaultValue: 'email',
      type: DataTypes.STRING,
      validate: {
        isIn: {
          args: [Object.values(channels)],
          msg: `Must be one of ${Object.values(channels).join(', ')}`,
        },
      },
    },

    type: {
      type: DataTypes.STRING,
      // Can't do what's bellow because of the `mailinglist.___` thing
      // See https://github.com/opencollective/opencollective-api/blob/f8ac13a1b8176a69d4ea380bcfcca1bd789889b0/server/controllers/services/email.js#L155
      // validate: {
      //   isIn: {
      //     args: [Object.values(activities)],
      //     msg: `Must be one of ${Object.values(activities).join(', ')}`,
      //   },
      // },
    },

    active: {
      defaultValue: true,
      type: DataTypes.BOOLEAN,
    },

    createdAt: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    },

    CollectiveId: {
      type: DataTypes.INTEGER,
      references: { key: 'id', model: 'Collectives' },
    },

    UserId: {
      type: DataTypes.INTEGER,
      references: { key: 'id', model: 'Users' },
    },

    webhookUrl: {
      type: DataTypes.STRING,
      validate: {
        isUrl: {
          msg: 'Webhook URL must be a valid URL',
        },
        notAnInternalUrl: (url: string) => {
          const rootDomain = getRootDomain(url);
          if (rootDomain === 'opencollective.com') {
            throw new Error('Open Collective URLs cannot be used as webhooks');
          }
        },
        notAnIPAddress: (url: string) => {
          const parsedURL = new URL(url);
          if (validator.default.isIP(parsedURL.hostname)) {
            throw new Error('IP addresses cannot be used as webhooks');
          }
        },
      },
      set(url: string) {
        const cleanUrl = url?.trim();
        if (!cleanUrl) {
          this.setDataValue('webhookUrl', null);
        } else {
          this.setDataValue('webhookUrl', prependHttp(cleanUrl, { https: true }));
        }
      },
    },
  },
  {
    sequelize,
    indexes: [
      {
        fields: ['CollectiveId', 'type', 'channel'],
        unique: false,
      },
      {
        fields: ['channel', 'type', 'webhookUrl', 'CollectiveId'],
        unique: true,
      },
    ],
    hooks: {
      beforeCreate(instance) {
        if (instance.channel === channels.WEBHOOK && isNil(instance.webhookUrl)) {
          throw new ValidationFailed('Webhook URL can not be undefined');
        }
      },
    },
  },
);

export default Notification;
