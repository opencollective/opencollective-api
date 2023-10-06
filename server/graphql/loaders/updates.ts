import DataLoader from 'dataloader';
import express from 'express';
import { set } from 'lodash';

import { ReactionEmoji } from '../../constants/reaction-emoji';
import models, { Op, sequelize } from '../../models';

type ReactionsCount = Partial<Record<ReactionEmoji, number>>;

export default {
  reactionsByUpdateId: (): DataLoader<number, ReactionsCount> => {
    return new DataLoader(async updateIds => {
      type ReactionsListQueryResult = [{ UpdateId: number; emoji: ReactionEmoji; count: number }];
      const reactionsList = (await models.EmojiReaction.count({
        where: { UpdateId: { [Op.in]: updateIds } },
        group: ['UpdateId', 'emoji'],
      })) as ReactionsListQueryResult;

      type UpdateReactionsCount = Record<number, Record<ReactionEmoji, number>>;
      const reactionsMap: UpdateReactionsCount = {};
      reactionsList.forEach(({ UpdateId, emoji, count }) => {
        set(reactionsMap, [UpdateId, emoji], count);
      });

      return updateIds.map(id => reactionsMap[id] || {});
    });
  },
  remoteUserReactionsByUpdateId: (req: express.Request): DataLoader<number, ReactionEmoji> => {
    return new DataLoader(async updateIds => {
      if (!req.remoteUser) {
        return updateIds.map(() => []);
      }

      type ReactionsListQueryResult = [{ UpdateId: number; emojis: ReactionEmoji[] }];
      const reactionsList = (await models.EmojiReaction.findAll({
        attributes: ['UpdateId', [sequelize.fn('ARRAY_AGG', sequelize.col('emoji')), 'emojis']],
        where: { FromCollectiveId: req.remoteUser.CollectiveId, UpdateId: { [Op.in]: updateIds } },
        group: ['UpdateId'],
        raw: true,
        mapToModel: false,
      })) as unknown as ReactionsListQueryResult;

      const reactionsMap = {};
      reactionsList.forEach(reaction => {
        reactionsMap[reaction.UpdateId] = reaction.emojis;
      });

      return updateIds.map(id => reactionsMap[id] || []);
    });
  },
};
