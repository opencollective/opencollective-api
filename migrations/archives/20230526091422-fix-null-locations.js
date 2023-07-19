'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    /**
     * Some Locations were not migrated correctly, where a null value from Collective.data.address
     * became the string "null" in the structured jsonb column
     *
     * This migration fixes that and makes sure to set the name and address from the Collective data
     * which was not set due to the previous migration skipping those since it found a structured value ("null")
     */
    await queryInterface.sequelize.query(`
      UPDATE "Locations" l
      SET 
        "name" = COALESCE(c."locationName", c."address"),
        "address" = c."address",
        "structured" = NULL
      FROM 
        "Collectives" c
      WHERE 
        l."CollectiveId" = c.id AND 
        l."structured" = 'null';
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
