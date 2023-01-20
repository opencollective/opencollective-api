-- Ban a list of collectives from the platform, including all their associated data
--
-- Variables:
--  • collectiveSlugs: The list of collective slugs to ban
-- 
-- ---------------------------------------------------------------------------------


WITH requested_collectives AS (
  SELECT   id 
  FROM    "Collectives"
  WHERE   slug = ANY($collectiveSlugs)
), deleted_profiles AS (
  -- Delete all requested collectives and their children
  UPDATE ONLY "Collectives" c
  SET         "deletedAt" = NOW(),
              "slug" = c.slug || '-' || extract(epoch from NOW())::text,
              data = (COALESCE(to_jsonb(data), '{}' :: jsonb) || '{"isBanned": true}' :: jsonb)
  FROM        requested_collectives
  WHERE       c."id" = requested_collectives.id
  OR          c."ParentCollectiveId" = requested_collectives.id
  RETURNING   c.id
), deleted_users AS (
  -- Delete the users (with their email preserved, they will be banned permanently)
  -- This block has no effect on collectives/orgs
  UPDATE ONLY "Users" u
  SET         "deletedAt" = NOW(),
              data = (COALESCE(to_jsonb(data), '{}' :: jsonb) || '{"isBanned": true}' :: jsonb)
  FROM        deleted_profiles
  WHERE       u."CollectiveId" = deleted_profiles.id
  RETURNING   u.id
), deleted_oauth_authorization_codes AS (
  UPDATE ONLY "OAuthAuthorizationCodes" code
  SET         "deletedAt" = NOW(),
              data = (COALESCE(to_jsonb(data), '{}' :: jsonb) || '{"isBanned": true}' :: jsonb)
  FROM        deleted_users u
  WHERE       u."id" = code."UserId"
  RETURNING   code.id
), deleted_user_tokens AS (
  -- User tokens
  UPDATE ONLY "UserTokens" t
  SET         "deletedAt" = NOW(),
              data = (COALESCE(to_jsonb(data), '{}' :: jsonb) || '{"isBanned": true}' :: jsonb)
  FROM        deleted_users
  WHERE       t."UserId" = deleted_users.id
  RETURNING   t.id
), transactions_groups_to_delete AS (
  SELECT DISTINCT "TransactionGroup"
  FROM "Transactions" t
  INNER JOIN deleted_profiles
    ON deleted_profiles.id = t."CollectiveId"
    OR deleted_profiles.id = t."FromCollectiveId"
    OR deleted_profiles.id = t."HostCollectiveId"
  WHERE t."TransactionGroup" IS NOT NULL
  AND t."deletedAt" IS NULL
), deleted_transactions AS (
  -- Delete the transactions
  UPDATE ONLY "Transactions" t
  SET         "deletedAt" = NOW(),
              data = (COALESCE(to_jsonb(data), '{}' :: jsonb) || '{"isBanned": true}' :: jsonb)
  FROM        transactions_groups_to_delete
  WHERE       t."TransactionGroup" = transactions_groups_to_delete."TransactionGroup"
  RETURNING   t.id
), deleted_transaction_settlements AS (
  -- Delete the transaction settlements
  UPDATE ONLY "TransactionSettlements" ts
  SET         "deletedAt" = NOW()
  FROM        transactions_groups_to_delete
  WHERE       ts."TransactionGroup" = transactions_groups_to_delete."TransactionGroup"
  RETURNING   ts."TransactionGroup"
), deleted_tiers AS (
  -- Delete tiers
  UPDATE ONLY "Tiers" t SET "deletedAt" = NOW()
  FROM        deleted_profiles
  WHERE       t."CollectiveId" = deleted_profiles.id 
  RETURNING   t.id
), deleted_members AS (
  -- Delete members and membershipses
  UPDATE ONLY "Members" m SET "deletedAt" = NOW()
  FROM        deleted_profiles
  -- for the   collective
  WHERE       m."MemberCollectiveId" = deleted_profiles.id 
  OR          m."CollectiveId" = deleted_profiles.id
  RETURNING   m.id
), deleted_updates AS (
  -- Delete updates
  UPDATE ONLY "Updates" u SET "deletedAt" = NOW()
  FROM        deleted_profiles
  WHERE       u."CollectiveId" = deleted_profiles.id 
  OR          u."FromCollectiveId" = deleted_profiles.id 
  RETURNING   u.id
), deleted_payment_methods AS (
  -- Delete payment methods
  UPDATE ONLY "PaymentMethods" pm SET "deletedAt" = NOW()
  FROM        deleted_profiles
  WHERE       pm."CollectiveId" = deleted_profiles.id 
  RETURNING   pm.id
), deleted_connected_accounts AS (
  -- Delete connected accounts
  UPDATE ONLY "ConnectedAccounts" ca SET "deletedAt" = NOW()
  FROM        deleted_profiles
  WHERE       ca."CollectiveId" = deleted_profiles.id 
  RETURNING   ca.id
), deleted_conversations AS (
  -- Delete conversations
  UPDATE ONLY "Conversations" conv SET "deletedAt" = NOW()
  FROM        deleted_profiles
  WHERE       conv."FromCollectiveId" = deleted_profiles.id
  OR          conv."CollectiveId" = deleted_profiles.id
  RETURNING   conv.id
), deleted_conversation_followers AS (
  -- Delete conversations followers
  DELETE FROM "ConversationFollowers" f
  USING       deleted_users, deleted_conversations
  WHERE       f."UserId" = deleted_users.id
  OR          f."ConversationId" = deleted_conversations.id
  RETURNING   f.id
), deleted_expenses AS (
  -- Delete expenses
  UPDATE ONLY "Expenses" e SET "deletedAt" = NOW()
  WHERE       e."deletedAt" IS NULL
  AND         id IN (
    SELECT id FROM "Expenses" e WHERE "CollectiveId" IN (SELECT id FROM deleted_profiles)
    UNION DISTINCT SELECT id FROM "Expenses" e WHERE "FromCollectiveId" IN (SELECT id FROM deleted_profiles)
    UNION DISTINCT SELECT id FROM "Expenses" e WHERE "UserId" IN (SELECT id FROM deleted_users)
  )
  RETURNING   e.id
), deleted_comments AS (
  -- Delete comments
  UPDATE ONLY "Comments" com SET "deletedAt" = NOW()
  WHERE "deletedAt" IS NULL
  AND id IN (
    SELECT id FROM "Comments" WHERE "CollectiveId" IN (SELECT id FROM deleted_profiles)
    UNION DISTINCT SELECT id FROM "Comments" WHERE "FromCollectiveId" IN (SELECT id FROM deleted_profiles)
    UNION DISTINCT SELECT id FROM "Comments" WHERE "ConversationId" IN (SELECT id FROM deleted_conversations)
    UNION DISTINCT SELECT id FROM "Comments" WHERE "ExpenseId" IN (SELECT id FROM deleted_expenses)
    UNION DISTINCT SELECT id FROM "Comments" WHERE "UpdateId" IN (SELECT id FROM deleted_updates)
  )
  RETURNING   com.id
), deleted_applications AS (
  -- Delete applications
  UPDATE ONLY "Applications" app SET "deletedAt" = NOW()
  WHERE       app."deletedAt" IS NULL
  AND         id IN (
    SELECT id FROM "Applications" WHERE "CollectiveId" IN (SELECT id FROM deleted_profiles)
    UNION DISTINCT SELECT id FROM "Applications" WHERE "CreatedByUserId" IN (SELECT id FROM deleted_users)
  )
  RETURNING   app.id
), deleted_orders AS (
  -- Delete orders
  UPDATE ONLY "Orders" o SET "deletedAt" = NOW()
  FROM        deleted_profiles
  WHERE       (o."FromCollectiveId" = deleted_profiles.id OR o."CollectiveId" = deleted_profiles.id)
  RETURNING   o.id
), deleted_notifications AS (
  -- Delete notifications
  DELETE FROM "Notifications" n
  USING       deleted_users
  WHERE       n."UserId" = deleted_users.id
  RETURNING   n.id
), deleted_recurring_expenses AS (
  -- Delete Recurring Expenses 
  UPDATE ONLY "RecurringExpenses" re SET "deletedAt" = NOW()
  FROM        deleted_profiles
  WHERE       (re."FromCollectiveId" = deleted_profiles.id OR re."CollectiveId" = deleted_profiles.id)
  RETURNING   re.id
) SELECT 
  (SELECT COUNT(*) FROM deleted_profiles) AS nb_deleted_profiles,
  (SELECT COUNT(*) FROM deleted_users) AS deleted_users,
  (SELECT COUNT(*) FROM deleted_oauth_authorization_codes) AS nb_deleted_oauth_authorization_codes,
  (SELECT COUNT(*) FROM deleted_user_tokens) AS nb_deleted_user_tokens,
  (SELECT COUNT(*) FROM deleted_transactions) AS nb_deleted_transactions,
  (SELECT COUNT(*) FROM deleted_transaction_settlements) AS nb_deleted_transaction_settlements,
  (SELECT COUNT(*) FROM deleted_tiers) AS nb_deleted_tiers,
  (SELECT COUNT(*) FROM deleted_members) AS nb_deleted_members,
  (SELECT COUNT(*) FROM deleted_updates) AS nb_deleted_updates,
  (SELECT COUNT(*) FROM deleted_payment_methods) AS nb_deleted_payment_methods,
  (SELECT COUNT(*) FROM deleted_connected_accounts) AS nb_deleted_connected_accounts,
  (SELECT COUNT(*) FROM deleted_conversations) AS nb_deleted_conversations,
  (SELECT COUNT(*) FROM deleted_conversation_followers) AS nb_deleted_conversation_followers,
  (SELECT COUNT(*) FROM deleted_comments) AS nb_deleted_comments,
  (SELECT COUNT(*) FROM deleted_expenses) AS nb_deleted_expenses,
  (SELECT COUNT(*) FROM deleted_applications) AS nb_deleted_applications,
  (SELECT COUNT(*) FROM deleted_orders) AS nb_deleted_orders,
  (SELECT COUNT(*) FROM deleted_notifications) AS nb_deleted_notifications,
  (SELECT COUNT(*) FROM deleted_users) AS nb_deleted_users,
  (SELECT COUNT(*) FROM deleted_recurring_expenses) AS nb_deleted_recurring_expenses,
  (SELECT ARRAY_AGG(deleted_profiles.id) FROM deleted_profiles) AS deleted_profiles_ids
  
-- TODO:
-- Delete associated incognito profiles
