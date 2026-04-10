'use strict';

import type { QueryInterface } from 'sequelize';

import { regenerateRowsDescriptionsForGocardlessInstitution } from './lib/gocardless';

module.exports = {
  async up(queryInterface: QueryInterface) {
    await regenerateRowsDescriptionsForGocardlessInstitution(queryInterface, 'COOPERATIVE_CPBKGB22');
  },

  async down() {
    // Irreversible: we cannot restore the previous description format from the new one
  },
};
