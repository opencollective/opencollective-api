'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE "PaymentMethods"
      SET
        "expiryDate" = to_date((data ->> 'expYear')::varchar || '-' || (data ->> 'expMonth')::varchar, 'YYYY-MM') + INTERVAL '1 month' - INTERVAL '1 ms',
        "data" = JSONB_SET(data, '{expiryDateSetFrom20241212132217Migration}', 'true'::jsonb)
      WHERE "expiryDate" IS NULL
      AND data ->> 'expYear' IS NOT NULL
      AND data ->> 'expMonth' IS NOT NULL
      AND "deletedAt" IS NULL
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE "PaymentMethods"
      SET
        "expiryDate" = NULL,
        "data" = data - 'expiryDateSetFrom20241212132217Migration'
      WHERE data -> 'expiryDateSetFrom20241212132217Migration' IS NOT NULL
      AND "deletedAt" IS NULL
    `);
  },
};
