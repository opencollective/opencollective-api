'use strict';

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE "Collectives"
      SET
        "slug" = 'opencollective-collective',
        "deletedAt" = NOW()
      WHERE "id" = 1
    `);
    await queryInterface.sequelize.query(`
      UPDATE "Collectives"
      SET
        "type" = 'ORGANIZATION',
        "slug" = 'opencollective',
        "HostCollectiveId" = 8686,
        "approvedAt" = NOW(),
        "isHostAccount" = TRUE,
        "isActive" = TRUE,
        "settings" = jsonb_set("settings"::jsonb, '{features, virtualCards}', 'true'::jsonb)
      WHERE "id" = 8686
    `);

    await queryInterface.sequelize.query(`
      UPDATE "Collectives"
      SET
        "settings" = jsonb_set("settings"::jsonb, '{features}', '{}'::jsonb)
      WHERE "id" = 9805
    `);

    await queryInterface.sequelize.query(`
      UPDATE "Collectives"
      SET
        "type" = 'ORGANIZATION',
        "HostCollectiveId" = 9805,
        "approvedAt" = NOW(),
        "isActive" = TRUE,
        "settings" = jsonb_set("settings"::jsonb, '{features, virtualCards}', 'true'::jsonb)
      WHERE "id" = 9805
    `);
    await queryInterface.sequelize.query(`
      UPDATE "ConnectedAccounts"
      SET
        "token" = 'U2FsdGVkX1+s78rEBZzsfGPPyu3gcmdjLEZ1cPmOx9CIcDYuTLYZ0nUr5T5M4tuUakCZ2eXMoBOpKuTV7v0YYlmcPYv8FZEG4WwCUdauXQUy8CC6CjZRtVLlF1YVnlZDgADxlW69cHdTIE4sAKLPszQy0J7ptDOXfZdX9mQtLhM='
      WHERE "id" = 2131
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE "Collectives"
      SET
        "type" = 'ORGANIZATION',
        "HostCollectiveId" = null,
        "approvedAt" = nul,
        "isActive" = FALSE,
        "settings" = jsonb_set("settings"::jsonb, '{features, virtualCards}', 'false'::jsonb)
      WHERE "id" = 9805
    `);
    await queryInterface.sequelize.query(`
      UPDATE "Collectives"
      SET
        "type" = 'USER',
        "slug" = 'opencollectivehost',
        "HostCollectiveId" = null,
        "approvedAt" = null,
        "isHostAccount" = FALSE,
        "isActive" = FALSE,
        "settings" = jsonb_set("settings"::jsonb, '{features, virtualCards}', 'false'::jsonb)
      WHERE "id" = 8686
    `);
    await queryInterface.sequelize.query(`
      UPDATE "Collectives"
      SET
        "slug" = 'opencollective',
        "deletedAt" = null
      WHERE "id" = 1
    `);
  },
};
