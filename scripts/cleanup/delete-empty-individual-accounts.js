import '../../server/env';

import { sequelize } from '../../server/models';

async function run() {
  await sequelize.query(`WITH
"CollectivesWithTransactions" as (
  SELECT "CollectiveId" as "id" FROM "Transactions" WHERE "deletedAt" IS NULL GROUP BY "CollectiveId"
),
 "CollectivesWithFromTransactions" as (
  SELECT "FromCollectiveId" as "id" FROM "Transactions" WHERE "deletedAt" IS NULL GROUP BY "FromCollectiveId"
),
 "CollectivesWithExpenses" as (
  SELECT "CollectiveId" as "id" FROM "Expenses" WHERE "deletedAt" IS NULL GROUP BY "CollectiveId"
),
 "CollectivesWithFromExpenses" as (
  SELECT "FromCollectiveId" as "id" FROM "Expenses" WHERE "deletedAt" IS NULL GROUP BY "FromCollectiveId"
),
"UsersWithExpenses" as (
  SELECT "UserId" as "id" FROM "Expenses" WHERE "deletedAt" IS NULL GROUP BY "UserId"
),
"CollectivesWithMembers" as (
  SELECT "CollectiveId" as "id" FROM "Members" WHERE "deletedAt" IS NULL GROUP BY "CollectiveId"
),
"CollectivesWithMemberships" as (
  SELECT "MemberCollectiveId" as "id" FROM "Members" WHERE "deletedAt" IS NULL GROUP BY "MemberCollectiveId"
),
"CollectivesWithMemberInvitations" as (
  SELECT "MemberCollectiveId" as "id" FROM "MemberInvitations" WHERE "deletedAt" IS NULL GROUP BY "MemberCollectiveId"
),
"CollectivesWithApplications" as (
  SELECT "CollectiveId" as "id" FROM "Applications" WHERE "deletedAt" IS NULL GROUP BY "CollectiveId"
),
"UsersWithTokens" as (
  SELECT "UserId" as "id" FROM "UserTokens" WHERE "deletedAt" IS NULL GROUP BY "UserId"
),
"CollectivesWithFromConversations" as (
  SELECT "FromCollectiveId" as "id" FROM "Conversations" WHERE "deletedAt" IS NULL GROUP BY "FromCollectiveId"
),
"CollectivesWithFromComments" as (
  SELECT "FromCollectiveId" as "id" FROM "Comments" WHERE "deletedAt" IS NULL GROUP BY "FromCollectiveId"
),
"CollectivesWithFromEmojiReactions" as (
  SELECT "FromCollectiveId" as "id" FROM "EmojiReactions" GROUP BY "FromCollectiveId"
)
UPDATE "Users" u
  SET "deletedAt" = NOW(),
  "email" = CONCAT(SPLIT_PART("email", '@', 1), '++', SPLIT_PART(extract(epoch from now())::text, '.', 1),  '@', SPLIT_PART("email", '@', 2)),
   "data" = (COALESCE(to_jsonb(u."data"), '{}' :: jsonb) || '{"isInactive": true}' :: jsonb)
FROM "Collectives" c
  WHERE c."id" = u."CollectiveId"
  AND GREATEST(c."updatedAt", u."updatedAt", u."lastLoginAt", u."passwordUpdatedAt", u."changelogViewDate") < '2022-01-01'
  AND u."deletedAt" IS NULL
  AND c."deletedAt" IS NULL
  AND c."deactivatedAt" IS NULL
  AND NOT EXISTS (SELECT "id" FROM "CollectivesWithTransactions" WHERE "id" = c."id")
  AND NOT EXISTS (SELECT "id" FROM "CollectivesWithFromTransactions" WHERE "id" = c."id")
  AND NOT EXISTS (SELECT "id" FROM "CollectivesWithExpenses" WHERE "id" = c."id")
  AND NOT EXISTS (SELECT "id" FROM "CollectivesWithFromExpenses" WHERE "id" = c."id")
  AND NOT EXISTS (SELECT "id" FROM "UsersWithExpenses" WHERE "id" = u."id")
  AND NOT EXISTS (SELECT "id" FROM "CollectivesWithMembers" WHERE "id" = c."id")
  AND NOT EXISTS (SELECT "id" FROM "CollectivesWithMemberships" WHERE "id" = c."id")
  AND NOT EXISTS (SELECT "id" FROM "CollectivesWithMemberInvitations" WHERE "id" = c."id")
  AND NOT EXISTS (SELECT "id" FROM "CollectivesWithApplications" WHERE "id" = c."id")
  AND NOT EXISTS (SELECT "id" FROM "UsersWithTokens" WHERE "id" = u."id")
  AND NOT EXISTS (SELECT "id" FROM "CollectivesWithFromConversations" WHERE "id" = c."id")
  AND NOT EXISTS (SELECT "id" FROM "CollectivesWithFromComments" WHERE "id" = c."id")
  AND NOT EXISTS (SELECT "id" FROM "CollectivesWithFromEmojiReactions" WHERE "id" = c."id")
  AND u."lastLoginAt" IS NULL
  AND (c."description" IS NULL OR c."description" = '')
  AND (c."longDescription" IS NULL OR c."longDescription" = '')
  AND (c."website" IS NULL)
  AND (c."twitterHandle" IS NULL)`);

  // Soft-delete Collectives (Individual accounts) which don't have a matching User anymore
  await sequelize.query(
    `UPDATE "Collectives"
     SET "deletedAt" = NOW()
     WHERE "type" = 'USER'
     AND "deletedAt" IS NULL
     AND NOT EXISTS (SELECT "id" FROM "Users" WHERE "CollectiveId" = "Collectives"."id" AND "deletedAt" IS NULL)`,
  );
}

run()
  .then(() => {
    console.log('>>> Completed!');
    process.exit();
  })
  .catch(err => {
    console.error(err);
    process.exit();
  });
