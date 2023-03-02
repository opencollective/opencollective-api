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
      street: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      street2: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      postalCode: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      city: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      state: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      countryISO: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      geoLocationLatLong: {
        type: DataTypes.JSONB,
        allowNull: true,
      },
      type: {
        type: DataTypes.ENUM('LEGAL', 'DISPLAY'),
        defaultValue: 'DISPLAY',
        allowNull: false,
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
      CreatedByUserId: {
        type: DataTypes.INTEGER,
        references: { key: 'id', model: 'Users' },
        allowNull: true,
        onDelete: 'SET NULL',
        onUpdate: 'SET NULL',
      },
    });

    await queryInterface.sequelize.query(`
      INSERT INTO
        "Locations" ("name", "address", "countryISO", "type", "CollectiveId", "geoLocationLatLong")
      SELECT
        "locationName",
        "address",
        "countryISO",
        CASE
          WHEN "type" = 'INDIVIDUAL' THEN 'LEGAL'::"enum_Locations_type"
          ELSE 'DISPLAY'::"enum_Locations_type"
        END,
        "id",
        "geoLocationLatLong"
      FROM "Collectives" 
  `);
  },

  async down(queryInterface) {
    /**
     * Add reverting commands here.
     *
     * Example:
     * await queryInterface.dropTable('users');
     */
    await queryInterface.dropTable('Locations');
  },
};
