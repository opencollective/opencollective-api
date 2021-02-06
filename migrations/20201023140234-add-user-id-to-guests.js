'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    // Delete all tokens to make sure the migration will pass. There are no guest tokens
    // in staging/prod currently, so this is safe.
    await queryInterface.sequelize.query(`DELETE FROM "GuestTokens"`);

    return queryInterface.addColumn('GuestTokens', 'UserId', {
      type: Sequelize.INTEGER,
      references: { key: 'id', model: 'Users' },
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
      allowNull: false,
      unique: true,
    });
  },

  down: async queryInterface => {
    return queryInterface.removeColumn('GuestTokens', 'UserId');
  },
};
