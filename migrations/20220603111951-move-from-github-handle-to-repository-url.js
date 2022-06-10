'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    // Start by doing some cleanup on the data
    // Remove all whitespace charactes
    await queryInterface.sequelize.query(`
      UPDATE "Collectives"
      SET "githubHandle" = regexp_replace("githubHandle", '\s', '')
      WHERE "githubHandle" SIMILAR TO '%\s%'
    `);

    // Remove `/` trailing/leading
    await queryInterface.sequelize.query(`
      UPDATE "Collectives"
      SET "githubHandle" = trim("githubHandle", '/')
      WHERE "githubHandle" IS NOT NULL
      AND (
        "githubHandle" ILIKE '%/'
        OR "githubHandle" ILIKE '/%'
      )
    `);

    // Nullify empty strings
    await queryInterface.sequelize.query(`
      UPDATE "Collectives"
      SET "githubHandle" = NULL
      WHERE "githubHandle" IS NOT NULL
      AND LENGTH("githubHandle") = 0
    `);

    // Nullify invalid handles
    await queryInterface.sequelize.query(`
      UPDATE "Collectives"
      SET "githubHandle" = NULL
      WHERE "githubHandle" IS NOT NULL
      AND "githubHandle" NOT SIMILAR TO '[A-Za-z0-9_\\-\\.]+(/[A-Za-z0-9_\\-\\.]+)?'
    `);

    // githubHandle column will be removed in a future deployment to prevent any downtime between
    // the migration execution and the deployment
    const columnParams = { type: Sequelize.STRING, allowNull: true, defaultValue: null };
    await queryInterface.addColumn('CollectiveHistories', 'repositoryUrl', columnParams);
    await queryInterface.addColumn('Collectives', 'repositoryUrl', columnParams);
    await queryInterface.sequelize.query(`
      UPDATE "Collectives"
      SET "repositoryUrl" = 'https://github.com/' || "githubHandle"
      WHERE "githubHandle" IS NOT NULL
    `);
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('CollectiveHistories', 'repositoryUrl');
    await queryInterface.removeColumn('Collectives', 'repositoryUrl');
  },
};
