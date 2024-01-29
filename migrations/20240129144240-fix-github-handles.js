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
        SELECT
          c.id,
          c."githubHandle" AS current,
          (ARRAY_AGG(DISTINCT h."githubHandle"))[1] AS initial,
          regexp_replace((ARRAY_AGG(DISTINCT h."githubHandle"))[1], '\\s', '') AS expected, -- Not falling into the trap a second-time, double-escaping the backslash!
          c."repositoryUrl"
        FROM "Collectives" c
        INNER JOIN "CollectiveHistories" h ON h."id" = c.id
        WHERE c."githubHandle" IS NOT NULL
        AND c."createdAt" < '2022-04-01' -- Before https://github.com/opencollective/opencollective-api/blob/main/migrations/20220603111951-move-from-github-handle-to-repository-url.js#L9
        AND h."githubHandle" IS NOT NULL
        AND c."githubHandle" != h."githubHandle"
        AND c."githubHandle" = regexp_replace(regexp_replace(h."githubHandle", '\\s', ''), 's', '') -- Handle is equal to the initial one, but stripped of all whitespace and "s" characters
        GROUP BY c.id
        ORDER BY c."githubHandle" ASC
      ), updated_collectives AS (
        UPDATE "Collectives" c
        SET
          "githubHandle" = entries_to_fix.expected,
          "repositoryUrl" = CASE
            WHEN c."repositoryUrl" = 'https://github.com/' || entries_to_fix.current THEN 'https://github.com/' || entries_to_fix.expected
            ELSE c."repositoryUrl"
          END
        FROM entries_to_fix
        WHERE c.id = entries_to_fix.id
      ), updated_social_links AS (
        UPDATE "SocialLinks" sl
        SET "url" = 'https://github.com/' || entries_to_fix.expected
        FROM entries_to_fix
        WHERE sl."CollectiveId" = entries_to_fix.id
        AND sl.type = 'GITHUB'
        AND sl.url = 'https://github.com/' || entries_to_fix.current
      ) SELECT 1;
    `);
  },

  async down() {
    console.log('No rollback');
  },
};
