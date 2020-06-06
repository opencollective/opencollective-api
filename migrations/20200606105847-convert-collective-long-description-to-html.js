'use strict';

import Promise from 'bluebird';
import showdown from 'showdown';

const converter = new showdown.Converter();

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const collectives = await queryInterface.sequelize.query(
      `
        SELECT * FROM "Collectives"
        WHERE LENGTH("longDescription") > 0 AND "longDescription" NOT LIKE '<%';
      `,
      { type: Sequelize.QueryTypes.SELECT },
    );

    await Promise.map(collectives, collective =>
      queryInterface.sequelize.query(
        `
        UPDATE "Collectives" c
        SET "longDescription" = :longDescription
        WHERE c.id = :id
      `,
        {
          replacements: {
            longDescription: converter.makeHtml(collective.longDescription),
            id: collective.id,
          },
        },
      ),
    );
  },

  down: async (queryInterface, Sequelize) => {
    const collectives = await queryInterface.sequelize.query(
      `
        SELECT * FROM "Collectives"
        WHERE LENGTH("longDescription") > 0;
      `,
      { type: Sequelize.QueryTypes.SELECT },
    );

    await Promise.map(collectives, collective =>
      queryInterface.sequelize.query(
        `
        UPDATE "Collectives" c
        SET "longDescription" = :longDescription
        WHERE c.id = :id
      `,
        {
          replacements: {
            longDescription: converter.makeMarkdown(collective.longDescription),
            id: collective.id,
          },
        },
      ),
    );
  },
};
