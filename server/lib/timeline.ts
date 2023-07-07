import debugLib from 'debug';
import { flatten, toString } from 'lodash';
import { InferAttributes, Op, Order, WhereOptions } from 'sequelize';

import ActivityTypes, { ActivitiesPerClass, ActivityClasses } from '../constants/activities';
import { types as AccountTypes } from '../constants/collectives';
import MemberRoles from '../constants/roles';
import { createRedisClient } from '../lib/redis';
import models, { Collective } from '../models';
import { Activity } from '../models/Activity';
import { MemberModelInterface } from '../models/Member';

const debug = debugLib('timeline');

const getCollectiveIdsForRole = (memberships: MemberModelInterface[], roles: MemberRoles[]): number[] =>
  memberships.filter(m => roles.includes(m.role)).map(m => m.CollectiveId);

const generateTimelineQuery = async (
  collective: Collective,
  classes: ActivityClasses[] = [
    ActivityClasses.EXPENSES,
    ActivityClasses.CONTRIBUTIONS,
    ActivityClasses.VIRTUAL_CARDS,
    ActivityClasses.ACTIVITIES_UPDATES,
  ],
): Promise<WhereOptions<InferAttributes<Activity, { omit: never }>>> => {
  if (collective.type === AccountTypes.USER) {
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
          ActivityTypes.ORDER_THANKYOU,
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
          MemberRoles.FOLLOWER,
          MemberRoles.MEMBER,
          MemberRoles.CONTRIBUTOR,
          MemberRoles.ATTENDEE,
          MemberRoles.ADMIN,
        ]),
      });
    }
    return { [Op.or]: conditionals };
  } else {
    return { [Op.or]: [{ CollectiveId: collective.id }, { FromCollectiveId: collective.id }] };
  }
};

const order: Order = [['createdAt', 'DESC']];
const FEED_LIMIT = 1000;

const generateFeed = async (collective: Collective, sinceId?: string) => {
  const redis = await createRedisClient();
  const cacheKey = `timeline-${collective.slug}`;

  const where = await generateTimelineQuery(collective);
  if (sinceId) {
    where['id'] = { [Op.gt]: sinceId };
  }
  const result = await models.Activity.findAll({ where, order, limit: FEED_LIMIT });
  if (result.length > 0) {
    const activities = result.map(({ id, type }) => ({ score: id, value: JSON.stringify({ id, type }) }));
    debug(`Generated timeline for ${collective.slug} with ${activities.length} activities`);
    await redis.zAdd(cacheKey, activities);

    // Trim the cache if updating with new activities
    if (sinceId) {
      const count = await redis.zCount(cacheKey, '0', '+inf');
      if (count > FEED_LIMIT) {
        await redis.zRemRangeByRank(cacheKey, 0, count - FEED_LIMIT - 1);
      }
    }
  }
};

export const getCollectiveFeed = async ({
  collective,
  untilId,
  limit,
  classes,
}: {
  collective: Collective;
  untilId: number;
  limit: number;
  classes: ActivityClasses[];
}) => {
  const redis = await createRedisClient();
  // If we don't have a redis client, we can't cache the timeline using sorted sets
  if (!redis) {
    debug('Redis is not configured, skipping cached timeline');
    const where = await generateTimelineQuery(collective, classes);
    if (untilId) {
      where['id'] = { [Op.lt]: untilId };
    }
    return models.Activity.findAll({
      where,
      order,
      limit,
    });
  }

  // Check if timeline cache exists
  const cacheKey = `timeline-${collective.slug}`;
  const cacheExists = await redis.exists(cacheKey);
  if (!cacheExists) {
    // If we don't have a cache, generate it asynchronously
    generateFeed(collective);
    return null;
  }

  const wantedTypes = flatten(classes.map(c => ActivitiesPerClass[c]));
  const ids = [];
  let offset = 0;

  // This is a thunk responsible for paginating until we have enough results
  // Notice that we fetch twice the limit to account for activities that might be filtered out
  const fetchMore = untilId
    ? // When fetching since a specific ID, we need to paginate in reverse by score (ID)
      () =>
        redis.zRange(cacheKey, `(${untilId}`, '-inf', {
          BY: 'SCORE',
          REV: true,
          LIMIT: { count: limit * 2, offset },
        })
    : // When fetching the latest activities, we can paginate in reverse by rank
      () => redis.zRange(cacheKey, offset, offset + limit * 2, { REV: true });

  let cached = await fetchMore();

  // If we're not paginating, first regenerate cache
  if (!untilId) {
    const latestActivity = JSON.parse(cached[0]);
    await generateFeed(collective, latestActivity.id);
  }

  while (cached.length > 0) {
    cached
      .map(v => JSON.parse(v) as { id: number; type: ActivityTypes })
      // Filter out unwanted types based on the classes the user requested
      .filter(({ type }) => wantedTypes.includes(type))
      // In the case we fetch more than we need, we slice the array to the limit
      .slice(0, limit - ids.length)
      .forEach(({ id }) => ids.push(id));
    if (ids.length >= limit) {
      break;
    } else {
      offset += limit * 2;
      cached = await fetchMore();
    }
  }

  // Return the actual activities from the database
  return await models.Activity.findAll({ where: { id: ids }, order });
};
