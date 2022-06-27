'use strict';

import showdown from 'showdown';

import models from '../server/models';

module.exports = {
  up: async queryInterface => {
    const markdownConverter = new showdown.Converter();

    // Updates
    const [updates] = await queryInterface.sequelize.query(`
      SELECT *
      FROM "Updates"
      WHERE COALESCE(LENGTH(html), 0) = 0
      AND COALESCE(LENGTH(markdown), 0) > 0
    `);

    for (const update of updates) {
      await models.Update.update(
        {
          html: markdownConverter.makeHtml(update.markdown),
        },
        {
          where: { id: update.id },
        },
      );
    }

    // Comments
    const [comments] = await queryInterface.sequelize.query(`
      SELECT *
      FROM "Comments"
      WHERE COALESCE(LENGTH(html), 0) = 0
      AND COALESCE(LENGTH(markdown), 0) > 0
    `);

    for (const comment of comments) {
      await models.Comment.update(
        {
          html: markdownConverter.makeHtml(comment.markdown),
        },
        {
          where: { id: comment.id },
        },
      );
    }
  },

  down: async () => {
    // No rollback
  },
};
