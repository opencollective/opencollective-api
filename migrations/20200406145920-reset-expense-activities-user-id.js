'use strict';

/**
 * Before this migration, all activities created for expenses had their UserId set to the
 * expense's submitter user ID. This was wrong because this field is supposed to tell you who
 * triggered the action (ie. pay, approve, etc.).
 *
 * This migration sets the UserId to null for all these corrupted entries.
 *
 * 'collective.expense.created' is not in the list because we can trust the `UserId` for this one
 */
module.exports = {
  up: (queryInterface, Sequelize) => {
    return queryInterface.sequelize.query(`
      UPDATE  "Activities"
      SET     "UserId" = NULL
      WHERE   "type" IN (
        'collective.expense.deleted',
        'collective.expense.updated',
        'collective.expense.rejected',
        'collective.expense.approved',
        'collective.expense.paid',
        'collective.expense.processing',
        'collective.expense.error'
      )
    `);
  },

  down: (queryInterface, Sequelize) => {
    return queryInterface.sequelize.query(`
      UPDATE  "Activities"
      SET     "UserId" = CAST(("data"#>>'{user,id}') AS INT)
      WHERE   "type" IN (
        'collective.expense.deleted',
        'collective.expense.updated',
        'collective.expense.rejected',
        'collective.expense.approved',
        'collective.expense.paid',
        'collective.expense.processing',
        'collective.expense.error'
      )
    `);
  },
};
