'use strict';

module.exports = {
  up: async queryInterface => {
    await queryInterface.sequelize.query(`
      UPDATE "Collectives" SET settings = jsonb_set("settings", '{invoice, templates}', '{"default": {}}') WHERE ("settings" -> 'invoiceTitle') IS NOT NULL;

      UPDATE "Collectives" SET settings = jsonb_set("settings", '{invoice, templates, default, title}', "settings" -> 'invoiceTitle') WHERE ("settings" -> 'invoiceTitle') IS NOT NULL;

      UPDATE "Collectives" SET settings = jsonb_set("settings", '{invoice, templates, default, info}', "settings" -> 'invoice' -> 'extraInfo') WHERE ("settings" -> 'invoice' -> 'extraInfo') IS NOT NULL;

      UPDATE "Collectives" SET settings = settings #- '{invoiceTitle}' WHERE (settings -> 'invoiceTitle') IS NOT NULL;

      UPDATE "Collectives" SET settings = settings #- '{invoice, extraInfo}' WHERE ("settings" -> 'invoice' -> 'extraInfo') IS NOT NULL;
    `);
  },

  down: async queryInterface => {
    await queryInterface.sequelize.query(`
      UPDATE "Collectives" SET settings = jsonb_set("settings", '{invoiceTitle}', "settings" -> 'invoice' -> 'templates' -> 'default' -> 'title') WHERE ("settings" -> 'invoice' -> 'templates' -> 'default' -> 'title') IS NOT NULL;

      UPDATE "Collectives" SET settings = jsonb_set("settings", '{invoice, extraInfo}', "settings" -> 'invoice' -> 'templates' -> 'default' -> 'info') WHERE ("settings" -> 'invoice' -> 'templates' -> 'default' -> 'info') IS NOT NULL;

      UPDATE "Collectives" SET settings = settings #- '{invoice, templates}' WHERE (settings -> 'invoiceTitle') IS NOT NULL;
    `);
  },
};
