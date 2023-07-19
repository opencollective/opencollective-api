'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    // Add an index on TierId, mostly for `context.loaders.Tier.contributorsStats`
    await queryInterface.addIndex('Members', ['TierId'], {
      concurrently: true,
      where: { deletedAt: null },
    });

    // Make the CollectiveId/Role index non-null
    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS public."CollectiveId-role";
    `);

    await queryInterface.addIndex('Members', ['CollectiveId', 'role'], {
      concurrently: true,
      where: { deletedAt: null },
    });

    // On Members, make the MemberCollectiveId/CollectiveId/Role
    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS public."MemberCollectiveId-CollectiveId-role";
    `);

    await queryInterface.addIndex('Members', ['MemberCollectiveId', 'CollectiveId', 'role'], {
      concurrently: true,
      where: { deletedAt: null },
    });
  },

  async down(queryInterface) {
    // Add an index on TierId, mostly for `context.loaders.Tier.contributorsStats`
    await queryInterface.removeIndex('Members', ['TierId']);

    // Make the CollectiveId/Role index non-null
    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS public."CollectiveId-role";
    `);

    await queryInterface.addIndex('Members', ['CollectiveId', 'role'], {
      concurrently: true,
    });

    // On Members, make the MemberCollectiveId/CollectiveId/Role
    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS public."MemberCollectiveId-CollectiveId-role";
    `);

    await queryInterface.addIndex('Members', ['MemberCollectiveId', 'CollectiveId', 'role'], {
      concurrently: true,
    });
  },
};
