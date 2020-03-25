'use strict';

import models from '../server/models';

module.exports = {
  up: queryInterface => {
    // We don't want to keep the `isPledged` flag anymore when the collective is claimed.
    // For already active collectives, this information is moved to `data.hasBeenPledged`
    // so that we don't loose it.
    return queryInterface.sequelize.query(`
      UPDATE 
        "Collectives"
      SET     
        "isPledged" = FALSE, 
        data = (
          CASE WHEN data IS NULL 
          THEN '{"hasBeenPledged": true}'::jsonb
          ELSE data::jsonb || '{"hasBeenPledged": true}'::jsonb
        END)
      WHERE 
        "isPledged" IS TRUE AND "isActive" IS TRUE
    `);
  },

  down: async (queryInterface, Sequelize) => {},
};
