import DataLoader from 'dataloader';
import express from 'express';
import { set } from 'lodash';

import models, { Op, sequelize } from '../../models';

export default {
  reactionsByUpdateId: (): DataLoader<number, typeof models.EmojiReaction> => {
    return new DataLoader(async updateIds => {
      const reactionsList = await models.EmojiReaction.count({
        where: { UpdateId: { [Op.in]: updateIds } },
        group: ['UpdateId', 'emoji'],
        order: [['emoji', 'ASC']],
        raw: true,
      });

      const reactionsMap = {};
      reactionsList.forEach(({ UpdateId, emoji, count }) => {
        set(reactionsMap, [UpdateId, emoji], count);
      });

      return updateIds.map(id => reactionsMap[id] || {});
    });
  },
  remoteUserReactionsByUpdateId: (req: express.Request): DataLoader<number, typeof models.EmojiReaction> => {
    return new DataLoader(async updateIds => {
      if (!req.remoteUser) {
        return updateIds.map(() => []);
      }

      const reactionsList = await models.EmojiReaction.findAll({
        attributes: ['UpdateId', [sequelize.fn('ARRAY_AGG', sequelize.col('emoji')), 'emojis']],
        where: { FromCollectiveId: req.remoteUser.CollectiveId, UpdateId: { [Op.in]: updateIds } },
        group: ['UpdateId'],
        raw: true,
      });

      const reactionsMap = {};
      reactionsList.forEach(reaction => {
        reactionsMap[reaction.UpdateId] = reaction.emojis;
      });

      return updateIds.map(id => reactionsMap[id] || []);
    });
  },
};
