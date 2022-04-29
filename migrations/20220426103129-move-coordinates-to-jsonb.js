'use strict';

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE "CollectiveHistories"
      ALTER COLUMN "geoLocationLatLong" TYPE JSONB
      USING st_asgeojson("geoLocationLatLong")::jsonb
    `);

    await queryInterface.sequelize.query(`
      ALTER TABLE "Collectives"
      ALTER COLUMN "geoLocationLatLong" TYPE JSONB
      USING st_asgeojson("geoLocationLatLong")::jsonb
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE "Collectives"
      ALTER COLUMN "geoLocationLatLong" TYPE GEOMETRY('POINT')
      USING ST_POINT(
        ("geoLocationLatLong" -> 'coordinates' ->> 0)::float,
        ("geoLocationLatLong" -> 'coordinates' ->> 1)::float
      )
    `);
  },
};
