'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('Expenses', 'HostCollectiveId', {
      type: Sequelize.INTEGER,
      references: { key: 'id', model: 'Collectives' },
    });
    await queryInterface.addColumn('ExpenseHistories', 'HostCollectiveId', {
      type: Sequelize.INTEGER,
      references: { key: 'id', model: 'Collectives' },
    });

    await queryInterface.sequelize.query(
      `
        UPDATE
          "Expenses" as e
        SET
          "HostCollectiveId" = t."HostCollectiveId"
        FROM
          "Transactions" as t
        WHERE
          t."ExpenseId" = e."id"
          AND e."status" = 'PAID'
          AND t."kind" = 'EXPENSE'
          AND t."type" = 'DEBIT'
      `,
    );
  },

  down: async queryInterface => {
    await queryInterface.removeColumn('Expenses', 'HostCollectiveId');
    await queryInterface.removeColumn('ExpenseHistories', 'HostCollectiveId');
  },
};
