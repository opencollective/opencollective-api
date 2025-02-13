'use strict';

import logger from '../server/lib/logger';

import { mergeDataDeep } from './lib/helpers';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const page = 1;
    while (true) {
      const collectives = await queryInterface.sequelize.query(
        `SELECT id, data FROM "Collectives" WHERE data ? 'data' LIMIT 500`,
        { type: Sequelize.QueryTypes.SELECT },
      );

      if (collectives.length === 0) {
        break;
      }

      logger.info(`Processing page ${page} with ${collectives.length} collectives`);
      const updates = [];
      for (const collective of collectives) {
        const newData = mergeDataDeep(collective.data);
        updates.push({ id: collective.id, data: collective.data, newData });
        await queryInterface.sequelize.query(`UPDATE "Collectives" SET data = :newData WHERE id = :id`, {
          replacements: { newData: JSON.stringify(newData), id: collective.id },
        });
      }

      logger.info(`Deleting nested data for ${updates.length} collectives`);
      await queryInterface.sequelize.query(
        `
        UPDATE "Collectives"
        SET data = data - 'data'
        WHERE id IN (:ids)
      `,
        { replacements: { ids: updates.map(update => update.id) } },
      );
    }
  },

  async down() {
    console.log('Please look at the migration logs to see the data that was migrated');
  },
};
