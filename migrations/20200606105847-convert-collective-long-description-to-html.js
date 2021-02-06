'use strict';

import showdown from 'showdown';
import { buildSanitizerOptions, sanitizeHTML } from '../server/lib/sanitize-html';

const converter = new showdown.Converter();

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const collectives = await queryInterface.sequelize.query(
      `
        SELECT "id", "longDescription" FROM "Collectives"
        WHERE LENGTH("longDescription") > 0 AND "longDescription" NOT LIKE '<%'
        AND "deletedAt" IS NULL;
      `,
      { type: Sequelize.QueryTypes.SELECT },
    );

    const sanitizeOptions = buildSanitizerOptions({
      titles: true,
      basicTextFormatting: true,
      multilineTextFormatting: true,
      links: true,
      images: true,
      videoIframes: true,
      tables: true,
    });

    for (const collective of collectives) {
      const htmlContent = converter.makeHtml(collective.longDescription);
      const sanitizedContent = sanitizeHTML(htmlContent, sanitizeOptions);
      await queryInterface.sequelize.query(
        `
        UPDATE "Collectives" c
        SET "longDescription" = :longDescription
        WHERE c.id = :id
      `,
        {
          replacements: {
            longDescription: sanitizedContent,
            id: collective.id,
          },
        },
      );
    }
  },

  down: async () => {
    // can't rollback this one
  },
};
