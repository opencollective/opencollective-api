import DataLoader from 'dataloader';
import express from 'express';
import { set } from 'lodash-es';

import { ReactionEmoji } from '../../constants/reaction-emoji.js';
import models, { Op, sequelize } from '../../models/index.js';
import EmojiReaction from '../../models/EmojiReaction.js';

type CommentCountByExpenseIdAndType = {
  ExpenseId: number;
  type: string | string[];
};

export default {
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
