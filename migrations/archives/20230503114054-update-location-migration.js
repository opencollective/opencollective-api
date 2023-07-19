'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    /**
     * Updates the migrated Locations to only set the name and address when structured address was missing
     * and also set address as locationName if missing (enabling slightly better migration to autocomplete input)
     */
    await queryInterface.sequelize.query(`
      UPDATE "Locations" l
      SET 
        "name" = CASE
                  WHEN l."structured" IS NULL THEN COALESCE(c."locationName", c."address")
                  ELSE NULL
                END,
        "address" = CASE
                      WHEN l."structured" IS NULL THEN c."address"
                      ELSE NULL
                    END
      FROM "Collectives" c
      WHERE 
        l."CollectiveId" = c.id AND (
          c."locationName" IS NOT NULL OR 
          c."address" IS NOT NULL OR 
          c."countryISO" IS NOT NULL OR 
          c."geoLocationLatLong" IS NOT NULL OR
          c."data"->'address' IS NOT NULL
        )
    `);
  },

  async down() {
    /**
     * Add reverting commands here.
     *
     * Example:
     * await queryInterface.dropTable('users');
     */
  },
};
