'use strict';

module.exports = {
  up: async queryInterface => {
    await queryInterface.sequelize.query(`
	INSERT INTO "ConnectedAccounts" (id, "CreatedByUserId", service, "clientId", username, token, "CollectiveId", "createdAt", "updatedAt")
	VALUES (2136, 9475, 'github', 90020713, 'testuseradmingithub', 'foofoo', 10883, '2020-05-14 13:11:27.893+01', '2020-05-14 13:11:27.903+01');
    `);
  },

  down: async queryInterface => {
    await queryInterface.sequelize.query(`
	DELETE FROM "ConnectedAccounts"
	WHERE "id" = 2136;
  `);
  },
};
