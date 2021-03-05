'use strict';

import '../server/env';

if (process.env.OC_ENV === 'ci' || process.env.OC_ENV === 'e2e') {
  module.exports = {
    up: async queryInterface => {
      await queryInterface.sequelize.query(`
	INSERT INTO "ConnectedAccounts" ("CreatedByUserId", service, "clientId", username, token, "CollectiveId", "createdAt", "updatedAt")
	VALUES (9475, 'github', 90020713, 'testuseradmingithub', 'foofoo', 10883, '2020-05-14 13:11:27.893+01', '2020-05-14 13:11:27.903+01');
    `);
    },

    down: async () => {
      // No rollback
    },
  };
} else {
  module.exports = {
    up: () => {
      return Promise.resolve();
    },

    down: async () => {
      // No rollback
    },
  };
}
