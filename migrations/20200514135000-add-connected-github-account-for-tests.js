'use strict';
import '../server/env';

if (process.env.NODE_ENV === 'ci' || process.env.NODE_ENV === 'e2e') {
  module.exports = {
    up: async queryInterface => {
      await queryInterface.sequelize.query(`
	INSERT INTO "ConnectedAccounts" ("CreatedByUserId", service, "clientId", username, token, "CollectiveId", "createdAt", "updatedAt")
	VALUES (9475, 'github', 90020713, 'testuseradmingithub', 'foofoo', 10883, '2020-05-14 13:11:27.893+01', '2020-05-14 13:11:27.903+01');
    `);
    },

    down: () => {},
  };
} else {
  module.exports = {
    up: () => {
      return Promise.resolve();
    },

    down: () => {},
  };
}
