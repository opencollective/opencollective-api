'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    console.time('Linking for COLLECTIVE_CREATED activities');
    await queryInterface.sequelize.query(`
      UPDATE "Activities" a
      SET "HostCollectiveId" = COALESCE(a."HostCollectiveId", a."CollectiveId"),
          "CollectiveId" = (a.data -> 'collective' ->> 'id')::int
      WHERE a.type = 'collective.created'
      AND a.data -> 'collective' ->> 'id' IS NOT NULL
    `);
    console.timeEnd('Linking for COLLECTIVE_CREATED activities');

    console.time('Linking for COLLECTIVE_APPROVED activities');
    await queryInterface.sequelize.query(`
      UPDATE "Activities" a
      SET "HostCollectiveId" = COALESCE(a."HostCollectiveId", a."CollectiveId"),
          "CollectiveId" = (a.data -> 'collective' ->> 'id')::int
      WHERE a.type = 'collective.approved'
      AND a.data -> 'collective' ->> 'id' IS NOT NULL
    `);
    console.timeEnd('Linking for COLLECTIVE_APPROVED activities');

    console.time('Linking for COLLECTIVE_REJECTED activities');
    await queryInterface.sequelize.query(`
      UPDATE "Activities" a
      SET "HostCollectiveId" = COALESCE(a."HostCollectiveId", a."CollectiveId"),
          "CollectiveId" = (a.data -> 'collective' ->> 'id')::int
      WHERE a.type = 'collective.rejected'
      AND a.data -> 'collective' ->> 'id' IS NOT NULL
    `);
    console.timeEnd('Linking for COLLECTIVE_REJECTED activities');
  },

  async down() {
    /**
     * No rollback
     */
  },
};
