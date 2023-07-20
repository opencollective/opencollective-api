'use strict';

import { SocialLinkType } from '../server/models/SocialLink';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('SocialLinks', {
      CollectiveId: {
        type: Sequelize.INTEGER,
        references: { model: 'Collectives', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
        allowNull: false,
        primaryKey: true,
      },
      type: {
        type: Sequelize.STRING,
        allowNull: false,
        defaultValue: SocialLinkType.WEBSITE,
        primaryKey: true,
      },
      url: {
        type: Sequelize.STRING,
        allowNull: false,
        primaryKey: true,
      },
      order: {
        type: Sequelize.INTEGER,
        allowNull: false,
      },
      createdAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.fn('now'),
      },
      updatedAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.fn('now'),
      },
    });

    await queryInterface.addIndex('SocialLinks', ['CollectiveId']);

    await queryInterface.sequelize.query(`
      INSERT INTO "SocialLinks"("CollectiveId", type, url, "order")
      SELECT c.id, 'WEBSITE', trim(c."website"), 0
      FROM "Collectives" c
      WHERE c."deletedAt" is NULL and trim(coalesce(c."website", '')) <> ''
      ON CONFLICT DO NOTHING
    `);

    await queryInterface.sequelize.query(`
      INSERT INTO "SocialLinks"("CollectiveId", type, url, "order")
      SELECT c.id, 'TWITTER', CONCAT('https://twitter.com/', trim(c."twitterHandle")), 1
      FROM "Collectives" c
      WHERE c."deletedAt" is NULL and trim(coalesce(c."twitterHandle", '')) <> ''
      ON CONFLICT DO NOTHING
    `);

    await queryInterface.sequelize.query(`
      INSERT INTO "SocialLinks"("CollectiveId", type, url, "order")
      SELECT c.id, 'GITHUB', trim(c."repositoryUrl"), 2
      FROM "Collectives" c
      WHERE c."deletedAt" is NULL and c."repositoryUrl" like 'https://github.com%'
      ON CONFLICT DO NOTHING
    `);

    await queryInterface.sequelize.query(`
      INSERT INTO "SocialLinks"("CollectiveId", type, url, "order")
      SELECT c.id, 'GITLAB', trim(c."repositoryUrl"), 2
      FROM "Collectives" c
      WHERE c."deletedAt" is NULL and c."repositoryUrl" like 'https://gitlab.com%'
      ON CONFLICT DO NOTHING
    `);

    await queryInterface.sequelize.query(`
      INSERT INTO "SocialLinks"("CollectiveId", type, url, "order")
      SELECT c.id, 'GIT', trim(c."repositoryUrl"), 2
      FROM "Collectives" c
      WHERE c."deletedAt" is NULL and c."repositoryUrl" not like 'https://github.com%'
      and c."repositoryUrl" not like 'https://gitlab.com%'
      ON CONFLICT DO NOTHING
    `);
  },

  async down(queryInterface) {
    await queryInterface.dropTable('SocialLinks');
  },
};
