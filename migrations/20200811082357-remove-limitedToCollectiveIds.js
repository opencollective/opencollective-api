'use strict';

module.exports = {
  up: async queryInterface => {
    // As the behavior for `limitedToCollectiveIds` was similar to `limitedToHostCollectiveIds`,
    // we migrate the value of the first to the second if there's not one already
    await queryInterface.sequelize.query(`
      UPDATE  "PaymentMethods" pm
      SET     "limitedToHostCollectiveIds" = "limitedToCollectiveIds"
      WHERE   "limitedToHostCollectiveIds" IS NULL
      AND     "limitedToCollectiveIds" IS NOT NULL
    `);

    return queryInterface.removeColumn('PaymentMethods', 'limitedToCollectiveIds');
  },

  down: async (queryInterface, Sequelize) => {
    return queryInterface.addColumn('PaymentMethods', 'limitedToCollectiveIds', {
      type: Sequelize.ARRAY(Sequelize.INTEGER),
    });
  },
};
