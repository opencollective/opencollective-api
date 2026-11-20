import DataLoader from 'dataloader';
import express from 'express';
import { groupBy, set } from 'lodash';
import { QueryTypes, Sequelize } from 'sequelize';

import { ReactionEmoji } from '../../constants/reaction-emoji';
import models, { Op, sequelize } from '../../models';
import Comment from '../../models/Comment';
import EmojiReaction from '../../models/EmojiReaction';

type CommentCountByExpenseIdAndType = {
  ExpenseId: number;
  type: string | string[];
};

type CommentsPageByExpenseKey = {
  ExpenseId: number;
  type: string[];
  /** Only `createdAt` exists on comments among the chronological fields */
  orderBy: { field: 'createdAt'; direction: 'ASC' | 'DESC' };
  limit: number;
  offset: number;
};

const getCommentsPageGroupKey = (key: CommentsPageByExpenseKey): string =>
  `${[...key.type].sort().join('|')}.${key.orderBy.field}.${key.orderBy.direction}.${key.limit}.${key.offset}`;

export default {
  /**
   * One page of comments (ordered by `createdAt`) for each expense, fetched with a single query per
   * distinct (type, orderBy, limit, offset) instead of one query per expense.
   */
  pageByExpense: (): DataLoader<CommentsPageByExpenseKey, Comment[]> =>
    new DataLoader(
      async (keys: readonly CommentsPageByExpenseKey[]) => {
        const results = new Map<string, Comment[]>();
        const groups = groupBy(keys, getCommentsPageGroupKey);
        await Promise.all(
          Object.values(groups).map(async groupKeys => {
            const { type, orderBy, limit, offset } = groupKeys[0];
            const sqlDirection = orderBy.direction === 'DESC' ? 'DESC' : 'ASC';
            const comments = await sequelize.query<Comment>(
              `
              SELECT * FROM (
                SELECT c.*, ROW_NUMBER() OVER (
                  PARTITION BY c."ExpenseId" ORDER BY c."createdAt" ${sqlDirection}, c."id" ${sqlDirection}
                ) AS "__position"
                FROM "Comments" c
                WHERE c."ExpenseId" IN (:expenseIds)
                AND c."type" IN (:types)
                AND c."deletedAt" IS NULL
              ) AS ranked
              WHERE "__position" > :offset AND "__position" <= :offset + :limit
              ORDER BY "ExpenseId", "__position"
              `,
              {
                type: QueryTypes.SELECT,
                model: models.Comment,
                mapToModel: true,
                replacements: { expenseIds: groupKeys.map(k => k.ExpenseId), types: type, offset, limit },
              },
            );

            const byExpenseId = groupBy(comments, 'ExpenseId');
            const groupKey = getCommentsPageGroupKey(groupKeys[0]);
            groupKeys.forEach(k => results.set(`${k.ExpenseId}.${groupKey}`, byExpenseId[k.ExpenseId] || []));
          }),
        );

        return keys.map(k => results.get(`${k.ExpenseId}.${getCommentsPageGroupKey(k)}`) || []);
      },
      { cacheKeyFn: key => `${key.ExpenseId}.${getCommentsPageGroupKey(key)}` },
    ),

  countByExpenseAndType: (): DataLoader<CommentCountByExpenseIdAndType, number> =>
    new DataLoader(
      async (ExpenseIdAndType: Array<CommentCountByExpenseIdAndType>) => {
        const counters = await models.Comment.count({
          attributes: ['ExpenseId'],
          where: { [Op.or]: ExpenseIdAndType },
          group: ['ExpenseId'],
        });
        return ExpenseIdAndType.map(({ ExpenseId }) => counters.find(c => c.ExpenseId === ExpenseId)?.count || 0);
      },
      {
        cacheKeyFn: arg => {
          const type = Array.isArray(arg.type) ? arg.type.sort().join('|') : arg.type;
          return `${arg.ExpenseId}.${type}`;
        },
      },
    ),

  countByHostApplication: () => {
    return new DataLoader<number, { comments: number; privateNotes: number }>(async hostApplicationIds => {
      const counters = (await models.Comment.findAll({
        raw: true,
        attributes: [
          ['"HostApplicationId"', '"HostApplicationId"'],
          [
            Sequelize.literal(`count("HostApplicationId") filter (where "type" = 'COMMENT'::"enum_Comments_type")`),
            '"comments"',
          ],
          [
            Sequelize.literal(
              `count("HostApplicationId") filter (where "type" = 'PRIVATE_NOTE'::"enum_Comments_type")`,
            ),
            '"privateNotes"',
          ],
        ],
        where: { HostApplicationId: hostApplicationIds },
        group: ['HostApplicationId'],
      })) as unknown as { HostApplicationId: number; comments: number; privateNotes: number }[];

      return hostApplicationIds.map(HostApplicationId => {
        const count = counters.find(c => c.HostApplicationId === HostApplicationId);
        return {
          comments: count?.comments || 0,
          privateNotes: count?.privateNotes || 0,
        };
      });
    });
  },

  reactionsByCommentId: (): DataLoader<number, EmojiReaction> => {
    return new DataLoader(async commentIds => {
      type ReactionsListQueryResult = [{ CommentId: number; emoji: ReactionEmoji; count: number }];
      const reactionsList = (await models.EmojiReaction.count({
        where: { CommentId: { [Op.in]: commentIds } },
        group: ['CommentId', 'emoji'],
      })) as unknown as ReactionsListQueryResult;

      const reactionsMap = {};
      reactionsList.forEach(({ CommentId, emoji, count }) => {
        set(reactionsMap, [CommentId, emoji], count);
      });

      return commentIds.map(id => reactionsMap[id] || {});
    });
  },

  remoteUserReactionsByCommentId: (req: express.Request): DataLoader<number, typeof models.EmojiReaction> => {
    return new DataLoader(async commentIds => {
      if (!req.remoteUser) {
        return commentIds.map(() => []);
      }

      type ReactionsListQueryResult = [{ CommentId: number; emojis: ReactionEmoji[] }];
      const reactionsList = (await models.EmojiReaction.findAll({
        attributes: ['CommentId', [sequelize.fn('ARRAY_AGG', sequelize.col('emoji')), 'emojis']],
        where: { FromCollectiveId: req.remoteUser.CollectiveId, CommentId: { [Op.in]: commentIds } },
        group: ['CommentId'],
        raw: true,
      })) as unknown as ReactionsListQueryResult;

      const reactionsMap = {};
      reactionsList.forEach(reaction => {
        reactionsMap[reaction.CommentId] = reaction.emojis;
      });

      return commentIds.map(id => reactionsMap[id] || []);
    });
  },
};
