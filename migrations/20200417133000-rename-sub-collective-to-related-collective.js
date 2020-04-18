'use strict';

module.exports = {
  up: (queryInterface, Sequelize) => {
    return queryInterface.sequelize.query(`
      UPDATE  "Members"
      SET     "role" = 'RELATED_COLLECTIVE'
      WHERE   "role" = 'SUB_COLLECTIVE'
    `);
  },

  down: (queryInterface, Sequelize) => {
    return queryInterface.sequelize.query(`
      UPDATE  "Members"
      SET     "role" = 'SUB_COLLECTIVE'
      WHERE   "role" = 'RELATED_COLLECTIVE'
    `);
  },
};
