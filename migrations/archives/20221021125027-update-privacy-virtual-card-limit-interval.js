'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE "VirtualCards" vc
      SET
        "spendingLimitInterval" = CASE 
            WHEN "spendingLimitInterval" = 'TRANSACTION' THEN 'PER_AUTHORIZATION'
            WHEN "spendingLimitInterval" = 'MONTHLY' THEN 'MONTHLY'
            WHEN "spendingLimitInterval" = 'ANNUALLY' THEN 'YEARLY'
            WHEN "spendingLimitInterval" = 'FOREVER' THEN 'ALL_TIME'
            ELSE "spendingLimitInterval" END
      WHERE 
        provider = 'PRIVACY';
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE "VirtualCards" vc
      SET
        "spendingLimitInterval" = CASE 
            WHEN "spendingLimitInterval" = 'PER_AUTHORIZATION' THEN 'TRANSACTION'
            WHEN "spendingLimitInterval" = 'MONTHLY' THEN 'MONTHLY'
            WHEN "spendingLimitInterval" = 'YEARLY' THEN 'ANNUALLY'
            WHEN "spendingLimitInterval" = 'ALL_TIME' THEN 'FOREVER'
            ELSE "spendingLimitInterval" END
      WHERE 
        provider = 'PRIVACY';
    `);
  },
};
