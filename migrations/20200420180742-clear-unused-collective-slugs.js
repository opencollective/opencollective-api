'use strict';

module.exports = {
  up: queryInterface => {
    return queryInterface.sequelize.query(`
      UPDATE "Collectives"
      SET slug = concat(slug, '-', round(extract(epoch from now())*1000))
      WHERE "deletedAt" IS NOT NULL
      AND slug NOT SIMILAR TO '%\d{12}%';
    `);
  },

  down: () => {},
};
