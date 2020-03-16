'use strict';

module.exports = {
  up: async queryInterface => {
    await queryInterface.sequelize.query(`
      DELETE * FROM "ConnectedAccounts" WHERE id NOT IN (
        SELECT DISTINCT ON (token, service, username) id
        FROM "ConnectedAccounts"
        WHERE "deletedAt" IS NULL
        AND "CollectiveId" IN (
          SELECT id
          FROM "Collectives"
          WHERE "deletedAt" IS NULL
          AND "isActive" = true
        )
        ORDER BY token, service, username, id desc
      );
    `);
    await queryInterface.addIndex('ConnectedAccounts', ['service', 'token'], {
      indexName: 'UniqueToken',
      indicesType: 'UNIQUE',
    });
  },

  down: async () => {
    await queryInterface.removeIndex('ConnectedAccounts', 'UniqueToken');
  },
};
