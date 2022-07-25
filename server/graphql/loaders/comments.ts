import DataLoader from 'dataloader';
import express from 'express';
import { set } from 'lodash';

import models, { Op, sequelize } from '../../models';

import { sortResults } from './helpers';
export default {
  countByExpenseId: (): DataLoader<number, number> =>
    new DataLoader(ExpenseIds =>
      models.Comment.count({
        attributes: ['ExpenseId'],
        where: { ExpenseId: { [Op.in]: ExpenseIds } },
        group: ['ExpenseId'],
      })
        .then(results => sortResults(ExpenseIds, results, 'ExpenseId', { count: 0 }))
        .map(result => result.count),
    ),
  reactionsByCommentId: (): DataLoader<number, typeof models.EmojiReaction> => {
    return new DataLoader(async commentIds => {
      const reactionsList = await models.EmojiReaction.count({
        where: { CommentId: { [Op.in]: commentIds } },
        group: ['CommentId', 'emoji'],
        order: [['emoji', 'ASC']],
        raw: true,
      });

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

      const reactionsList = await models.EmojiReaction.findAll({
        attributes: ['CommentId', [sequelize.fn('ARRAY_AGG', sequelize.col('emoji')), 'emojis']],
        where: { FromCollectiveId: req.remoteUser.CollectiveId, CommentId: { [Op.in]: commentIds } },
        group: ['CommentId'],
        raw: true,
      });

      const reactionsMap = {};
      reactionsList.forEach(reaction => {
        reactionsMap[reaction.CommentId] = reaction.emojis;
      });

      return commentIds.map(id => reactionsMap[id] || []);
    });
  },
};
