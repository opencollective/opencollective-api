import config from 'config';
import debugLib from 'debug';
import { flatten, isEmpty, toInteger, toString } from 'lodash';
import { InferAttributes, Op, Order, Sequelize, WhereOptions } from 'sequelize';

import ActivityTypes, { ActivitiesPerClass, ActivityClasses } from '../constants/activities';
import { CollectiveType } from '../constants/collectives';
import MemberRoles from '../constants/roles';
import { createRedisClient, RedisInstanceType } from '../lib/redis';
import models, { Collective } from '../models';
import { Activity } from '../models/Activity';
import { MemberModelInterface } from '../models/Member';

import cache from './cache';
import { utils } from './statsd';

const debug = debugLib('timeline');

const getCollectiveIdsForRole = (memberships: MemberModelInterface[], roles: MemberRoles[]): number[] =>
  memberships.filter(m => roles.includes(m.role)).map(m => m.CollectiveId);

const makeTimelineQuery = async (
  collective: Collective,
  classes: ActivityClasses[] = [
    ActivityClasses.EXPENSES,
    ActivityClasses.CONTRIBUTIONS,
    ActivityClasses.VIRTUAL_CARDS,
    ActivityClasses.ACTIVITIES_UPDATES,
  ],
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
          ActivityTypes.ORDER_CONFIRMED,
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
    return { [Op.or]: conditionals };
  } else {
    return { [Op.or]: [{ CollectiveId: collective.id }, { FromCollectiveId: collective.id }] };
  }
};

type SerializedActivity = { id: number; type: ActivityTypes };
const order: Order = [['createdAt', 'DESC']];
const TTL = 60 * 60 * 24 * parseInt(config.timeline.daysCached);
const FEED_LIMIT = 1000;
const EMPTY_FLAG = 'EMPTY';
debug('Cache TTL: %d (%d days)', TTL, config.timeline.daysCached);

const createOrUpdateFeed = async (collective: Collective, sinceId?: number) => {
  const cacheKey = `timeline-${collective.slug}`;
  const stopWatch = utils.stopwatch(sinceId ? 'timeline.update' : 'timeline.create', { log: debug });
  const redis = await createRedisClient(RedisInstanceType.TIMELINE);

  const where = await makeTimelineQuery(collective);
  if (sinceId) {
    where['id'] = { [Op.gt]: sinceId };
  }
  const result = await models.Activity.findAll({
    where,
    attributes: ['id', 'type', 'createdAt'],
    order,
    limit: FEED_LIMIT,
  });
  const activities = result.map(({ id, type, createdAt }) => {
    const value: SerializedActivity = { id, type };
    return {
      score: toInteger(createdAt.getTime() / 1000),
      value: JSON.stringify(value),
    };
  });
  const hasActivities = !isEmpty(activities);

  debug(`${sinceId ? 'Updated' : 'Generated'} timeline for ${collective.slug} with ${activities.length} activities`);
  // If not updating the cache, add new activities or add an EMPTY_FLAG
  if (!sinceId) {
    await redis.zAdd(cacheKey, hasActivities ? activities : [{ score: 0, value: EMPTY_FLAG }]);
    // Set initial TTL or set EMPTY_FLAG duration to 1 minute
    await redis.expire(cacheKey, hasActivities ? TTL : 60);
  }
  // If we're updating the cache, make sure we only add activities and bump the TTL if there are any
  else if (sinceId && hasActivities) {
    // Add new activities to the cache and bump TTL
    await redis.zAdd(cacheKey, activities);
    await redis.expire(cacheKey, TTL);
    // Trim the cache if updating with new activities
    const count = await redis.zCount(cacheKey, '0', '+inf');
    if (count > FEED_LIMIT) {
      await redis.zRemRangeByRank(cacheKey, 0, count - FEED_LIMIT - 1);
    }
  }

  stopWatch();
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
  const redis = await createRedisClient(RedisInstanceType.TIMELINE);
  // If we don't have a redis client, we can't cache the timeline using sorted sets
  if (!redis) {
    debug('Redis is not configured, skipping cached timeline');
    const stopWatch = utils.stopwatch('timeline.readPage.noCache');
    const where = await makeTimelineQuery(collective, classes);
    if (dateTo) {
      where['createdAt'] = { [Op.lt]: dateTo };
    }

    const activities = await models.Activity.findAll({
      where,
      order,
      limit,
    });
    stopWatch();
    return activities;
  }

  // Check if timeline cache exists
  const cacheKey = `timeline-${collective.slug}`;
  const cacheExists = await redis.exists(cacheKey);
  if (!cacheExists) {
    const lockKey = `${cacheKey}-semaphore`;
    if (await cache.has(lockKey)) {
      debug('Timeline cache is being generated, ignoring request');
      return null;
    }
    cache.set(lockKey, true, 60);

    // If we don't have a cache, generate it asynchronously
    createOrUpdateFeed(collective).finally(() => cache.delete(lockKey));
    return null;
  }

  const stopWatch = utils.stopwatch(dateTo ? 'timeline.readPage.cached' : 'timeline.readFirstPage.cached', {
    log: debug,
  });
  const wantedTypes = flatten(classes.map(c => ActivitiesPerClass[c]));
  const ids = [];
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
    await createOrUpdateFeed(collective, activity.id);
  }

  let cached = await fetchMore();
  while (cached.length > 0) {
    cached
      .map(v => JSON.parse(v) as SerializedActivity)
      // Filter out unwanted types based on the classes the user requested
      .filter(({ type }) => wantedTypes.includes(type))
      // In the case we fetch more than we need, we slice the array to the limit
      .slice(0, limit - ids.length)
      .forEach(({ id }) => ids.push(id));
    if (ids.length >= limit) {
      break;
    } else {
      offset += limit;
      cached = await fetchMore();
    }
  }

  // Return the actual activities from the database
  const activities = await models.Activity.findAll({ where: { id: ids }, order });
  stopWatch();
  return activities;
};
