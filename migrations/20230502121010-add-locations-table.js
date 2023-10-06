'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, DataTypes) {
    await queryInterface.createTable('Locations', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: DataTypes.INTEGER,
      },
      name: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      address: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      country: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      structured: {
        type: DataTypes.JSONB,
        allowNull: true,
      },
      geoLocationLatLong: {
        type: DataTypes.JSONB,
        allowNull: true,
      },
      CollectiveId: {
        type: DataTypes.INTEGER,
        references: { key: 'id', model: 'Collectives' },
        allowNull: true,
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      createdAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.fn('NOW'),
      },
      updatedAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.fn('NOW'),
      },
      deletedAt: {
        allowNull: true,
        type: DataTypes.DATE,
      },
    });

    await queryInterface.addIndex('Locations', ['CollectiveId'], {
      concurrently: true,
      where: { deletedAt: null },
    });

    await queryInterface.sequelize.query(`
      INSERT INTO "Locations" ("name", "address", "country", "CollectiveId", "geoLocationLatLong", "structured")
      SELECT 
          "locationName",
          "address",
          "countryISO",
          id,
          "geoLocationLatLong",
          "data"->'address'
      FROM "Collectives"
      WHERE 
          "locationName" IS NOT NULL OR 
          "address" IS NOT NULL OR 
          "countryISO" IS NOT NULL OR 
          "geoLocationLatLong" IS NOT NULL OR
          "data"->'address' IS NOT NULL;
    `);
  },

  async down(queryInterface) {
    await queryInterface.dropTable('Locations');
  },
};
