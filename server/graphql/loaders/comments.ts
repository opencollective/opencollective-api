import DataLoader from 'dataloader';
import { set } from 'lodash';

import models, { Op, sequelize } from '../../models';

import { createDataLoaderWithOptions, sortResults } from './helpers';

export default {
  findAllByAttribute: (_, cache) => (attribute: string): DataLoader<string | number, object> => {
    return createDataLoaderWithOptions(
      (values, attribute) => {
        return models.Comment.findAll({
          where: {
            [attribute]: { [Op.in]: values },
          },
          order: [['createdAt', 'DESC']],
        }).then(results => sortResults(values, results, attribute, []));
      },
      cache,
      attribute,
      'comments',
    );
  },
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
  reactionsByCommentId: (): DataLoader<number, object> => {
    return new DataLoader(async commentIds => {
      const reactionsList = await models.CommentReaction.count({
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
  remoteUserReactionsByCommentId: (req): DataLoader<number, object> => {
    return new DataLoader(async commentIds => {
      if (!req.remoteUser) {
        return commentIds.map(() => []);
      }

      const reactionsList = await models.CommentReaction.findAll({
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
