import Promise from 'bluebird';
import debugLib from 'debug';
import { defaults, isNil } from 'lodash';
import prependHttp from 'prepend-http';
import { CreationOptional, InferAttributes, InferCreationAttributes } from 'sequelize';
import isIP from 'validator/lib/isIP';

import ActivityTypes, { ActivitiesPerClass, ActivityClasses, TransactionalActivities } from '../constants/activities';
import channels from '../constants/channels';
import { ValidationFailed } from '../graphql/errors';
import sequelize, { DataTypes, Model, Op } from '../lib/sequelize';
import { getRootDomain } from '../lib/url-utils';

import models from '.';

const debug = debugLib('models:Notification');

export class Notification extends Model<InferAttributes<Notification>, InferCreationAttributes<Notification>> {
  public declare readonly id: CreationOptional<number>;
  public declare channel: channels;
  public declare type: ActivityTypes | ActivityClasses | string;
  public declare active: boolean;
  public declare createdAt: CreationOptional<Date>;
  public declare CollectiveId: CreationOptional<number>;
  public declare UserId: CreationOptional<number>;
  public declare webhookUrl: CreationOptional<string>;

  getUser() {
    return models.User.findByPk(this.UserId);
  }

  static createMany(
    notifications: InferCreationAttributes<Notification>[],
    defaultValues?: InferCreationAttributes<Notification>,
  ): Notification[] {
    return Promise.map(notifications, u => Notification.create(defaults({}, u, defaultValues))).catch(console.error);
  }

  static async unsubscribe(
    type: ActivityTypes | ActivityClasses,
    channel: channels,
    UserId: number = null,
    CollectiveId: number = null,
  ) {
    const isClass = Object.values(ActivityClasses).includes(type as ActivityClasses);
    if (TransactionalActivities.includes(type as ActivityTypes)) {
      throw new Error(`Cannot remove transactional activity ${type}`);
    }

    return sequelize.transaction(async transaction => {
      let notification = await Notification.findOne({
        where: { UserId, CollectiveId, type, channel },
        transaction,
      });

      if (!notification) {
        notification = await Notification.create(
          { UserId, CollectiveId, type, channel, active: false },
          { transaction },
        );
      } else if (notification.active === true) {
        await notification.update({ active: false }, { transaction });
      }

      // If user is unsubscribing from ActivityClass, remove existing Notifications for any included ActivityType
      if (isClass && UserId) {
        await Notification.destroy({
          where: { UserId, CollectiveId, type: { [Op.in]: ActivitiesPerClass[type] }, channel },
          transaction,
        });
      }
      return notification;
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
   */
  static async getUnsubscribersUserIds(notificationType: string, CollectiveId?: number) {
    debug('getUnsubscribersUserIds', notificationType, CollectiveId);
    const notifications = await Notification.findAll({
      where: {
        CollectiveId,
        type: notificationType,
        active: false,
      },
    });

    return notifications.map(us => us.UserId);
  }

  /**
   * Check if notification with `notificationType` and `user` is active.
   */
  static isActive(notificationType: string, user: typeof models.User, collective?: typeof models.Collective) {
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

function setupModel() {
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
            if (isIP(parsedURL.hostname)) {
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
}

// We're using the setupModel function to keep the indentation and have a clearer git history.
// Please consider this if you plan to refactor.
setupModel();

export default Notification;
