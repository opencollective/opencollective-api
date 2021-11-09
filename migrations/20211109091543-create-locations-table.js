'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    // TODO remove this rollback
    await queryInterface.removeColumn('Collectives', 'LocationId');
    await queryInterface.removeColumn('CollectiveHistories', 'LocationId');
    await queryInterface.removeColumn('Expenses', 'LocationId');
    await queryInterface.removeColumn('ExpenseHistories', 'LocationId');
    await queryInterface.dropTable('Locations');

    // Introduce the new table
    await queryInterface.createTable('Locations', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      CollectiveId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'Collectives', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      country: {
        type: Sequelize.STRING(2),
        allowNull: false,
      },
      name: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      address: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      latitude: {
        type: Sequelize.FLOAT,
        allowNull: true,
      },
      longitude: {
        type: Sequelize.FLOAT,
        allowNull: true,
      },
      structured: {
        type: Sequelize.JSONB,
        allowNull: true,
      },
      isMainLegalAddress: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      createdAt: {
        type: Sequelize.DATE,
        defaultValue: Sequelize.NOW,
        allowNull: false,
      },
      updatedAt: {
        type: Sequelize.DATE,
        defaultValue: Sequelize.NOW,
        allowNull: false,
      },
      deletedAt: {
        type: Sequelize.DATE,
        allowNull: true,
      },
    });

    // Can only have one main legal address, let's enforce that with a unique index
    await queryInterface.addIndex('Locations', ['CollectiveId'], {
      unique: true,
      where: {
        isMainLegalAddress: true,
      },
    });

    // Link this new table to Collectives and Expenses
    const locationIdFieldAttributes = {
      type: Sequelize.INTEGER,
      references: { key: 'id', model: 'Locations' },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
      allowNull: true,
    };

    await queryInterface.addColumn('CollectiveHistories', 'LocationId', locationIdFieldAttributes);
    await queryInterface.addColumn('Collectives', 'LocationId', locationIdFieldAttributes);
    await queryInterface.addColumn('ExpenseHistories', 'LocationId', locationIdFieldAttributes);
    await queryInterface.addColumn('Expenses', 'LocationId', locationIdFieldAttributes);

    // Migrate all existing addresses
    // Expense => payeeLocation
    await queryInterface.sequelize.query(`
      WITH inserted_locations AS (
        INSERT INTO "Locations" (
          "CollectiveId",
          "country",
          "address",
          "structured",
          "createdAt",
          "updatedAt"
        ) SELECT
          "FromCollectiveId",
          "payeeLocation" ->> 'country',
          "payeeLocation" ->> 'address',
          JSONB_SET(COALESCE("payeeLocation" ->> 'structured', '{}), '{__ExpenseId__}', "Expenses".id)
          "createdAt",
          "createdAt"
        FROM "Expenses"
        WHERE "payeeLocation" IS NOT NULL
        AND "payeeLocation" ->> 'country' IS NOT NULL
        RETURNING "Locations"."id" as "LocationId", "Expenses"."id" as "ExpenseId"
      ) UPDATE "Expenses" e -- TODO We need to retrieve the ID from "structured" here
      SET "LocationId" = inserted_locations."LocationId"
      FROM inserted_locations
      WHERE e."id" = inserted_locations."ExpenseId"
    `);

    // Collectives table fields (address, latitude, longitude, data => address (structured))
    await queryInterface.sequelize.query(`
      WITH inserted_locations AS (
        INSERT INTO "Locations" (
          "CollectiveId",
          "isMainLegalAddress",
          "country",
          "address",
          "structured",
          "latitude",
          "longitude",
          "createdAt",
          "updatedAt"
        ) SELECT
          c."id",
          TRUE,
          c."countryISO',
          c."address",
          c."data" -> 'address',
          ST_X(c."geoLocationLatLong"),
          ST_Y(c."geoLocationLatLong"),
          c."createdAt",
          c."createdAt"
        FROM "Collectives" c
        WHERE "deletedAt" IS NULL
        AND (
          c."geoLocationLatLong" IS NOT NULL
          OR c."address" IS NOT NULL
          OR c."data" -> 'address' IS NOT NULL
        )
        RETURNING "Locations"."id" as "LocationId", "Locations"."CollectiveId" as "CollectiveId"
      ) UPDATE "Collectives" c
      SET "LocationId" = inserted_locations."LocationId"
      FROM inserted_locations
      WHERE c."id" = inserted_locations."CollectiveId"
    `);

    // TODO remove stuff from structured
    // TODO empty structured
  },

  down: async queryInterface => {
    await queryInterface.removeColumn('Collectives', 'LocationId');
    await queryInterface.removeColumn('CollectiveHistories', 'LocationId');
    await queryInterface.removeColumn('Expenses', 'LocationId');
    await queryInterface.removeColumn('ExpenseHistories', 'LocationId');
    await queryInterface.dropTable('Locations');
  },
};
