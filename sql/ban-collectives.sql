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
  AND     "deletedAt" IS NULL
), deleted_collectives AS (
  -- Delete all requested collectives and their children
  UPDATE ONLY "Collectives" c
  SET         "deletedAt" = NOW(),
              "slug" = c.slug || '-' || extract(epoch from NOW())::text,
              data = (COALESCE(to_jsonb(data), '{}' :: jsonb) || '{"isBanned": true}' :: jsonb)
  FROM        requested_collectives
  WHERE       (c."id" = requested_collectives.id OR c."ParentCollectiveId" = requested_collectives.id)
  AND         c."deletedAt" IS NULL
  RETURNING   c.id
), deleted_users AS (
  -- Delete the users (with their email preserved, they will be banned permanently)
  -- This block has no effect on collectives/orgs
  UPDATE ONLY "Users" u
  SET         "deletedAt" = NOW(),
              data = (COALESCE(to_jsonb(data), '{}' :: jsonb) || '{"isBanned": true}' :: jsonb)
  FROM        deleted_collectives
  WHERE       u."CollectiveId" = deleted_collectives.id
  AND         u."deletedAt" IS NULL
  RETURNING   u.id
), deleted_two_factor_methods AS (
  UPDATE ONLY "UserTwoFactorMethods" tfm
  SET         "deletedAt" = NOW()
  FROM        deleted_users
  WHERE       tfm."UserId" = deleted_users.id
  AND         tfm."deletedAt" IS NULL
  RETURNING   tfm.id
), deleted_oauth_authorization_codes AS (
  UPDATE ONLY "OAuthAuthorizationCodes" code
  SET         "deletedAt" = NOW(),
              data = (COALESCE(to_jsonb(data), '{}' :: jsonb) || '{"isBanned": true}' :: jsonb)
  FROM        deleted_users u
  WHERE       u."id" = code."UserId"
  AND         code."deletedAt" IS NULL
  RETURNING   code.id
), deleted_user_tokens AS (
  -- User tokens
  UPDATE ONLY "UserTokens" t
  SET         "deletedAt" = NOW(),
              data = (COALESCE(to_jsonb(data), '{}' :: jsonb) || '{"isBanned": true}' :: jsonb)
  FROM        deleted_users
  WHERE       t."UserId" = deleted_users.id
  AND         t."deletedAt" IS NULL
  RETURNING   t.id
), transactions_groups_to_delete AS (
  SELECT DISTINCT "TransactionGroup"
  FROM "Transactions" t
  INNER JOIN deleted_collectives
    ON deleted_collectives.id = t."CollectiveId"
    OR deleted_collectives.id = t."FromCollectiveId"
    OR deleted_collectives.id = t."HostCollectiveId"
  WHERE t."TransactionGroup" IS NOT NULL
  AND t."deletedAt" IS NULL
), deleted_transactions AS (
  -- Delete the transactions
  UPDATE ONLY "Transactions" t
  SET         "deletedAt" = NOW(),
              data = (COALESCE(to_jsonb(data), '{}' :: jsonb) || '{"isBanned": true}' :: jsonb)
  FROM        transactions_groups_to_delete
  WHERE       t."TransactionGroup" = transactions_groups_to_delete."TransactionGroup"
  AND         t."deletedAt" IS NULL
  RETURNING   t.id
), deleted_transaction_settlements AS (
  -- Delete the transaction settlements
  UPDATE ONLY "TransactionSettlements" ts
  SET         "deletedAt" = NOW()
  FROM        transactions_groups_to_delete
  WHERE       ts."TransactionGroup" = transactions_groups_to_delete."TransactionGroup"
  AND         ts."deletedAt" IS NULL
  RETURNING   ts."TransactionGroup"
), deleted_tiers AS (
  -- Delete tiers
  UPDATE ONLY "Tiers" t SET "deletedAt" = NOW()
  FROM        deleted_collectives
  WHERE       t."CollectiveId" = deleted_collectives.id
  AND         t."deletedAt" IS NULL
  RETURNING   t.id
), deleted_members AS (
  -- Delete members and memberships
  UPDATE ONLY "Members" m SET "deletedAt" = NOW()
  FROM        deleted_collectives
  WHERE       (m."MemberCollectiveId" = deleted_collectives.id OR m."CollectiveId" = deleted_collectives.id)
  AND         m."deletedAt" IS NULL
  RETURNING   m.id
), deleted_member_invitations AS (
  -- Delete member invitations
  UPDATE ONLY "MemberInvitations" mi SET "deletedAt" = NOW()
  FROM        deleted_collectives
  WHERE       (mi."MemberCollectiveId" = deleted_collectives.id OR mi."CollectiveId" = deleted_collectives.id)
  AND         mi."deletedAt" IS NULL
  RETURNING   mi.id
), deleted_updates AS (
  -- Delete updates
  UPDATE ONLY "Updates" u SET "deletedAt" = NOW()
  FROM        deleted_collectives
  WHERE       (u."CollectiveId" = deleted_collectives.id OR u."FromCollectiveId" = deleted_collectives.id)
  AND         u."deletedAt" IS NULL
  RETURNING   u.id
), deleted_legal_documents AS (
  -- Delete legal documents
  UPDATE ONLY "LegalDocuments" ld SET "deletedAt" = NOW()
  FROM        deleted_collectives
  WHERE       ld."CollectiveId" = deleted_collectives.id 
  AND         ld."deletedAt" IS NULL
  RETURNING   ld.id
), deleted_agreements AS (
  -- Delete Agreements
  UPDATE ONLY "Agreements" a SET "deletedAt" = NOW()
  FROM        deleted_collectives
  WHERE       (a."CollectiveId" = deleted_collectives.id OR a."HostCollectiveId" = deleted_collectives.id)
  AND         a."deletedAt" IS NULL
  RETURNING   a.id
), deleted_locations AS (
  -- Delete locations
  UPDATE ONLY "Locations" l SET "deletedAt" = NOW()
  FROM        deleted_collectives 
  WHERE       l."CollectiveId" = deleted_collectives.id
  AND         l."deletedAt" IS NULL
  RETURNING   l.id
), deleted_payment_methods AS (
  -- Delete payment methods
  UPDATE ONLY "PaymentMethods" pm SET "deletedAt" = NOW()
  FROM        deleted_collectives
  WHERE       pm."CollectiveId" = deleted_collectives.id 
  AND         pm."deletedAt" IS NULL
  RETURNING   pm.id
), deleted_connected_accounts AS (
  -- Delete connected accounts
  UPDATE ONLY "ConnectedAccounts" ca SET "deletedAt" = NOW()
  FROM        deleted_collectives
  WHERE       ca."CollectiveId" = deleted_collectives.id
  AND         ca."deletedAt" IS NULL
  RETURNING   ca.id
), deleted_conversations AS (
  -- Delete conversations
  UPDATE ONLY "Conversations" conv SET "deletedAt" = NOW()
  FROM        deleted_collectives
  WHERE       (conv."FromCollectiveId" = deleted_collectives.id OR conv."CollectiveId" = deleted_collectives.id)
  AND         conv."deletedAt" IS NULL
  RETURNING   conv.id
), deleted_conversation_followers AS (
  -- Delete conversations followers
  DELETE FROM "ConversationFollowers" f
  WHERE
    EXISTS (SELECT 1 FROM deleted_users WHERE deleted_users.id = f."UserId")
    OR EXISTS (SELECT 1 FROM deleted_conversations WHERE deleted_conversations.id = f."ConversationId")
  RETURNING   f.id
), deleted_expenses AS (
  -- Delete expenses
  UPDATE ONLY "Expenses" e SET "deletedAt" = NOW()
  WHERE       e."deletedAt" IS NULL
  AND         id IN (
    SELECT id FROM "Expenses" e WHERE "CollectiveId" IN (SELECT id FROM deleted_collectives)
    UNION DISTINCT SELECT id FROM "Expenses" e WHERE "FromCollectiveId" IN (SELECT id FROM deleted_collectives)
    UNION DISTINCT SELECT id FROM "Expenses" e WHERE "UserId" IN (SELECT id FROM deleted_users)
  )
  RETURNING   e.id
), deleted_expense_items AS (
  -- Delete expense items
  UPDATE ONLY "ExpenseItems" ei SET "deletedAt" = NOW()
  FROM        deleted_expenses
  WHERE       ei."ExpenseId" = deleted_expenses.id
  AND         ei."deletedAt" IS NULL
  RETURNING   ei.id
), deleted_comments AS (
  -- Delete comments
  UPDATE ONLY "Comments" com SET "deletedAt" = NOW()
  WHERE "deletedAt" IS NULL
  AND id IN (
    SELECT id FROM "Comments" WHERE "CollectiveId" IN (SELECT id FROM deleted_collectives)
    UNION DISTINCT SELECT id FROM "Comments" WHERE "FromCollectiveId" IN (SELECT id FROM deleted_collectives)
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
    SELECT id FROM "Applications" WHERE "CollectiveId" IN (SELECT id FROM deleted_collectives)
    UNION DISTINCT SELECT id FROM "Applications" WHERE "CreatedByUserId" IN (SELECT id FROM deleted_users)
  )
  RETURNING   app.id
), deleted_orders AS (
  -- Delete orders
  UPDATE ONLY "Orders" o SET "deletedAt" = NOW()
  FROM        deleted_collectives
  WHERE       (o."FromCollectiveId" = deleted_collectives.id OR o."CollectiveId" = deleted_collectives.id)
  AND         o."deletedAt" IS NULL
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
  FROM        deleted_collectives
  WHERE       (re."FromCollectiveId" = deleted_collectives.id OR re."CollectiveId" = deleted_collectives.id)
  AND         re."deletedAt" IS NULL
  RETURNING   re.id
), deleted_transactions_imports AS (
  -- Delete transactions imports
  UPDATE ONLY "TransactionsImports" ti SET "deletedAt" = NOW()
  FROM       deleted_collectives
  WHERE       ti."CollectiveId" = deleted_collectives.id
  AND         ti."deletedAt" IS NULL
  RETURNING   ti.id
), deleted_transactions_import_rows AS (
  -- Delete transactions import rows
  UPDATE ONLY "TransactionsImportsRows" tir SET "deletedAt" = NOW()
  FROM        deleted_transactions_imports
  WHERE       tir."TransactionsImportId" = deleted_transactions_imports.id
  AND         tir."deletedAt" IS NULL
  RETURNING   tir.id
), deleted_host_applications AS (
  -- Delete host applications
  UPDATE ONLY "HostApplications" ha SET "deletedAt" = NOW()
  FROM        deleted_collectives
  WHERE       (ha."CollectiveId" = deleted_collectives.id OR ha."HostCollectiveId" = deleted_collectives.id)
  AND         ha."deletedAt" IS NULL
  RETURNING   ha.id
), deleted_payout_methods AS (
  -- Delete payout methods
  UPDATE ONLY "PayoutMethods" pm SET "deletedAt" = NOW()
  FROM        deleted_collectives
  WHERE       pm."CollectiveId" = deleted_collectives.id
  AND         pm."deletedAt" IS NULL
  RETURNING   pm.id
), deleted_virtual_cards AS (
  -- Delete virtual cards
  UPDATE ONLY "VirtualCards" vc SET "deletedAt" = NOW()
  FROM        deleted_collectives
  WHERE       (vc."CollectiveId" = deleted_collectives.id OR vc."HostCollectiveId" = deleted_collectives.id)
  AND         vc."deletedAt" IS NULL
  RETURNING   vc.id
), deleted_virtual_card_requests AS (
  -- Delete virtual card requests
  UPDATE ONLY "VirtualCardRequests" vcr SET "deletedAt" = NOW()
  FROM        deleted_collectives
  WHERE       (vcr."CollectiveId" = deleted_collectives.id OR vcr."HostCollectiveId" = deleted_collectives.id)
  AND         vcr."deletedAt" IS NULL
  RETURNING   vcr.id
), deleted_platform_subscriptions AS (
  -- Delete platform subscriptions
  UPDATE ONLY "PlatformSubscriptions" ps SET "deletedAt" = NOW()
  FROM        deleted_collectives
  WHERE       ps."CollectiveId" = deleted_collectives.id
  AND         ps."deletedAt" IS NULL
  RETURNING   ps.id
), deleted_personal_tokens AS (
  -- Delete personal tokens
  UPDATE ONLY "PersonalTokens" pt SET "deletedAt" = NOW()
  WHERE       pt."deletedAt" IS NULL
  AND         (
    EXISTS (SELECT 1 FROM deleted_collectives WHERE deleted_collectives.id = pt."CollectiveId")
    OR EXISTS (SELECT 1 FROM deleted_users WHERE deleted_users.id = pt."UserId")
  )
  RETURNING   pt.id
), deleted_required_legal_documents AS (
  -- Delete required legal documents
  UPDATE ONLY "RequiredLegalDocuments" rld SET "deletedAt" = NOW()
  FROM        deleted_collectives
  WHERE       rld."HostCollectiveId" = deleted_collectives.id
  AND         rld."deletedAt" IS NULL
  RETURNING   rld.id
) SELECT 
  (SELECT COUNT(*) FROM deleted_collectives) AS nb_deleted_collectives,
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
  (SELECT COUNT(*) FROM deleted_transactions_imports) AS nb_deleted_transactions_imports,
  (SELECT COUNT(*) FROM deleted_transactions_import_rows) AS nb_deleted_transactions_import_rows,
  (SELECT COUNT(*) FROM deleted_host_applications) AS nb_deleted_host_applications,
  (SELECT COUNT(*) FROM deleted_payout_methods) AS nb_deleted_payout_methods,
  (SELECT COUNT(*) FROM deleted_virtual_cards) AS nb_deleted_virtual_cards,
  (SELECT COUNT(*) FROM deleted_virtual_card_requests) AS nb_deleted_virtual_card_requests,
  (SELECT COUNT(*) FROM deleted_platform_subscriptions) AS nb_deleted_platform_subscriptions,
  (SELECT COUNT(*) FROM deleted_personal_tokens) AS nb_deleted_personal_tokens,
  (SELECT COUNT(*) FROM deleted_required_legal_documents) AS nb_deleted_required_legal_documents,
  (SELECT COUNT(*) FROM deleted_legal_documents) AS nb_deleted_legal_documents,
  (SELECT COUNT(*) FROM deleted_agreements) AS nb_deleted_agreements,
  (SELECT COUNT(*) FROM deleted_locations) AS nb_deleted_locations,
  (SELECT COUNT(*) FROM deleted_member_invitations) AS nb_deleted_member_invitations,
  (SELECT COUNT(*) FROM deleted_expense_items) AS nb_deleted_expense_items,
  (SELECT ARRAY_AGG(deleted_collectives.id) FROM deleted_collectives) AS deleted_collectives_ids
  
-- TODO:
-- Delete associated incognito profiles
-- Delete uploaded files, unless they're used for paid expenses or other critical things
