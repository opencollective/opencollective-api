import config from 'config';
import debugLib from 'debug';
import { flatten, isEmpty, last, toInteger, toString } from 'lodash';
import { InferAttributes, Op, Order, Sequelize, WhereOptions } from 'sequelize';

import ActivityTypes, { ActivitiesPerClass, ActivityClasses } from '../constants/activities';
import { CollectiveType } from '../constants/collectives';
import MemberRoles from '../constants/roles';
import { createRedisClient, RedisInstanceType } from '../lib/redis';
import { Activity, Collective, Member } from '../models';

import makeRedisProvider from './cache/redis';
import { parseToBoolean } from './utils';

const debug = debugLib('timeline');

const getCollectiveIdsForRole = (memberships: Member[], roles: MemberRoles[]): number[] =>
  memberships.filter(m => roles.includes(m.role)).map(m => m.CollectiveId);

const CREATED_AT_HORIZON = { [Op.gt]: Sequelize.literal("NOW() - INTERVAL '6 months'") };

const makeTimelineQuery = async (
  collective: Collective,
  classes: ActivityClasses[],
): Promise<WhereOptions<InferAttributes<Activity, { omit: never }>>> => {
  if (collective.type === CollectiveType.USER) {
    const user = await collective.getUser();
    const memberships = await user.getMemberships();
    const conditionals = [];

    if (classes.includes(ActivityClasses.EXPENSES)) {
      conditionals.push(
        {
          type: [
            ActivityTypes.COLLECTIVE_EXPENSE_APPROVED,
            ActivityTypes.COLLECTIVE_EXPENSE_ERROR,
            ActivityTypes.COLLECTIVE_EXPENSE_MARKED_AS_INCOMPLETE,
            ActivityTypes.COLLECTIVE_EXPENSE_PAID,
            ActivityTypes.COLLECTIVE_EXPENSE_REJECTED,
            ActivityTypes.COLLECTIVE_EXPENSE_INVITE_DECLINED,
            ActivityTypes.COLLECTIVE_EXPENSE_UNAPPROVED,
            ActivityTypes.COLLECTIVE_EXPENSE_UPDATED,
            ActivityTypes.EXPENSE_COMMENT_CREATED,
          ],
          data: { user: { id: toString(collective.id) } },
        },
        {
          type: ActivityTypes.COLLECTIVE_EXPENSE_INVITE_DRAFTED,
          data: { payee: { id: toString(collective.id) } },
        },
        { type: ActivityTypes.COLLECTIVE_EXPENSE_RECURRING_DRAFTED, UserId: user.id },
      );
    }
    if (classes.includes(ActivityClasses.VIRTUAL_CARDS)) {
      conditionals.push({
        type: [
          ActivityTypes.COLLECTIVE_VIRTUAL_CARD_MISSING_RECEIPTS,
          ActivityTypes.COLLECTIVE_VIRTUAL_CARD_SUSPENDED,
          ActivityTypes.COLLECTIVE_VIRTUAL_CARD_SUSPENDED_DUE_TO_INACTIVITY,
          ActivityTypes.VIRTUAL_CARD_PURCHASE,
        ],
        UserId: user.id,
      });
    }
    if (classes.includes(ActivityClasses.CONTRIBUTIONS)) {
      conditionals.push({
        type: [
          ActivityTypes.PAYMENT_FAILED,
          ActivityTypes.ORDER_PAYMENT_FAILED,
          ActivityTypes.ORDER_PROCESSED,
          ActivityTypes.ORDER_PROCESSING,
        ],
        [Op.or]: [{ UserId: collective.CreatedByUserId }, { FromCollectiveId: collective.id }],
      });
    }
    if (classes.includes(ActivityClasses.ACTIVITIES_UPDATES)) {
      conditionals.push({
        type: ActivityTypes.COLLECTIVE_UPDATE_PUBLISHED,
        CollectiveId: getCollectiveIdsForRole(memberships, [
          MemberRoles.BACKER,
          MemberRoles.MEMBER,
          MemberRoles.CONTRIBUTOR,
          MemberRoles.ATTENDEE,
          MemberRoles.ADMIN,
        ]),
      });

      const followingCollectives = getCollectiveIdsForRole(memberships, [MemberRoles.FOLLOWER]);
      if (!isEmpty(followingCollectives)) {
        conditionals.push({
          [Op.and]: [
            {
              type: ActivityTypes.COLLECTIVE_UPDATE_PUBLISHED,
              CollectiveId: followingCollectives,
            },
            Sequelize.literal(
              `EXISTS (SELECT FROM "Updates" u where u.id = ("Activity"."data"#>'{update,id}')::integer AND NOT u."isPrivate")`,
            ),
          ],
        });
      }
    }
    return {
      [Op.or]: conditionals,
    };
  } else if (collective.hasHosting) {
    return {
      type: {
        [Op.in]: [
          ActivityTypes.COLLECTIVE_UPDATE_PUBLISHED,
          ActivityTypes.COLLECTIVE_APPROVED,
          ActivityTypes.COLLECTIVE_CORE_MEMBER_ADDED,
          ActivityTypes.COLLECTIVE_CORE_MEMBER_REMOVED,
          ActivityTypes.COLLECTIVE_FROZEN,
          ActivityTypes.COLLECTIVE_UNFROZEN,
          ActivityTypes.COLLECTIVE_UNHOSTED,
          ActivityTypes.COLLECTIVE_APPLY,
        ],
      },
      [Op.or]: [
        { CollectiveId: collective.id },
        { FromCollectiveId: collective.id },
        { HostCollectiveId: collective.id },
      ],
    };
  }

  const types = [];

  if (classes.includes(ActivityClasses.EXPENSES)) {
    types.push(
      ...[
        ActivityTypes.COLLECTIVE_EXPENSE_APPROVED,
        ActivityTypes.COLLECTIVE_EXPENSE_CREATED,
        ActivityTypes.COLLECTIVE_EXPENSE_DELETED,
        ActivityTypes.COLLECTIVE_EXPENSE_INVITE_DRAFTED,
        ActivityTypes.COLLECTIVE_EXPENSE_MARKED_AS_INCOMPLETE,
        ActivityTypes.COLLECTIVE_EXPENSE_MARKED_AS_SPAM,
        ActivityTypes.COLLECTIVE_EXPENSE_MARKED_AS_UNPAID,
        ActivityTypes.COLLECTIVE_EXPENSE_PAID,
        ActivityTypes.COLLECTIVE_EXPENSE_RECURRING_DRAFTED,
        ActivityTypes.COLLECTIVE_EXPENSE_REJECTED,
        ActivityTypes.COLLECTIVE_EXPENSE_INVITE_DECLINED,
        ActivityTypes.COLLECTIVE_EXPENSE_UNAPPROVED,
        ActivityTypes.COLLECTIVE_EXPENSE_RE_APPROVAL_REQUESTED,
        ActivityTypes.COLLECTIVE_EXPENSE_UPDATED,
        ActivityTypes.EXPENSE_COMMENT_CREATED,
        ActivityTypes.TAXFORM_REQUEST,
        ActivityTypes.TAXFORM_RECEIVED,
      ],
    );
  }
  if (classes.includes(ActivityClasses.VIRTUAL_CARDS)) {
    types.push(
      ...[
        ActivityTypes.COLLECTIVE_VIRTUAL_CARD_ADDED,
        ActivityTypes.COLLECTIVE_VIRTUAL_CARD_SUSPENDED,
        ActivityTypes.COLLECTIVE_VIRTUAL_CARD_REQUEST_APPROVED,
        ActivityTypes.COLLECTIVE_VIRTUAL_CARD_REQUEST_REJECTED,
        ActivityTypes.VIRTUAL_CARD_REQUESTED,
        ActivityTypes.VIRTUAL_CARD_PURCHASE,
      ],
    );
  }
  if (classes.includes(ActivityClasses.CONTRIBUTIONS)) {
    types.push(
      ...[
        ActivityTypes.COLLECTIVE_MEMBER_CREATED,
        ActivityTypes.CONTRIBUTION_REJECTED,
        ActivityTypes.ORDER_PAYMENT_FAILED,
        ActivityTypes.ORDER_PENDING_CONTRIBUTION_NEW,
        ActivityTypes.ORDER_PENDING_CONTRIBUTION_REMINDER,
        ActivityTypes.ORDER_PROCESSED,
        ActivityTypes.ORDERS_SUSPICIOUS,
        ActivityTypes.PAYMENT_CREDITCARD_EXPIRING,
        ActivityTypes.PAYMENT_FAILED,
        ActivityTypes.SUBSCRIPTION_CANCELED,
        ActivityTypes.SUBSCRIPTION_PAUSED,
        ActivityTypes.SUBSCRIPTION_RESUMED,
      ],
    );
  }
  if (classes.includes(ActivityClasses.ACTIVITIES_UPDATES)) {
    types.push(
      ...[
        ActivityTypes.HOST_APPLICATION_CONTACT,
        ActivityTypes.COLLECTIVE_CONVERSATION_CREATED,
        ActivityTypes.COLLECTIVE_UPDATE_PUBLISHED,
        ActivityTypes.CONVERSATION_COMMENT_CREATED,
        ActivityTypes.UPDATE_COMMENT_CREATED,
      ],
    );
  }

  // New
  if (classes.includes(ActivityClasses.COLLECTIVE)) {
    types.push(
      ...[
        ActivityTypes.ACTIVATED_MONEY_MANAGEMENT,
        ActivityTypes.DEACTIVATED_MONEY_MANAGEMENT,
        ActivityTypes.ACTIVATED_HOSTING,
        ActivityTypes.DEACTIVATED_HOSTING,
        ActivityTypes.ORGANIZATION_CONVERTED_TO_COLLECTIVE,
        ActivityTypes.COLLECTIVE_CONVERTED_TO_ORGANIZATION,
      ],
    );
  }

  return {
    type: { [Op.in]: types },
    [Op.or]: [{ CollectiveId: collective.id }, { FromCollectiveId: collective.id }],
  };
};

type SerializedActivity = { id: number; type: ActivityTypes };
const order: Order = [['createdAt', 'DESC']];
const TTL = 60 * 60 * 24 * parseInt(config.timeline.daysCached);
const FEED_LIMIT = 1000;
const PAGE_SIZE = 40;
const EMPTY_FLAG = 'EMPTY';
debug('Cache TTL: %d (%d days)', TTL, config.timeline.daysCached);

/**
 * Generates a cache key that includes the collective slug and activity classes.
 * Classes are sorted to ensure consistent cache keys regardless of input order.
 */
const getCacheKey = (collectiveSlug: string, classes: ActivityClasses[]): string => {
  const sortedClasses = [...classes].sort().join('-');
  return `timeline-${collectiveSlug}-${sortedClasses || 'none'}`;
};

/**
 * Updates an existing cached timeline feed and trim it to the limit.
 */
const updateFeed = async (collective: Collective, classes: ActivityClasses[], sinceId: number) => {
  const cacheKey = getCacheKey(collective.slug, classes);
  const redis = await createRedisClient(RedisInstanceType.TIMELINE);
  const where = await makeTimelineQuery(collective, classes);
  where['id'] = { [Op.gt]: sinceId };

  debug('Fetching %d activities since #%s for %s', PAGE_SIZE, sinceId, collective.slug);
  const result = await Activity.findAll({
    where,
    attributes: ['id', 'type', 'createdAt'],
    order,
  });

  if (!isEmpty(result)) {
    const activities = result.map(({ id, type, createdAt }) => {
      const value: SerializedActivity = { id, type };
      return {
        score: toInteger(createdAt.getTime() / 1000),
        value: JSON.stringify(value),
      };
    });

    await redis.zAdd(cacheKey, activities);
  }

  // Trim the cache if updating with new activities
  const count = await redis.zCount(cacheKey, '0', '+inf');
  if (count > FEED_LIMIT) {
    await redis.zRemRangeByRank(cacheKey, 0, count - FEED_LIMIT - 1);
  }
};

const createNewFeed = async (collective: Collective, classes: ActivityClasses[]) => {
  const cacheKey = getCacheKey(collective.slug, classes);
  const redis = await createRedisClient(RedisInstanceType.TIMELINE);

  const where = await makeTimelineQuery(collective, classes);
  let result = [];
  let lastId = null;
  let total = 0;
  do {
    debug('Fetching %d activities before #%s for %s', PAGE_SIZE, lastId, collective.slug);
    if (lastId) {
      where['id'] = { [Op.lt]: lastId };
    }
    result = await Activity.findAll({
      where,
      attributes: ['id', 'type', 'createdAt'],
      order,
      limit: PAGE_SIZE,
    });

    if (!isEmpty(result)) {
      total += result.length;
      lastId = last(result)['id'];
      const activities = result.map(({ id, type, createdAt }) => {
        const value: SerializedActivity = { id, type };
        return {
          score: toInteger(createdAt.getTime() / 1000),
          value: JSON.stringify(value),
        };
      });
      await redis.zAdd(cacheKey, activities);
    } else if (lastId === null) {
      await redis.zAdd(cacheKey, [{ score: 0, value: EMPTY_FLAG }]);
    }
  } while (!isEmpty(result) && total < FEED_LIMIT);

  await redis.expire(cacheKey, TTL);
  debug(`Generated timeline for ${collective.slug} with ${total} activities`);
};

export const getCollectiveFeed = async ({
  collective,
  dateTo,
  limit = 20,
  classes,
}: {
  collective: Collective;
  dateTo: Date;
  limit: number;
  classes: ActivityClasses[];
}) => {
  const isDisabled = parseToBoolean(config.timeline.disabled);
  if (isDisabled) {
    return null;
  }

  const redis = await createRedisClient(RedisInstanceType.TIMELINE);
  // If we don't have a redis client, we can't cache the timeline using sorted sets
  if (!redis) {
    debug('Redis is not configured, skipping cached timeline');

    const where = await makeTimelineQuery(collective, classes);
    if (dateTo) {
      where['createdAt'] = { ...CREATED_AT_HORIZON, [Op.lt]: dateTo };
    } else {
      where['createdAt'] = CREATED_AT_HORIZON;
    }

    const activities = await Activity.findAll({
      where,
      order,
      limit,
    });
    return activities;
  }

  const cache = await makeRedisProvider(RedisInstanceType.TIMELINE);
  // Check if timeline cache exists
  const cacheKey = getCacheKey(collective.slug, classes);
  const cacheExists = await redis.exists(cacheKey);
  if (!cacheExists) {
    const lockKey = `${cacheKey}-semaphore`;
    if (await cache.has(lockKey)) {
      debug('Timeline cache is being generated, ignoring request');
      // Refresh lock key
      await cache.set(lockKey, true, 120);
      return null;
    }

    await cache.set(lockKey, true, 120);
    // If we don't have a cache, generate it asynchronously
    createNewFeed(collective, classes).finally(() => cache.delete(lockKey));
    return null;
  }

  const wantedTypes = flatten(classes.map(c => ActivitiesPerClass[c]));
  let offset = 0;

  // This is a thunk responsible for paginating until we have enough results
  const fetchMore = dateTo
    ? // When fetching since a specific ID, we need to paginate in reverse by score (ID)
      () =>
        redis.zRange(cacheKey, `(${toInteger(dateTo.getTime() / 1000)}`, '-inf', {
          BY: 'SCORE',
          REV: true,
          LIMIT: { count: limit, offset },
        })
    : // When fetching the latest activities, we can paginate in reverse by rank
      () => redis.zRange(cacheKey, offset, offset + limit, { REV: true });

  // If we're not paginating, first update cache
  if (!dateTo) {
    const [latest] = await redis.zRange(cacheKey, -1, -1);
    if (latest === EMPTY_FLAG) {
      return [];
    }
    const activity = JSON.parse(latest) as SerializedActivity;
    debug(`Updating timeline for ${collective.slug} from id ${activity.id}`);
    await updateFeed(collective, classes, activity.id);
  }

  const idsToLoad = [];
  let cached = await fetchMore();
  while (cached.length > 0) {
    cached
      .map(v => JSON.parse(v) as SerializedActivity)
      // Filter out unwanted types based on the classes the user requested
      .filter(({ type }) => wantedTypes.includes(type))
      // In the case we fetch more than we need, we slice the array to the limit
      .slice(0, limit - idsToLoad.length)
      .forEach(({ id }) => idsToLoad.push(id));
    if (idsToLoad.length >= limit) {
      break;
    } else {
      offset += limit;
      cached = await fetchMore();
    }
  }

  // Return the actual activities from the database
  const activities = await Activity.findAll({ where: { id: idsToLoad }, order });
  return activities;
};
