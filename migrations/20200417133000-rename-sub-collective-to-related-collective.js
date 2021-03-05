'use strict';

module.exports = {
  up: queryInterface => {
    return queryInterface.sequelize.query(`
      UPDATE  "Members"
      SET     "role" = 'CONNECTED_COLLECTIVE'
      WHERE   "role" = 'SUB_COLLECTIVE'
    `);
  },

  down: queryInterface => {
    return queryInterface.sequelize.query(`
      UPDATE  "Members"
      SET     "role" = 'SUB_COLLECTIVE'
      WHERE   "role" = 'CONNECTED_COLLECTIVE'
    `);
  },
};
