'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // Add the default feature flag for some accounts
    await queryInterface.sequelize.query(`
      UPDATE "Collectives"
      SET "data" = JSONB_SET("data", '{canHaveChangelogUpdates}', 'true')
      WHERE "slug" IN ('opencollective', 'ofitech')
    `);

    // Create index on publishedAt for changelog updates (as we're going to have them on multiple accounts)
    await queryInterface.addIndex('Updates', {
      name: 'Updates_changelog_publishedAt',
      where: {
        publishedAt: { [Sequelize.Op.ne]: null },
        isChangelog: true,
      },
      fields: [
        {
          name: 'publishedAt',
          order: 'DESC',
        },
      ],
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('Updates', 'Updates_changelog_publishedAt');
  },
};
