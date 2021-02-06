'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.sequelize.query(
      `
        UPDATE "Conversations" c
        SET "tags" = lower(tags::text)::text[]
        WHERE c."tags" IS NOT NULL
      `,
    );

    await queryInterface.sequelize.query(
      `
        UPDATE "Expenses" e
        SET "tags" = lower(tags::text)::text[]
        WHERE e."tags" IS NOT NULL
      `,
    );
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.sequelize.query(
      `
        UPDATE "Conversations" c
        SET "tags" = upper(tags::text)::text[]
        WHERE c."tags" IS NOT NULL
      `,
    );

    await queryInterface.sequelize.query(
      `
        UPDATE "Expenses" e
        SET "tags" = upper(tags::text)::text[]
        WHERE e."tags" IS NOT NULL
      `,
    );
  },
};
