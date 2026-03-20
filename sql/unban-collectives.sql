-- Reverses what was done by ./ban-collectives.sql
--
-- Variables:
--  • collectiveSlugs: The list of collective slugs to unban (including the epoch suffix, e.g. `banned-slug-123456.789012`)
--  • restoredAfterDate: The date after which the collectives were banned (e.g. `2026-03-19`)
--
-- ---------------------------------------------------------------------------------
WITH target_collectives AS (
  -- Find the banned collectives by slug (they were renamed with epoch suffix)
  SELECT id
  FROM "Collectives"
  WHERE slug = ANY($collectiveSlugs)
  AND "deletedAt" >= $restoredAfterDate
), restored_collectives AS (
  UPDATE ONLY "Collectives" c
  SET
    "deletedAt" = NULL,
    "slug"      = REGEXP_REPLACE(c.slug, '-[0-9]+(\.[0-9]+)?$', ''),
    data        = c.data - 'isBanned'
  FROM target_collectives
  WHERE
    (c.id = target_collectives.id OR c."ParentCollectiveId" = target_collectives.id)
    AND c."deletedAt" >= $restoredAfterDate
  RETURNING c.id
), restored_users AS (
  UPDATE ONLY "Users" u
  SET
    "deletedAt" = NULL,
    data        = u.data - 'isBanned'
  FROM restored_collectives
  WHERE
    u."CollectiveId" = restored_collectives.id
    AND u."deletedAt" >= $restoredAfterDate
  RETURNING u.id
), restored_two_factor_methods AS (
  UPDATE ONLY "UserTwoFactorMethods" tfm
  SET "deletedAt" = NULL
  FROM restored_users
  WHERE
    tfm."UserId" = restored_users.id
    AND tfm."deletedAt" >= $restoredAfterDate
  RETURNING tfm.id
), restored_oauth_authorization_codes AS (
  UPDATE ONLY "OAuthAuthorizationCodes" code
  SET
    "deletedAt" = NULL,
    data        = code.data - 'isBanned'
  FROM restored_users u
  WHERE
    u.id = code."UserId"
    AND code."deletedAt" >= $restoredAfterDate
  RETURNING code.id
), restored_user_tokens AS (
  UPDATE ONLY "UserTokens" t
  SET
    "deletedAt" = NULL,
    data        = t.data - 'isBanned'
  FROM restored_users
  WHERE
    t."UserId" = restored_users.id
    AND t."deletedAt" >= $restoredAfterDate
  RETURNING t.id
), transactions_groups_to_restore AS (
  SELECT DISTINCT "TransactionGroup"
  FROM "Transactions" t
  INNER JOIN restored_collectives
    ON restored_collectives.id = t."CollectiveId"
    OR restored_collectives.id = t."FromCollectiveId"
    OR restored_collectives.id = t."HostCollectiveId"
  WHERE
    t."TransactionGroup" IS NOT NULL
    AND t."deletedAt" >= $restoredAfterDate
), restored_transactions AS (
  UPDATE ONLY "Transactions" t
  SET
    "deletedAt" = NULL,
    data        = t.data - 'isBanned'
  FROM transactions_groups_to_restore
  WHERE
    t."TransactionGroup" = transactions_groups_to_restore."TransactionGroup"
    AND t."deletedAt" >= $restoredAfterDate
  RETURNING t.id
), restored_transaction_settlements AS (
  UPDATE ONLY "TransactionSettlements" ts
  SET "deletedAt" = NULL
  FROM transactions_groups_to_restore
  WHERE
    ts."TransactionGroup" = transactions_groups_to_restore."TransactionGroup"
    AND ts."deletedAt" >= $restoredAfterDate
  RETURNING ts."TransactionGroup"
), restored_tiers AS (
  UPDATE ONLY "Tiers" t
  SET "deletedAt" = NULL
  FROM restored_collectives
  WHERE
    t."CollectiveId" = restored_collectives.id
    AND t."deletedAt" >= $restoredAfterDate
  RETURNING t.id
), restored_members AS (
  UPDATE ONLY "Members" m
  SET "deletedAt" = NULL
  FROM restored_collectives
  WHERE
    (m."MemberCollectiveId" = restored_collectives.id OR m."CollectiveId" = restored_collectives.id)
    AND m."deletedAt" >= $restoredAfterDate
  RETURNING m.id
), restored_member_invitations AS (
  UPDATE ONLY "MemberInvitations" mi
  SET "deletedAt" = NULL
  FROM restored_collectives
  WHERE
    (mi."MemberCollectiveId" = restored_collectives.id OR mi."CollectiveId" = restored_collectives.id)
    AND mi."deletedAt" >= $restoredAfterDate
  RETURNING mi.id
), restored_updates AS (
  UPDATE ONLY "Updates" u
  SET "deletedAt" = NULL
  FROM restored_collectives
  WHERE
    (u."CollectiveId" = restored_collectives.id OR u."FromCollectiveId" = restored_collectives.id)
    AND u."deletedAt" >= $restoredAfterDate
  RETURNING u.id
), restored_legal_documents AS (
  UPDATE ONLY "LegalDocuments" ld
  SET "deletedAt" = NULL
  FROM restored_collectives
  WHERE
    ld."CollectiveId" = restored_collectives.id
    AND ld."deletedAt" >= $restoredAfterDate
  RETURNING ld.id
), restored_agreements AS (
  UPDATE ONLY "Agreements" a
  SET "deletedAt" = NULL
  FROM restored_collectives
  WHERE
    (a."CollectiveId" = restored_collectives.id OR a."HostCollectiveId" = restored_collectives.id)
    AND a."deletedAt" >= $restoredAfterDate
  RETURNING a.id
), restored_locations AS (
  UPDATE ONLY "Locations" l
  SET "deletedAt" = NULL
  FROM restored_collectives
  WHERE
    l."CollectiveId" = restored_collectives.id
    AND l."deletedAt" >= $restoredAfterDate
  RETURNING l.id
), restored_payment_methods AS (
  UPDATE ONLY "PaymentMethods" pm
  SET "deletedAt" = NULL
  FROM restored_collectives
  WHERE
    pm."CollectiveId" = restored_collectives.id
    AND pm."deletedAt" >= $restoredAfterDate
  RETURNING pm.id
), restored_connected_accounts AS (
  UPDATE ONLY "ConnectedAccounts" ca
  SET "deletedAt" = NULL
  FROM restored_collectives
  WHERE
    ca."CollectiveId" = restored_collectives.id
    AND ca."deletedAt" >= $restoredAfterDate
  RETURNING ca.id
), restored_conversations AS (
  UPDATE ONLY "Conversations" conv
  SET "deletedAt" = NULL
  FROM restored_collectives
  WHERE
    (conv."FromCollectiveId" = restored_collectives.id OR conv."CollectiveId" = restored_collectives.id)
    AND conv."deletedAt" >= $restoredAfterDate
  RETURNING conv.id
), restored_expenses AS (
  UPDATE ONLY "Expenses" e
  SET "deletedAt" = NULL
  WHERE
    e."deletedAt" >= $restoredAfterDate
    AND id IN (
      SELECT id FROM "Expenses" WHERE "CollectiveId"     IN (SELECT id FROM restored_collectives)
      UNION DISTINCT
      SELECT id FROM "Expenses" WHERE "FromCollectiveId" IN (SELECT id FROM restored_collectives)
      UNION DISTINCT
      SELECT id FROM "Expenses" WHERE "UserId"           IN (SELECT id FROM restored_users)
    )
  RETURNING e.id
), restored_expense_items AS (
  UPDATE ONLY "ExpenseItems" ei
  SET "deletedAt" = NULL
  FROM restored_expenses
  WHERE
    ei."ExpenseId" = restored_expenses.id
    AND ei."deletedAt" >= $restoredAfterDate
  RETURNING ei.id
), restored_comments AS (
  UPDATE ONLY "Comments" com
  SET "deletedAt" = NULL
  WHERE
    com."deletedAt" >= $restoredAfterDate
    AND id IN (
      SELECT id FROM "Comments" WHERE "CollectiveId"    IN (SELECT id FROM restored_collectives)
      UNION DISTINCT
      SELECT id FROM "Comments" WHERE "FromCollectiveId" IN (SELECT id FROM restored_collectives)
      UNION DISTINCT
      SELECT id FROM "Comments" WHERE "ConversationId"  IN (SELECT id FROM restored_conversations)
      UNION DISTINCT
      SELECT id FROM "Comments" WHERE "ExpenseId"       IN (SELECT id FROM restored_expenses)
      UNION DISTINCT
      SELECT id FROM "Comments" WHERE "UpdateId"        IN (SELECT id FROM restored_updates)
    )
  RETURNING com.id
), restored_applications AS (
  UPDATE ONLY "Applications" app
  SET "deletedAt" = NULL
  WHERE
    app."deletedAt" >= $restoredAfterDate
    AND id IN (
      SELECT id FROM "Applications" WHERE "CollectiveId"     IN (SELECT id FROM restored_collectives)
      UNION DISTINCT
      SELECT id FROM "Applications" WHERE "CreatedByUserId"  IN (SELECT id FROM restored_users)
    )
  RETURNING app.id
), restored_orders AS (
  UPDATE ONLY "Orders" o
  SET "deletedAt" = NULL
  FROM restored_collectives
  WHERE
    (o."FromCollectiveId" = restored_collectives.id OR o."CollectiveId" = restored_collectives.id)
    AND o."deletedAt" >= $restoredAfterDate
  RETURNING o.id
), restored_recurring_expenses AS (
  UPDATE ONLY "RecurringExpenses" re
  SET "deletedAt" = NULL
  FROM restored_collectives
  WHERE
    (re."FromCollectiveId" = restored_collectives.id OR re."CollectiveId" = restored_collectives.id)
    AND re."deletedAt" >= $restoredAfterDate
  RETURNING re.id
), restored_transactions_imports AS (
  UPDATE ONLY "TransactionsImports" ti
  SET "deletedAt" = NULL
  FROM restored_collectives
  WHERE
    ti."CollectiveId" = restored_collectives.id
    AND ti."deletedAt" >= $restoredAfterDate
  RETURNING ti.id
), restored_transactions_import_rows AS (
  UPDATE ONLY "TransactionsImportsRows" tir
  SET "deletedAt" = NULL
  FROM restored_transactions_imports
  WHERE
    tir."TransactionsImportId" = restored_transactions_imports.id
    AND tir."deletedAt" >= $restoredAfterDate
  RETURNING tir.id
), restored_host_applications AS (
  UPDATE ONLY "HostApplications" ha
  SET "deletedAt" = NULL
  FROM restored_collectives
  WHERE
    (ha."CollectiveId" = restored_collectives.id OR ha."HostCollectiveId" = restored_collectives.id)
    AND ha."deletedAt" >= $restoredAfterDate
  RETURNING ha.id
), restored_payout_methods AS (
  UPDATE ONLY "PayoutMethods" pm
  SET "deletedAt" = NULL
  FROM restored_collectives
  WHERE
    pm."CollectiveId" = restored_collectives.id
    AND pm."deletedAt" >= $restoredAfterDate
  RETURNING pm.id
), restored_virtual_cards AS (
  UPDATE ONLY "VirtualCards" vc
  SET "deletedAt" = NULL
  FROM restored_collectives
  WHERE
    (vc."CollectiveId" = restored_collectives.id OR vc."HostCollectiveId" = restored_collectives.id)
    AND vc."deletedAt" >= $restoredAfterDate
  RETURNING vc.id
), restored_virtual_card_requests AS (
  UPDATE ONLY "VirtualCardRequests" vcr
  SET "deletedAt" = NULL
  FROM restored_collectives
  WHERE
    (vcr."CollectiveId" = restored_collectives.id OR vcr."HostCollectiveId" = restored_collectives.id)
    AND vcr."deletedAt" >= $restoredAfterDate
  RETURNING vcr.id
), restored_platform_subscriptions AS (
  UPDATE ONLY "PlatformSubscriptions" ps
  SET "deletedAt" = NULL
  FROM restored_collectives
  WHERE
    ps."CollectiveId" = restored_collectives.id
    AND ps."deletedAt" >= $restoredAfterDate
  RETURNING ps.id
), restored_personal_tokens AS (
  UPDATE ONLY "PersonalTokens" pt
  SET "deletedAt" = NULL
  WHERE
    pt."deletedAt" >= $restoredAfterDate
    AND (
      EXISTS (SELECT 1 FROM restored_collectives WHERE restored_collectives.id = pt."CollectiveId")
      OR EXISTS (SELECT 1 FROM restored_users WHERE restored_users.id = pt."UserId")
    )
  RETURNING pt.id
), restored_required_legal_documents AS (
  UPDATE ONLY "RequiredLegalDocuments" rld
  SET "deletedAt" = NULL
  FROM restored_collectives
  WHERE
    rld."HostCollectiveId" = restored_collectives.id
    AND rld."deletedAt" >= $restoredAfterDate
  RETURNING rld.id
), restored_export_requests AS (
  UPDATE ONLY "ExportRequests" er
  SET "deletedAt" = NULL
  WHERE
    er."deletedAt" >= $restoredAfterDate
    AND (
      er."CollectiveId" IN (SELECT id FROM restored_collectives)
      OR er."CreatedByUserId" IN (SELECT id FROM restored_users)
    )
  RETURNING er.id
), restored_manual_payment_providers AS (
  UPDATE ONLY "ManualPaymentProviders" mpp
  SET "deletedAt" = NULL
  FROM restored_collectives
  WHERE
    mpp."CollectiveId" = restored_collectives.id
    AND mpp."deletedAt" >= $restoredAfterDate
  RETURNING mpp.id
), restored_kyc_verifications AS (
  UPDATE ONLY "KYCVerifications" kv
  SET "deletedAt" = NULL
  FROM restored_collectives
  WHERE
    (kv."CollectiveId" = restored_collectives.id OR kv."RequestedByCollectiveId" = restored_collectives.id)
    AND kv."deletedAt" >= $restoredAfterDate
  RETURNING kv.id
), restored_subscriptions AS (
  UPDATE ONLY "Subscriptions" s
  SET "deletedAt" = NULL
  WHERE s."deletedAt" >= $restoredAfterDate
  AND s.id IN (
    SELECT o."SubscriptionId" FROM "Orders" o
    WHERE o."SubscriptionId" IS NOT NULL
    AND (o."FromCollectiveId" IN (SELECT id FROM restored_collectives) OR o."CollectiveId" IN (SELECT id FROM restored_collectives))
  )
  RETURNING s.id
), restored_uploaded_files AS (
  UPDATE ONLY "UploadedFiles" uf
  SET "deletedAt" = NULL
  FROM restored_users
  WHERE
    uf."CreatedByUserId" = restored_users.id
    AND uf."deletedAt" >= $restoredAfterDate
  RETURNING uf.id
)
SELECT
  (SELECT COUNT(*) FROM restored_collectives)              AS nb_restored_collectives,
  (SELECT COUNT(*) FROM restored_users)                    AS nb_restored_users,
  (SELECT COUNT(*) FROM restored_oauth_authorization_codes) AS nb_restored_oauth_authorization_codes,
  (SELECT COUNT(*) FROM restored_user_tokens)              AS nb_restored_user_tokens,
  (SELECT COUNT(*) FROM restored_two_factor_methods)       AS nb_restored_two_factor_methods,
  (SELECT COUNT(*) FROM restored_transactions)             AS nb_restored_transactions,
  (SELECT COUNT(*) FROM restored_transaction_settlements)  AS nb_restored_transaction_settlements,
  (SELECT COUNT(*) FROM restored_tiers)                    AS nb_restored_tiers,
  (SELECT COUNT(*) FROM restored_members)                  AS nb_restored_members,
  (SELECT COUNT(*) FROM restored_member_invitations)       AS nb_restored_member_invitations,
  (SELECT COUNT(*) FROM restored_updates)                  AS nb_restored_updates,
  (SELECT COUNT(*) FROM restored_payment_methods)          AS nb_restored_payment_methods,
  (SELECT COUNT(*) FROM restored_connected_accounts)       AS nb_restored_connected_accounts,
  (SELECT COUNT(*) FROM restored_conversations)            AS nb_restored_conversations,
  (SELECT COUNT(*) FROM restored_comments)                 AS nb_restored_comments,
  (SELECT COUNT(*) FROM restored_expenses)                 AS nb_restored_expenses,
  (SELECT COUNT(*) FROM restored_expense_items)            AS nb_restored_expense_items,
  (SELECT COUNT(*) FROM restored_applications)             AS nb_restored_applications,
  (SELECT COUNT(*) FROM restored_orders)                   AS nb_restored_orders,
  (SELECT COUNT(*) FROM restored_recurring_expenses)       AS nb_restored_recurring_expenses,
  (SELECT COUNT(*) FROM restored_transactions_imports)     AS nb_restored_transactions_imports,
  (SELECT COUNT(*) FROM restored_transactions_import_rows) AS nb_restored_transactions_import_rows,
  (SELECT COUNT(*) FROM restored_host_applications)        AS nb_restored_host_applications,
  (SELECT COUNT(*) FROM restored_payout_methods)           AS nb_restored_payout_methods,
  (SELECT COUNT(*) FROM restored_virtual_cards)            AS nb_restored_virtual_cards,
  (SELECT COUNT(*) FROM restored_virtual_card_requests)    AS nb_restored_virtual_card_requests,
  (SELECT COUNT(*) FROM restored_platform_subscriptions)   AS nb_restored_platform_subscriptions,
  (SELECT COUNT(*) FROM restored_personal_tokens)          AS nb_restored_personal_tokens,
  (SELECT COUNT(*) FROM restored_required_legal_documents) AS nb_restored_required_legal_documents,
  (SELECT COUNT(*) FROM restored_legal_documents)          AS nb_restored_legal_documents,
  (SELECT COUNT(*) FROM restored_agreements)               AS nb_restored_agreements,
  (SELECT COUNT(*) FROM restored_locations)                AS nb_restored_locations,
  (SELECT COUNT(*) FROM restored_export_requests)        AS nb_restored_export_requests,
  (SELECT COUNT(*) FROM restored_manual_payment_providers) AS nb_restored_manual_payment_providers,
  (SELECT COUNT(*) FROM restored_kyc_verifications)        AS nb_restored_kyc_verifications,
  (SELECT COUNT(*) FROM restored_subscriptions)           AS nb_restored_subscriptions,
  (SELECT COUNT(*) FROM restored_uploaded_files)           AS nb_restored_uploaded_files,
  (SELECT ARRAY_AGG(id) FROM restored_collectives)         AS restored_collectives_ids;