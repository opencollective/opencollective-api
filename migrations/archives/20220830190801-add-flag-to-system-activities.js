'use strict';

module.exports = {
  up: async queryInterface => {
    await queryInterface.sequelize.query(`
      UPDATE "Activities"
      SET data = jsonb_set("data", '{isSystem}', 'true')
      WHERE "Activities".type IN (
        'taxform.request',
        'collective.expense.error',
        'collective.virtualcard.missing.receipts',
        'collective.monthlyreport',
        'payment.failed',
        'payment.creditcard.expiring',
        'virtualcard.charge.declined'
      );
    `);
  },

  down: async queryInterface => {
    await queryInterface.sequelize.query(`
      UPDATE "Activities"
      SET data = data #- '{isSystem}'
      WHERE "Activities".type IN (
        'taxform.request',
        'collective.expense.error',
        'collective.virtualcard.missing.receipts',
        'collective.monthlyreport',
        'payment.failed',
        'payment.creditcard.expiring',
        'virtualcard.charge.declined'
      );
    `);
  },
};
