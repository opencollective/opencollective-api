import DataLoader from 'dataloader';
import { set } from 'lodash';

import { ReactionEmoji } from '../../constants/reaction-emoji';
import models, { Op, sequelize } from '../../models';
import EmojiReaction from '../../models/EmojiReaction';

import { sortResults } from './helpers';
export default {
  countByExpenseId: (): DataLoader<number, number> =>
    new DataLoader(ExpenseIds =>
      models.Comment.count({
        attributes: ['ExpenseId'],
        where: { ExpenseId: { [Op.in]: ExpenseIds } },
        group: ['ExpenseId'],
      }).then(results =>
        sortResults(ExpenseIds, results, 'ExpenseId', { count: 0 }).map(result => <number>result.count),
      ),
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
  remoteUserReactionsByCommentId: ({ remoteUser }): DataLoader<number, typeof models.EmojiReaction> => {
    return new DataLoader(async commentIds => {
      if (!remoteUser) {
        return commentIds.map(() => []);
      }

      type ReactionsListQueryResult = [{ CommentId: number; emojis: ReactionEmoji[] }];
      const reactionsList = (await models.EmojiReaction.findAll({
        attributes: ['CommentId', [sequelize.fn('ARRAY_AGG', sequelize.col('emoji')), 'emojis']],
        where: { FromCollectiveId: remoteUser.CollectiveId, CommentId: { [Op.in]: commentIds } },
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
