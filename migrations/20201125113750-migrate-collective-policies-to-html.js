'use strict';

import showdown from 'showdown';

import { buildSanitizerOptions, sanitizeHTML } from '../server/lib/sanitize-html';

const converter = new showdown.Converter();

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const collectivesWithExpensePolicy = await queryInterface.sequelize.query(
      `
        SELECT "id", "expensePolicy" FROM "Collectives"
        WHERE LENGTH("expensePolicy") > 0 AND "expensePolicy" NOT LIKE '<%'
        AND "deletedAt" IS NULL;
      `,
      { type: Sequelize.QueryTypes.SELECT },
    );

    const collectivesWithContribPolicy = await queryInterface.sequelize.query(
      `
        SELECT "id", "contributionPolicy" FROM "Collectives"
        WHERE LENGTH("contributionPolicy") > 0 AND "contributionPolicy" NOT LIKE '<%'
        AND "deletedAt" IS NULL;
      `,
      { type: Sequelize.QueryTypes.SELECT },
    );

    const sanitizeOptions = buildSanitizerOptions({
      basicTextFormatting: true,
      multilineTextFormatting: true,
      links: true,
    });

    for (const collective of collectivesWithExpensePolicy) {
      const htmlContent = converter.makeHtml(collective.expensePolicy);
      const sanitizedContent = sanitizeHTML(htmlContent, sanitizeOptions);
      await queryInterface.sequelize.query(
        `
        UPDATE "Collectives" c
        SET "expensePolicy" = :expensePolicy
        WHERE c.id = :id
      `,
        {
          replacements: {
            expensePolicy: sanitizedContent,
            id: collective.id,
          },
        },
      );
    }

    for (const collective of collectivesWithContribPolicy) {
      const htmlContent = converter.makeHtml(collective.contributionPolicy);
      const sanitizedContent = sanitizeHTML(htmlContent, sanitizeOptions);
      await queryInterface.sequelize.query(
        `
        UPDATE "Collectives" c
        SET "contributionPolicy" = :contributionPolicy
        WHERE c.id = :id
      `,
        {
          replacements: {
            contributionPolicy: sanitizedContent,
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
