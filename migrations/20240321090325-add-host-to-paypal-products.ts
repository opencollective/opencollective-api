'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('PaypalProducts', 'HostCollectiveId', {
      type: Sequelize.INTEGER,
      references: { model: 'Collectives', key: 'id' },
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
      allowNull: true, // Should be switched to false once all products have a host
    });

    // Set all `HostCollectiveId` for active collectives
    await queryInterface.sequelize.query(`
      UPDATE "PaypalProducts" pp
      SET "HostCollectiveId" = c."HostCollectiveId"
      FROM "Collectives" c
      WHERE pp."CollectiveId" = c.id
      AND pp."HostCollectiveId" IS NULL
      AND c."HostCollectiveId" IS NOT NULL
      AND c."approvedAt" IS NOT NULL
    `);
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('PaypalProducts', 'HostCollectiveId');
  },
};
