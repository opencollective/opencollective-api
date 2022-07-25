'use strict';

module.exports = {
  up: async queryInterface => {
    await queryInterface.sequelize.query(`
      UPDATE "Collectives" SET settings = jsonb_set("settings", '{tempCustomEmailMessage}', "settings" -> 'customEmailMessage') WHERE ("settings" -> 'customEmailMessage') IS NOT NULL;

      UPDATE "Collectives" SET settings = jsonb_set("settings", '{customEmailMessage}', '{}') WHERE ("settings" -> 'customEmailMessage') IS NOT NULL;

      UPDATE "Collectives" SET settings = jsonb_set("settings", '{customEmailMessage, thankYou}', "settings" -> 'tempCustomEmailMessage') WHERE ("settings" -> 'tempCustomEmailMessage') IS NOT NULL;

      UPDATE "Collectives" SET settings = settings #- '{tempCustomEmailMessage}' WHERE (settings -> 'tempCustomEmailMessage') IS NOT NULL;
    `);
  },

  down: async queryInterface => {
    await queryInterface.sequelize.query(`
      UPDATE "Collectives" SET settings = jsonb_set("settings", '{tempCustomEmailMessage}', "settings" -> 'customEmailMessage' -> 'thankYou') WHERE ("settings" -> 'customEmailMessage' -> 'thankYou') IS NOT NULL;

      UPDATE "Collectives" SET settings = jsonb_set("settings", '{customEmailMessage}', "settings" -> 'tempCustomEmailMessage') WHERE ("settings" -> 'tempCustomEmailMessage') IS NOT NULL;

      UPDATE "Collectives" SET settings = settings #- '{tempCustomEmailMessage}' WHERE (settings -> 'tempCustomEmailMessage') IS NOT NULL;
    `);
  },
};
