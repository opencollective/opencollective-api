import '../server/env';

import { QueryTypes } from 'sequelize';

import { sequelize } from '../server/models';

/**
 * This script updates the value of Collectives approvedAt
 */

async function run() {
  const collectives = await sequelize.query(
    `
      SELECT * FROM "Collectives"
      WHERE "Collectives"."isActive" IS TRUE
      AND "Collectives"."approvedAt" = '2019-08-06'
  `,
    { type: QueryTypes.SELECT },
  );

  for (const collective of collectives) {
    const [membership] = await sequelize.query(
      `
      SELECT "since" FROM "Members" m
      WHERE m."CollectiveId" = :collectiveId
      AND m."MemberCollectiveId" = :MemberCollectiveId
      AND m."role" = 'HOST'
  `,
      {
        replacements: {
          collectiveId: collective.id,
          MemberCollectiveId: collective.HostCollectiveId,
        },
        type: QueryTypes.SELECT,
      },
    );

    if (membership) {
      return sequelize.query(
        `
      UPDATE "Collectives"
        SET "approvedAt" = :approvedAt
      WHERE "id" = :collectiveId
    `,
        {
          replacements: {
            approvedAt: membership.since,
            collectiveId: collective.id,
          },
        },
      );
    }
  }
}

if (require.main === module) {
  run()
    .then(() => {
      console.log('>>> Completed!');
      process.exit();
    })
    .catch(err => {
      console.error(err);
      process.exit();
    });
}
