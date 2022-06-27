'use strict';

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE "Collectives"
      SET "data" = "data" || '{"policies": { "EXPENSE_AUTHOR_CANNOT_APPROVE": true }}'
      WHERE "data"->'policies' = '["EXPENSE_AUTHOR_CANNOT_APPROVE"]'::JSONB;
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE "Collectives"
      SET "data" = "data" || '{"policies": ["EXPENSE_AUTHOR_CANNOT_APPROVE"]}'
      WHERE "data"#>>'{policies,EXPENSE_AUTHOR_CANNOT_APPROVE}' = 'true';
    `);
  },
};
