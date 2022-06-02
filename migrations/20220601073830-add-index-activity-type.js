'use strict';

module.exports = {
  up: async queryInterface => {
    await queryInterface.addIndex('Activities', ['type']);
  },

  down: async queryInterface => {
    await queryInterface.removeIndex('Activities', ['type']);
  },
};
