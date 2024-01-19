'use strict';

/**
 * An iteration on https://github.com/opencollective/opencollective-api/blob/main/migrations/20220603111951-move-from-github-handle-to-repository-url.js
 * that ended up stripping all `s` characters from the `githubHandle` column.
 */

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      WITH entries_to_fix AS (
        SELECT c.id, c."githubHandle" AS current, ARRAY_AGG(DISTINCT h."githubHandle") AS initial, c."repositoryUrl"
        FROM "Collectives" c
        INNER JOIN "CollectiveHistories" h ON h."id" = c.id
        WHERE c."githubHandle" IS NOT NULL
        AND c."createdAt" < '2022-04-01' -- Before https://github.com/opencollective/opencollective-api/blob/main/migrations/20220603111951-move-from-github-handle-to-repository-url.js#L9
        AND h."githubHandle" IS NOT NULL
        AND c."githubHandle" != h."githubHandle"
        AND c."githubHandle" = regexp_replace(regexp_replace(h."githubHandle", '\\s', ''), 's', '') -- Handle is equal to the initial one, but stripped of all whitespace and "s" characters
        GROUP BY c.id
        ORDER BY c."githubHandle" ASC
      ) UPDATE "Collectives" c
      SET
        -- Not falling into the trap a second-time, double-escaping the backslash!
        "githubHandle" = regexp_replace(initial[1], '\\s', ''),
        -- We also want to update the "repositoryUrl" column
        "repositoryUrl" = CASE
          WHEN c."repositoryUrl" = 'https://github.com/' || current THEN 'https://github.com/' || regexp_replace(initial[1], '\\s', '')
          ELSE c."repositoryUrl"
        END
      FROM entries_to_fix
      WHERE c.id = entries_to_fix.id
    `);
  },

  async down() {
    console.log('No rollback');
  },
};
