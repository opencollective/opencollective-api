'use strict';

module.exports = {
  up: (queryInterface, Sequelize) => {
    return queryInterface.sequelize.query(`
      UPDATE  "Members"
      SET     "role" = 'CONNECTED_COLLECTIVE'
      WHERE   "role" = 'SUB_COLLECTIVE'
    `);
  },

  down: (queryInterface, Sequelize) => {
    return queryInterface.sequelize.query(`
      UPDATE  "Members"
      SET     "role" = 'SUB_COLLECTIVE'
      WHERE   "role" = 'CONNECTED_COLLECTIVE'
    `);
  },
};
