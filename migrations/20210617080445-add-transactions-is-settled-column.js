'use strict';

module.exports = {
  up: async (queryInterface, DataTypes) => {
    await queryInterface.addColumn('Transactions', 'isSettled', {
      type: DataTypes.BOOLEAN,
      allowNull: true,
    });

    await queryInterface.sequelize.query(`
      UPDATE "Transactions" t
      SET "isSettled" = TRUE
      FROM "TransactionSettlements" s
      WHERE t."TransactionGroup" = s."TransactionGroup"
      AND t."kind" = s."kind"
      AND s."status" = 'SETTLED'
    `);
  },

  down: async queryInterface => {
    await queryInterface.removeColumn('Transactions', 'isSettled');
  },
};
