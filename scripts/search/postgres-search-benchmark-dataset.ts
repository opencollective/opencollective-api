/* eslint-disable no-console */
/**
 * Synthetic, production-shaped dataset for the PostgreSQL search benchmark (opencollective#8944).
 * See `docs/postgres-search.md` for how to run it and the recorded results.
 *
 * Usage (on a disposable database that has the real schema: base dump + migrations):
 *   npm run script scripts/search/postgres-search-benchmark-dataset.ts -- --url postgres://...  [--scale 0.01]
 *
 * Rows are added to the real tables (Collectives, Transactions, Orders, Subscriptions, Expenses, ExpenseItems, Updates,
 * Conversations, Comments, Tiers, HostApplications) after the existing ones. Non-unique indexes of each table are dropped
 * during the load and rebuilt after it (same definitions), then every table is vacuumed and analyzed. Foreign key
 * triggers are skipped during the load (`session_replication_role = replica`, superuser only) but the generated
 * references are consistent. Generation is deterministic (hash-based, no random()), so two runs at the same scale on
 * the same base produce the same rows.
 *
 * Shape (scale 1): 1.15M Accounts (~1.06M undeleted; 3000 hosts with a skewed number of hosted accounts, the largest
 * one ~25k), ~13M Transactions in double-entry groups with templated descriptions, 4M Orders, 640k Subscriptions,
 * 1M Expenses with 2M items, 100k Updates, 30k Conversations, 1.5M Comments, 300k Tiers, 150k Host Applications.
 * Words come from a 30k pseudo-word vocabulary plus ~100 common words picked a third of the time (Zipf-like).
 * Only Accounts and Transactions sizes come from production numbers; the others are assumptions (see the doc).
 */

import { Command } from 'commander';
import { Client } from 'pg';

type Sizes = Record<
  | 'accounts'
  | 'transactionGroups'
  | 'orders'
  | 'subscriptions'
  | 'expenses'
  | 'updates'
  | 'conversations'
  | 'comments'
  | 'tiers'
  | 'hostApplications'
  | 'hosts',
  number
>;

const BASE_SIZES: Sizes = {
  accounts: 1_150_000,
  transactionGroups: 3_300_000, // ~4 rows per group (double entry, fees) => ~13M rows
  orders: 4_000_000,
  subscriptions: 640_000,
  expenses: 1_000_000, // + 1-3 items each
  updates: 100_000,
  conversations: 30_000,
  comments: 1_500_000,
  tiers: 300_000,
  hostApplications: 150_000,
  hosts: 3000,
};

const TABLES = [
  'Collectives',
  'Transactions',
  'Orders',
  'Subscriptions',
  'Expenses',
  'ExpenseItems',
  'Updates',
  'Conversations',
  'Comments',
  'Tiers',
  'HostApplications',
];

const COMMON_WORDS = [
  'open',
  'source',
  'collective',
  'foundation',
  'community',
  'music',
  'art',
  'school',
  'club',
  'project',
  'fund',
  'network',
  'green',
  'city',
  'youth',
  'tech',
  'coop',
  'garden',
  'food',
  'health',
  'climate',
  'water',
  'book',
  'sport',
  'dance',
  'film',
  'labs',
  'react',
  'python',
  'rust',
  'javascript',
  'women',
  'code',
  'hackers',
  'alliance',
  'society',
  'union',
  'crème',
  'café',
  'zoë',
  'brûlée',
  'association',
  'initiative',
  'friends',
  'group',
  'team',
  'festival',
  'theatre',
  'radio',
  'studio',
  'the',
  'of',
  'and',
  'for',
  'new',
  'york',
  'paris',
  'berlin',
  'london',
  'free',
  'software',
  'web',
  'data',
  'science',
  'research',
  'education',
  'kids',
  'animal',
  'rescue',
  'mutual',
  'aid',
  'local',
  'global',
  'digital',
  'rights',
  'house',
  'home',
  'center',
  'library',
  'press',
  'media',
  'games',
  'design',
  'vue',
  'webpack',
  'babel',
  'node',
  'linux',
  'docs',
  'api',
  'cloud',
  'ocean',
  'forest',
  'bike',
  'farm',
  'market',
  'church',
  'support',
  'fondation',
  'société',
  'asociación',
  'niño',
  'münchen',
  'straße',
];

const EXPENSE_WORDS = [
  'travel',
  'invoice',
  'hosting',
  'hotel',
  'flight',
  'food',
  'meetup',
  'stickers',
  'design',
  'development',
  'domain',
  'server',
  'conference',
  'reimbursement',
  'printing',
  'shipping',
  'equipment',
  'software',
  'license',
  'translation',
  'workshop',
  'venue',
  'catering',
  'marketing',
  'consulting',
];

const lit = (values: string[]) => `ARRAY[${values.map(v => `'${v.replace(/'/g, "''")}'`).join(',')}]`;

/** Returns the SQL steps for the given sizes and ID offsets (only numbers are interpolated) */
const getSteps = (
  s: Sizes,
  start: Record<string, number>,
  platformId: number,
  targetCount: number,
): Array<[string, string]> => {
  const A = start['Collectives'];
  const HOST_STRIDE = Math.floor(s.accounts / s.hosts); // accounts i = h * stride + 7 are hosts
  const PARENT_STRIDE = 50; // accounts i = p * 50 + 11 are collectives that can have children
  const parents = Math.floor(s.accounts / PARENT_STRIDE);
  // Account type and host of account number i (1-based offset from A)
  const fn = `
    CREATE SCHEMA IF NOT EXISTS search_bench;
    DROP TABLE IF EXISTS search_bench.vocab;
    CREATE TABLE search_bench.vocab AS
      WITH syl AS (SELECT unnest(ARRAY['ba','be','bi','bo','bu','ka','ke','ki','ko','ku','la','le','li','lo','lu','ma','me','mi','mo','mu','na','ne','ni','no','nu','ra','re','ri','ro','ru','sa','se','si','so','su','ta','te','ti','to','tu','vi','zo','an','en','in','on','ar','er','or','el','al','ste','tri','gra','pla','cha','sho','tha','lin','ber','ton','son','ley','ford','well','field','wood','dal','berg','ski','ova','ez','ini']) s),
      s2 AS (SELECT s, row_number() OVER () n FROM syl)
      SELECT row_number() OVER (ORDER BY md5(a.s || b.s || coalesce(c.s, ''))) id, a.s || b.s || coalesce(c.s, '') w
      FROM s2 a CROSS JOIN s2 b LEFT JOIN s2 c ON (hashint4(a.n::int * 1000 + b.n::int * 31 + c.n::int) % 8 = 0)
      LIMIT 30000;
    INSERT INTO search_bench.vocab SELECT 30000 + row_number() OVER (), w FROM unnest(${lit(COMMON_WORDS)}) w;
    INSERT INTO search_bench.vocab SELECT 40000 + row_number() OVER (), w FROM unnest(${lit(EXPENSE_WORDS)}) w;
    CREATE UNIQUE INDEX ON search_bench.vocab (id);
    ANALYZE search_bench.vocab;
    -- Zipf-like word picker: a third of the picks are common words
    CREATE OR REPLACE FUNCTION search_bench.pick(seed int) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
      SELECT w FROM search_bench.vocab WHERE id = CASE WHEN abs(hashint4(seed)) % 3 = 0 THEN 30001 + abs(hashint4(seed + 7)) % ${COMMON_WORDS.length}
        ELSE 1 + abs(hashint4(seed + 13)) % 30000 END $$;
    -- Expense vocabulary: half the picks are common expense words
    CREATE OR REPLACE FUNCTION search_bench.epick(seed int) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
      SELECT CASE WHEN abs(hashint4(seed)) % 2 = 0 THEN (SELECT w FROM search_bench.vocab WHERE id = 40001 + abs(hashint4(seed + 3)) % ${EXPENSE_WORDS.length})
        ELSE search_bench.pick(seed) END $$;
    CREATE OR REPLACE FUNCTION search_bench.acc_type(i int) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
      SELECT CASE
        WHEN i % ${HOST_STRIDE} = 7 AND i / ${HOST_STRIDE} < ${s.hosts} THEN 'ORGANIZATION'
        WHEN i % ${PARENT_STRIDE} = 11 THEN 'COLLECTIVE'
        WHEN abs(hashint4(i)) % 100 < 62 THEN 'USER' WHEN abs(hashint4(i)) % 100 < 78 THEN 'ORGANIZATION'
        WHEN abs(hashint4(i)) % 100 < 92 THEN 'COLLECTIVE' WHEN abs(hashint4(i)) % 100 < 95 THEN 'PROJECT'
        WHEN abs(hashint4(i)) % 100 < 98 THEN 'EVENT' ELSE 'FUND' END $$;
    CREATE OR REPLACE FUNCTION search_bench.is_host(i int) RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
      SELECT i % ${HOST_STRIDE} = 7 AND i / ${HOST_STRIDE} < ${s.hosts} $$;
    -- Skewed host popularity: the first hosts get most hosted accounts (largest ~10% of them)
    CREATE OR REPLACE FUNCTION search_bench.host_of(i int) RETURNS int LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
      SELECT ${A} + floor(${s.hosts} * power((abs(hashint4(i + 101)) % 1000000) / 1000000.0, 3.5))::int * ${HOST_STRIDE} + 7 $$;
    CREATE OR REPLACE FUNCTION search_bench.parent_of(i int) RETURNS int LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
      SELECT (abs(hashint4(i + 9)) % ${parents}) * ${PARENT_STRIDE} + 11 $$;
  `;

  const accounts = `
    INSERT INTO "Collectives" (id, name, slug, "legalName", description, "longDescription", website, tags, type, "isActive",
      "HostCollectiveId", "ParentCollectiveId", "deletedAt", "deactivatedAt", "isIncognito", "isPrivate", "hasMoneyManagement",
      "isHostAccount", "hasHosting", "approvedAt", data, settings, image, "publicId", currency, "createdAt", "updatedAt")
    SELECT ${A} + i, nm,
      regexp_replace(lower(search_bench.pick(i * 3)), '[^a-z0-9]+', '-', 'g') || '-' || (${A} + i),
      CASE WHEN k % 10 = 0 THEN initcap(search_bench.pick(i * 11)) || ' ' || initcap(search_bench.pick(i * 13)) || ' LLC' END,
      CASE WHEN typ <> 'USER' OR k % 3 = 0 THEN 'We are a ' || search_bench.pick(i * 17) || ' ' || search_bench.pick(i * 19) || ' group supporting ' || search_bench.pick(i * 23) END,
      CASE WHEN k % 5 = 0 THEN '<p>' || search_bench.pick(i * 29) || ' <b>' || search_bench.pick(i * 31) || '</b> ' || repeat(search_bench.pick(i * 37) || ' ' || search_bench.pick(i * 41) || ' &amp; ' || search_bench.pick(i * 43) || '. ', 1 + k % 40) || '</p>' END,
      CASE WHEN k % 4 = 0 THEN 'https://' || search_bench.pick(i * 47) || '.org' END,
      CASE WHEN typ <> 'USER' AND k % 2 = 0 THEN ARRAY[search_bench.pick(30001 + k % 50), search_bench.pick(30003 + k % 40)]::varchar[] END,
      typ,
      host OR (typ IN ('COLLECTIVE', 'FUND', 'PROJECT', 'EVENT') AND k % 20 <> 0),
      CASE WHEN host THEN ${A} + i
           WHEN typ IN ('PROJECT', 'EVENT') THEN search_bench.host_of(search_bench.parent_of(i))
           WHEN typ IN ('COLLECTIVE', 'FUND') THEN search_bench.host_of(i) END,
      CASE WHEN typ IN ('PROJECT', 'EVENT') THEN ${A} + search_bench.parent_of(i) END,
      CASE WHEN NOT host AND k % 12 = 0 THEN now() - (k % 1000) * interval '1 day' END,
      CASE WHEN NOT host AND k % 97 = 0 THEN now() END,
      NOT host AND k % 31 = 0,
      NOT host AND k % 53 = 0,
      host, host, host, CASE WHEN typ IN ('COLLECTIVE', 'FUND', 'PROJECT', 'EVENT') THEN now() END,
      jsonb_build_object('isGuest', typ = 'USER' AND k % 3 = 1, 'hideFromSearch', NOT host AND k % 211 = 0, 'features', jsonb_build_object('a', k), 'pad', repeat('x', k % 200)),
      jsonb_build_object('lang', 'en', 'pad', repeat('y', k % 300)),
      'https://images.opencollective.com/' || md5(i::text) || '/logo.png',
      'acc_bench' || (${A} + i), 'USD',
      now() - (i || ' minutes')::interval, now()
    FROM (
      SELECT i, abs(hashint4(i + 7919)) k, search_bench.acc_type(i) typ, search_bench.is_host(i) host,
        CASE WHEN search_bench.is_host(i) THEN initcap(search_bench.pick(i * 3)) || ' Host ' || i
             WHEN search_bench.acc_type(i) = 'USER' THEN initcap(search_bench.pick(i * 3)) || ' ' || initcap(search_bench.pick(i * 5))
             ELSE initcap(search_bench.pick(i * 3)) || ' ' || initcap(search_bench.pick(i * 5)) || CASE WHEN i % 3 = 0 THEN ' ' || initcap(search_bench.pick(i * 7)) ELSE '' END END nm
      FROM generate_series(1, ${s.accounts}) i
    ) g;
    UPDATE "Collectives" SET name = 'incognito' WHERE id > ${A} AND (id - ${A}) % 401 = 0 AND NOT "hasMoneyManagement";
  `;

  // Accounts that receive contributions/expenses, ordered by a hash: popularity follows a Zipf-like curve over `n`
  const targets = `
    DROP TABLE IF EXISTS search_bench.targets;
    CREATE TABLE search_bench.targets AS
      SELECT row_number() OVER (ORDER BY hashint4(c.id + 41)) n, c.id, c.name, c."HostCollectiveId" host
      FROM "Collectives" c WHERE c.id > ${A} AND c.type IN ('COLLECTIVE', 'FUND', 'PROJECT', 'EVENT') AND c."isActive";
    CREATE UNIQUE INDEX ON search_bench.targets (n);
    ANALYZE search_bench.targets;
  `;

  // Zipf-like pick among the receiving accounts (the count is a constant: a subquery here would run for every row)
  const targetPicker = `
    CREATE OR REPLACE FUNCTION search_bench.target_n(seed int) RETURNS int LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
      SELECT 1 + floor(${targetCount} * power((abs(hashint4(seed + 17)) % 1000000) / 1000000.0, 2.2))::int $$;
  `;

  const T = start['Transactions'];
  const O = start['Orders'];
  const SUB = start['Subscriptions'];
  const E = start['Expenses'];
  const transactions = `
    INSERT INTO "Transactions" (type, description, amount, currency, "createdAt", "updatedAt", "CollectiveId", "CreatedByUserId",
      "deletedAt", data, "OrderId", "hostCurrency", "hostCurrencyFxRate", "amountInHostCurrency", "netAmountInCollectiveCurrency",
      "ExpenseId", uuid, "FromCollectiveId", "HostCollectiveId", "TransactionGroup", "isRefund", kind, "isDebt", "clearedAt", "publicId",
      "platformFeeInHostCurrency", "hostFeeInHostCurrency", "paymentProcessorFeeInHostCurrency", "taxAmount")
    SELECT tt.type,
      CASE k.kind
        WHEN 'CONTRIBUTION' THEN CASE WHEN g.refund THEN 'Refund of "' ELSE '' END || g.contribution_label || CASE WHEN g.refund THEN '"' ELSE '' END
        WHEN 'HOST_FEE' THEN 'Host Fee'
        WHEN 'PLATFORM_TIP' THEN 'Platform Tip'
        WHEN 'PAYMENT_PROCESSOR_FEE' THEN CASE WHEN g.provider < 6 THEN 'Stripe payment processor fee' ELSE 'PayPal payment processor fee' END
        WHEN 'EXPENSE' THEN g.expense_label
        WHEN 'ADDED_FUNDS' THEN 'Added funds - ' || search_bench.pick(g.g * 23)
        ELSE 'Balance transfer to ' || g.target_name
      END,
      CASE WHEN tt.type = 'CREDIT' THEN g.amount ELSE -g.amount END, 'USD', g.created, g.created,
      CASE
        WHEN k.kind IN ('CONTRIBUTION', 'ADDED_FUNDS', 'BALANCE_TRANSFER') THEN CASE WHEN tt.type = 'CREDIT' THEN g.target ELSE g.contributor END
        WHEN k.kind = 'EXPENSE' THEN CASE WHEN tt.type = 'DEBIT' THEN g.target ELSE g.contributor END
        WHEN k.kind = 'HOST_FEE' THEN CASE WHEN tt.type = 'CREDIT' THEN coalesce(g.host, g.target) ELSE g.target END
        WHEN k.kind = 'PLATFORM_TIP' THEN CASE WHEN tt.type = 'CREDIT' THEN ${platformId} ELSE g.contributor END
        ELSE CASE WHEN tt.type = 'CREDIT' THEN coalesce(g.host, g.target) ELSE g.target END
      END,
      1 + abs(hashint4(g.g + 3)) % 900000,
      CASE WHEN g.g % 100 = 0 THEN now() END,
      CASE
        WHEN k.kind = 'CONTRIBUTION' AND g.provider < 6 THEN jsonb_build_object(
          'charge', jsonb_build_object('id', 'ch_' || substr(md5('ch' || g.g), 1, 24), 'amount', g.amount, 'currency', 'usd',
                                       'application_fee', CASE WHEN g.g % 2 = 0 THEN 'fee_' || substr(md5('fee' || g.g), 1, 24) END),
          'refund', CASE WHEN g.refund THEN jsonb_build_object('id', 're_' || substr(md5('re' || g.g), 1, 24)) END,
          'balanceTransaction', jsonb_build_object('id', 'txn_' || md5('bt' || g.g), 'fee', g.amount / 30, 'net', g.amount - g.amount / 30,
                                                    'description', 'Payment for ' || g.contribution_label, 'status', 'available'),
          'isPlatformRevenueDirectlyCollected', g.g % 4 = 0)
        WHEN k.kind = 'CONTRIBUTION' AND g.provider < 8 THEN jsonb_build_object(
          'paypalCaptureId', upper(substr(md5('pp' || g.g), 1, 17)),
          'paypalRefundId', CASE WHEN g.refund THEN upper(substr(md5('pr' || g.g), 1, 17)) END,
          'capture', jsonb_build_object('status', 'COMPLETED', 'amount', jsonb_build_object('value', g.amount / 100.0, 'currency_code', 'USD')))
        WHEN k.kind = 'EXPENSE' AND g.provider < 5 THEN jsonb_build_object(
          'transfer', jsonb_build_object('id', 50000000 + g.g, 'status', 'outgoing_payment_sent', 'reference', 'Expense ' || g.g),
          'quote', jsonb_build_object('id', md5('q' || g.g), 'fee', 123, 'rate', 1.1))
        WHEN k.kind = 'EXPENSE' AND g.provider < 7 THEN jsonb_build_object('transaction_id', upper(substr(md5('po' || g.g), 1, 17)), 'payout_batch_id', upper(substr(md5('pb' || g.g), 1, 13)))
        WHEN k.kind = 'EXPENSE' AND g.provider < 8 THEN jsonb_build_object('token', md5('privacy' || g.g))
        WHEN k.kind IN ('HOST_FEE', 'PAYMENT_PROCESSOR_FEE') THEN jsonb_build_object('hostFeePercent', 5, 'settled', true)
        ELSE '{}'::jsonb
      END,
      CASE WHEN g.cat < 70 THEN ${O} + abs(hashint4(g.g + 8)) % ${s.orders} END,
      'USD', 1, CASE WHEN tt.type = 'CREDIT' THEN g.amount ELSE -g.amount END, CASE WHEN tt.type = 'CREDIT' THEN g.amount ELSE -g.amount END,
      CASE WHEN k.kind = 'EXPENSE' THEN ${E} + abs(hashint4(g.g + 9)) % ${s.expenses} END,
      md5('uuid' || g.g || k.kind || tt.type || ${T})::uuid,
      CASE
        WHEN k.kind IN ('CONTRIBUTION', 'ADDED_FUNDS', 'BALANCE_TRANSFER') THEN CASE WHEN tt.type = 'CREDIT' THEN g.contributor ELSE g.target END
        WHEN k.kind = 'EXPENSE' THEN CASE WHEN tt.type = 'DEBIT' THEN g.contributor ELSE g.target END
        WHEN k.kind = 'HOST_FEE' THEN CASE WHEN tt.type = 'CREDIT' THEN g.target ELSE coalesce(g.host, g.target) END
        WHEN k.kind = 'PLATFORM_TIP' THEN CASE WHEN tt.type = 'CREDIT' THEN g.contributor ELSE ${platformId} END
        ELSE CASE WHEN tt.type = 'CREDIT' THEN g.target ELSE coalesce(g.host, g.target) END
      END,
      CASE
        WHEN k.kind = 'PLATFORM_TIP' THEN CASE WHEN tt.type = 'CREDIT' THEN ${platformId} END
        WHEN k.kind IN ('CONTRIBUTION', 'ADDED_FUNDS', 'BALANCE_TRANSFER') THEN CASE WHEN tt.type = 'CREDIT' THEN g.host END
        WHEN k.kind = 'EXPENSE' THEN CASE WHEN tt.type = 'DEBIT' THEN g.host END
        ELSE g.host
      END,
      md5('group' || g.g || '-' || ${T})::uuid,
      g.refund, k.kind::"enum_Transactions_kind", false, g.created,
      'tx_bench' || g.g || lower(left(k.kind, 3)) || left(tt.type, 1),
      0, CASE WHEN k.kind = 'CONTRIBUTION' THEN -g.amount / 20 ELSE 0 END, 0, 0
    FROM (
      SELECT s.g, s.cat, s.provider, s.refund, s.amount, s.created, t.id target, t.name target_name, t.host,
        ${A} + 1 + abs(hashint4(s.g + 5)) % ${s.accounts} contributor,
        CASE
          WHEN s.k < 50 THEN 'Financial contribution to ' || t.name
          WHEN s.k < 75 THEN 'Monthly financial contribution to ' || t.name
          WHEN s.k < 80 THEN 'Yearly financial contribution to ' || t.name
          WHEN s.k < 92 THEN (ARRAY['Backer','Sponsor','Gold Sponsor','Silver Sponsor','Donation','Supporter','Member','Ticket'])[1 + s.g % 8] || CASE WHEN s.g % 2 = 0 THEN ' - ' || t.name ELSE '' END
          WHEN s.k < 95 THEN 'Registration (' || t.name || ')'
          ELSE 'Thanks ' || search_bench.pick(s.g * 3) || ' ' || search_bench.pick(s.g * 5) || ' ' || search_bench.pick(s.g * 7)
        END contribution_label,
        CASE s.g % 4
          WHEN 0 THEN 'Invoice ' || search_bench.epick(s.g * 11) || ' ' || search_bench.pick(s.g * 13)
          WHEN 1 THEN 'Reimbursement for ' || search_bench.epick(s.g * 11) || ' ' || search_bench.pick(s.g * 17)
          WHEN 2 THEN search_bench.epick(s.g * 19) || ' ' || search_bench.pick(s.g * 13) || ' expenses'
          ELSE 'Payment of ' || search_bench.epick(s.g * 29) || ' ' || search_bench.pick(s.g * 31) || ' ' || search_bench.pick(s.g * 37)
        END expense_label
      FROM (
        SELECT g, abs(hashint4(g)) % 100 cat, abs(hashint4(g + 1)) % 10 provider, abs(hashint4(g + 2)) % 100 < 2 refund,
          500 + abs(hashint4(g + 4)) % 100000 amount, now() - (g % 3000) * interval '1 day' - (g % 86400) * interval '1 second' created,
          abs(hashint4(g + 6)) % 100 k
        FROM generate_series(1, ${s.transactionGroups}) g
      ) s JOIN search_bench.targets t ON t.n = search_bench.target_n(s.g)
    ) g
    CROSS JOIN LATERAL (
      SELECT unnest(CASE
        WHEN g.cat < 70 THEN ARRAY['CONTRIBUTION']
          || CASE WHEN g.g % 2 = 0 THEN ARRAY['HOST_FEE'] ELSE '{}'::text[] END
          || CASE WHEN g.g % 10 < 3 THEN ARRAY['PLATFORM_TIP'] ELSE '{}'::text[] END
          || CASE WHEN g.provider < 4 THEN ARRAY['PAYMENT_PROCESSOR_FEE'] ELSE '{}'::text[] END
        WHEN g.cat < 88 THEN ARRAY['EXPENSE'] || CASE WHEN g.g % 2 = 0 THEN ARRAY['PAYMENT_PROCESSOR_FEE'] ELSE '{}'::text[] END
        WHEN g.cat < 95 THEN ARRAY['ADDED_FUNDS'] || CASE WHEN g.g % 2 = 0 THEN ARRAY['HOST_FEE'] ELSE '{}'::text[] END
        ELSE ARRAY['BALANCE_TRANSFER']
      END) kind
    ) k
    CROSS JOIN (VALUES ('CREDIT'), ('DEBIT')) tt(type);
  `;

  const subscriptions = `
    INSERT INTO "Subscriptions" (id, amount, "interval", "isActive", "paypalSubscriptionId", "isManagedExternally", "deletedAt",
      "createdAt", "updatedAt", "nextChargeDate", quantity, "chargeNumber", currency)
    SELECT ${SUB} + i, 500 + i % 10000, CASE WHEN i % 5 = 0 THEN 'year' ELSE 'month' END, i % 3 <> 0,
      CASE WHEN i % 10 < 3 THEN 'I-' || upper(substr(md5('sub' || i || '-' || ${SUB}), 1, 12)) END,
      i % 10 < 3, CASE WHEN i % 50 = 0 THEN now() END, now(), now(), now(), 1, i % 40, 'USD'
    FROM generate_series(0, ${s.subscriptions - 1}) i;
  `;

  const TIER = start['Tiers'];
  const orders = `
    INSERT INTO "Orders" (id, "CreatedByUserId", "CollectiveId", "totalAmount", description, "SubscriptionId", "createdAt", "updatedAt",
      "deletedAt", "PaymentMethodId", "processedAt", "TierId", "FromCollectiveId", "publicMessage", quantity, status, data, "interval",
      "platformTipAmount", "platformTipEligible", "publicId", currency)
    SELECT ${O} + i, 1 + abs(hashint4(i + 1)) % 900000, t.id, 500 + abs(hashint4(i + 2)) % 100000,
      CASE
        WHEN k < 55 THEN 'Financial contribution to ' || t.name
        WHEN k < 75 THEN 'Monthly financial contribution to ' || t.name
        WHEN k < 80 THEN 'Yearly financial contribution to ' || t.name
        WHEN k < 92 THEN (ARRAY['Backer','Sponsor','Gold Sponsor','Silver Sponsor','Donation','Supporter','Member','Ticket'])[1 + i % 8] || CASE WHEN i % 2 = 0 THEN ' - ' || t.name ELSE '' END
        WHEN k < 95 THEN 'Registration (' || t.name || ')'
        ELSE 'Thanks ' || search_bench.pick(i * 3) || ' ' || search_bench.pick(i * 5) || ' ' || search_bench.pick(i * 7)
      END,
      CASE WHEN k >= 55 AND k < 80 THEN ${SUB} + abs(hashint4(i + 3)) % ${s.subscriptions} END,
      now() - (i % 3000) * interval '1 day', now(), CASE WHEN i % 33 = 0 THEN now() END,
      1 + abs(hashint4(i + 4)) % 2000000, now(), CASE WHEN k >= 80 AND k < 92 THEN ${TIER} + i % ${s.tiers} END,
      ${A} + 1 + abs(hashint4(i + 5)) % ${s.accounts}, CASE WHEN i % 20 = 0 THEN 'Keep up the ' || search_bench.pick(i * 11) END, 1,
      (ARRAY['PAID','ACTIVE','CANCELLED','ERROR','PENDING','EXPIRED'])[1 + i % 6],
      jsonb_build_object('fromAccountInfo', jsonb_build_object('name', search_bench.pick(i * 13) || ' ' || search_bench.pick(i * 17), 'email', 'u' || i || '@example.com'),
        'platformTip', i % 500, 'paymentIntent', jsonb_build_object('id', 'pi_' || md5(i::text))),
      CASE WHEN k >= 55 AND k < 75 THEN 'month' WHEN k >= 75 AND k < 80 THEN 'year' END, i % 500, true,
      'or_bench' || (${O} + i), 'USD'
    FROM (SELECT i, abs(hashint4(i)) % 100 k FROM generate_series(0, ${s.orders - 1}) i) s
    JOIN search_bench.targets t ON t.n = search_bench.target_n(s.i + 1000000);
  `;

  const expenses = `
    INSERT INTO "Expenses" (id, "UserId", "CollectiveId", currency, amount, description, "privateMessage", status, "incurredAt", "createdAt",
      "updatedAt", "deletedAt", "legacyPayoutMethod", "FromCollectiveId", "invoiceInfo", "payeeLocation", data, "longDescription",
      "HostCollectiveId", reference, "publicId", type, "paidAt")
    SELECT ${E} + i, 1 + i % 500000, t.id,
      CASE WHEN k % 10 < 6 THEN 'USD' WHEN k % 10 < 8 THEN 'EUR' WHEN k % 10 < 9 THEN 'GBP' ELSE (ARRAY['CAD','AUD','INR','JPY','MXN'])[1 + k % 5] END,
      100 + k % 1000000,
      initcap(search_bench.epick(i * 3)) || ' ' || search_bench.epick(i * 5) || CASE WHEN k % 3 = 0 THEN ' ' || search_bench.epick(i * 7) ELSE '' END
        || CASE WHEN k % 4 = 0 THEN ' ' || to_char(date '2020-01-01' + (k % 2000), 'Mon YYYY') ELSE '' END,
      CASE WHEN k % 5 = 0 THEN '<p>Hi, ' || search_bench.pick(i * 11) || ' ' || search_bench.pick(i * 13) || ' <b>' || search_bench.pick(i * 17) || '</b></p>' END,
      (ARRAY['PAID','PAID','PAID','PAID','PAID','PAID','REJECTED','PENDING','APPROVED','SPAM','DRAFT','CANCELED','PROCESSING','ERROR','SCHEDULED_FOR_PAYMENT','UNVERIFIED'])[1 + k % 16],
      now() - (i % 2000) * interval '1 day', now() - (i % 2000) * interval '1 day', now(),
      CASE WHEN k % 33 = 0 THEN now() END, 'other',
      ${A} + 1 + abs(hashint4(i * 11)) % ${s.accounts},
      CASE WHEN k % 3 = 0 THEN initcap(search_bench.pick(i * 19)) || ' ' || initcap(search_bench.pick(i * 23)) || E'\\n' || (k % 999) || ' ' || initcap(search_bench.pick(i * 29)) || E' Street\\nVAT ' || k % 99999 END,
      jsonb_build_object('address', 'x', 'country', 'US'),
      jsonb_build_object('pad', repeat('d', k % 300)),
      CASE WHEN k % 10 = 0 THEN '<div>' || repeat(search_bench.pick(i * 31) || ' ' || search_bench.epick(i * 37) || ' ', 1 + k % 20) || '</div>' END,
      CASE WHEN k % 10 = 0 THEN NULL ELSE t.host END,
      CASE WHEN k % 7 = 0 THEN 'INV-' || (k % 1000000) END,
      'ex_bench' || (${E} + i), CASE WHEN k % 3 = 0 THEN 'INVOICE' ELSE 'RECEIPT' END::"enum_Expenses_type",
      CASE WHEN k % 16 < 6 THEN now() - (i % 2000) * interval '1 day' END
    FROM (SELECT i, abs(hashint4(i + 104729)) k FROM generate_series(0, ${s.expenses - 1}) i) g
    JOIN search_bench.targets t ON t.n = search_bench.target_n(g.i + 2000000);
    INSERT INTO "ExpenseItems" (amount, url, description, "createdAt", "updatedAt", "deletedAt", "incurredAt", "ExpenseId", "order", "publicId", currency)
    SELECT 100 + k % 100000,
      CASE WHEN k % 2 = 0 THEN 'https://opencollective-production.s3.amazonaws.com/' || md5((e.id * 10 + j)::text) || '.pdf' END,
      CASE WHEN k % 9 = 0 THEN NULL ELSE initcap(search_bench.epick(e.id * 41 + j)) || ' ' || search_bench.epick(e.id * 43 + j) || CASE WHEN k % 2 = 0 THEN ' ' || search_bench.pick(e.id * 47 + j) ELSE '' END END,
      now(), now(), CASE WHEN k % 29 = 0 THEN now() END, now(), e.id, j, 'ei_bench' || (e.id * 10 + j), 'USD'
    FROM "Expenses" e
    CROSS JOIN LATERAL generate_series(1, 1 + abs(hashint4(e.id * 13)) % 3) j
    CROSS JOIN LATERAL (SELECT abs(hashint4(e.id * 17 + j)) k) kk
    WHERE e.id >= ${E};
  `;

  const U = start['Updates'];
  const updates = `
    INSERT INTO "Updates" (id, "publicId", slug, "CollectiveId", "FromCollectiveId", "CreatedByUserId", title, html, "isPrivate", "publishedAt",
      "deletedAt", summary, "createdAt", "updatedAt", "isChangelog", "notificationAudience")
    SELECT ${U} + i, 'upd_bench' || (${U} + i),
      regexp_replace(lower(t), '[^a-z0-9]+', '-', 'g') || '-' || (${U} + i),
      tg.id, tg.id, 1 + k % 100000, t,
      '<div><p>' || (SELECT string_agg(CASE WHEN j % 25 = 0 THEN '</p><p><strong>' || search_bench.pick(i * 1000 + j) || '</strong>'
                                            WHEN j % 40 = 0 THEN '&nbsp;' || search_bench.pick(i * 1000 + j) ELSE search_bench.pick(i * 1000 + j) END, ' ')
                     FROM generate_series(1, 20 + k % 280) j) || '</p></div>',
      k % 20 = 0, CASE WHEN k % 20 = 1 THEN NULL ELSE now() - (i || ' minutes')::interval END,
      CASE WHEN k % 33 = 0 THEN now() END, left(t, 100), now() - (i || ' minutes')::interval, now(), false, 'ALL'
    FROM (
      SELECT i, abs(hashint4(i + 104729)) k,
        initcap(search_bench.pick(i * 7)) || ' ' || search_bench.pick(i * 11) || CASE WHEN i % 2 = 0 THEN ' ' || search_bench.pick(i * 13) ELSE '' END t
      FROM generate_series(0, ${s.updates - 1}) i
    ) g JOIN search_bench.targets tg ON tg.n = search_bench.target_n(g.i + 3000000);
  `;

  const TI = start['Tiers'];
  const HA = start['HostApplications'];
  const tiers = `
    INSERT INTO "Tiers" (id, name, slug, description, "longDescription", amount, "CollectiveId", type, "interval", "deletedAt", "publicId",
      data, "customFields", "createdAt", "updatedAt", currency)
    SELECT ${TI} + i, nm, regexp_replace(lower(nm), '[^a-z0-9]+', '-', 'g'),
      CASE WHEN k % 2 = 0 THEN 'Become a ' || lower(nm) || ' and support our ' || search_bench.pick(i * 17) || ' ' || search_bench.pick(i * 19) END,
      CASE WHEN k % 4 = 0 THEN '<p>' || search_bench.pick(i * 29) || ' <b>' || search_bench.pick(i * 31) || '</b> ' || repeat(search_bench.pick(i * 37) || ' ' || search_bench.pick(i * 41) || ' &amp; ' || search_bench.pick(i * 43) || '. ', 1 + k % 30) || '</p>' END,
      500 * (1 + k % 20), tg.id, CASE WHEN k % 3 = 0 THEN 'TICKET' ELSE 'TIER' END, CASE WHEN k % 2 = 0 THEN 'month' END,
      CASE WHEN k % 13 = 0 THEN now() END, 'tier_bench' || (${TI} + i), jsonb_build_object('x', k), '{"a":1}'::jsonb, now(), now(), 'USD'
    FROM (
      SELECT i, abs(hashint4(i)) k,
        CASE WHEN abs(hashint4(i + 1)) % 10 < 4 THEN (ARRAY['Backer','Sponsor','Donation','Gold Sponsor','Silver Sponsor','Monthly Supporter','Early bird ticket','Free ticket','Supporter','Backers'])[1 + abs(hashint4(i + 2)) % 10]
             ELSE initcap(search_bench.pick(i * 7)) || ' ' || initcap(search_bench.pick(i * 11)) || CASE WHEN i % 3 = 0 THEN ' ' || initcap(search_bench.pick(i * 13)) ELSE '' END END nm
      FROM generate_series(0, ${s.tiers - 1}) i
    ) g JOIN search_bench.targets tg ON tg.n = 1 + abs(hashint4(g.i + 4000000)) % ${targetCount};
    INSERT INTO "HostApplications" (id, "CollectiveId", "HostCollectiveId", status, message, "customData", "deletedAt", "publicId", "createdAt", "updatedAt")
    SELECT ${HA} + i, tg.id, search_bench.host_of(i + 5000000),
      (ARRAY['PENDING','APPROVED','REJECTED','EXPIRED']::"enum_HostApplications_status"[])[1 + k % 4],
      CASE WHEN k % 10 <> 0 THEN (SELECT string_agg(search_bench.pick(i * 100 + j), ' ') FROM generate_series(1, 10 + k % 70) j) END,
      '{"a":1}'::jsonb, CASE WHEN k % 20 = 0 THEN now() END, 'ha_bench' || (${HA} + i), now(), now()
    FROM (SELECT i, abs(hashint4(i)) k FROM generate_series(0, ${s.hostApplications - 1}) i) g
    JOIN search_bench.targets tg ON tg.n = 1 + abs(hashint4(g.i + 6000000)) % ${targetCount};
  `;

  const CV = start['Conversations'];
  const CM = start['Comments'];
  // Parents by i % 20: 0-13 Expense (70%), 14-15 Update (10%), 16 Conversation (5%), 17 Order (5%, private notes), 18-19 Host Application (10%)
  const comments = `
    INSERT INTO "Conversations" (id, title, summary, "CollectiveId", "FromCollectiveId", "CreatedByUserId", "deletedAt", "publicId", "createdAt", "updatedAt")
    SELECT ${CV} + i, initcap(search_bench.pick(i)) || ' ' || search_bench.pick(i * 3), search_bench.pick(i * 5), tg.id, ${A} + 1 + abs(hashint4(i * 7)) % ${s.accounts},
      1, CASE WHEN i % 40 = 0 THEN now() END, 'conv_bench' || (${CV} + i), now(), now()
    FROM generate_series(0, ${s.conversations - 1}) i
    JOIN search_bench.targets tg ON tg.n = search_bench.target_n(i + 7000000);
    INSERT INTO "Comments" (id, "CollectiveId", "FromCollectiveId", "CreatedByUserId", "ExpenseId", "UpdateId", "ConversationId", "OrderId",
      "HostApplicationId", type, html, "deletedAt", "publicId", "createdAt", "updatedAt")
    SELECT ${CM} + g.i,
      coalesce(e."CollectiveId", u."CollectiveId", cv."CollectiveId", o."CollectiveId", ha."CollectiveId"),
      CASE WHEN g.i % 3 = 0 THEN coalesce(e."FromCollectiveId", ${A} + 1 + g.k % ${s.accounts}) ELSE ${A} + 1 + g.k % ${s.accounts} END,
      1 + g.k % 100000, e.id, u.id, cv.id, o.id, ha.id,
      CASE WHEN o.id IS NOT NULL THEN 'PRIVATE_NOTE' WHEN e.id IS NOT NULL AND g.k % 7 = 0 THEN 'PRIVATE_NOTE'
           WHEN ha.id IS NOT NULL AND g.k % 3 = 0 THEN 'PRIVATE_NOTE' ELSE 'COMMENT' END::"enum_Comments_type",
      '<p>' || (SELECT string_agg(CASE WHEN j % 12 = 0 THEN '<strong>' || search_bench.pick(g.i * 100 + j) || '</strong>' ELSE search_bench.pick(g.i * 100 + j) END, ' ')
                FROM generate_series(1, 8 + g.k % 60) j) || '</p>',
      CASE WHEN g.k % 50 = 0 THEN now() END, 'cmt_bench' || (${CM} + g.i), now() - (g.i || ' seconds')::interval, now()
    FROM (SELECT i, abs(hashint4(i + 7919)) k, i % 20 kind FROM generate_series(0, ${s.comments - 1}) i) g
    LEFT JOIN "Expenses" e ON g.kind < 14 AND e.id = ${E} + abs(hashint4(g.i * 3)) % ${s.expenses}
    LEFT JOIN "Updates" u ON g.kind IN (14, 15) AND u.id = ${U} + abs(hashint4(g.i * 3)) % ${s.updates}
    LEFT JOIN "Conversations" cv ON g.kind = 16 AND cv.id = ${CV} + abs(hashint4(g.i * 3)) % ${s.conversations}
    LEFT JOIN "Orders" o ON g.kind = 17 AND o.id = ${O} + abs(hashint4(g.i * 3)) % ${s.orders}
    LEFT JOIN "HostApplications" ha ON g.kind >= 18 AND ha.id = ${HA} + abs(hashint4(g.i * 3)) % ${s.hostApplications}
    WHERE coalesce(e."CollectiveId", u."CollectiveId", cv."CollectiveId", o."CollectiveId", ha."CollectiveId") IS NOT NULL;
  `;

  return [
    ['helpers', fn],
    ['Collectives', accounts],
    ['targets', targets],
    ['target picker', targetPicker],
    ['Subscriptions', subscriptions],
    ['Tiers + HostApplications', tiers],
    ['Orders', orders],
    ['Expenses + ExpenseItems', expenses],
    ['Updates', updates],
    ['Conversations + Comments', comments],
    ['Transactions', transactions],
  ];
};

const main = async () => {
  const program = new Command()
    .requiredOption('--url <url>', 'PostgreSQL URL of a disposable benchmark database (never production)')
    .option('--scale <number>', 'Multiplier applied to every size', '1')
    .option('--keep-indexes', 'Do not drop/rebuild non-unique indexes during the load (slower)')
    .parse();
  const options = program.opts();
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to run with NODE_ENV=production');
  }

  const scale = Number(options.scale);
  const sizes = Object.fromEntries(
    Object.entries(BASE_SIZES).map(([key, value]) => [
      key,
      Math.max(key === 'hosts' ? 20 : 10, Math.round(value * scale)),
    ]),
  ) as Sizes;
  const client = new Client({ connectionString: options.url });
  await client.connect();
  const timed = async (label: string, query: string) => {
    const startedAt = Date.now();
    await client.query(query);
    console.log(`${label}: ${((Date.now() - startedAt) / 1000).toFixed(1)} s`);
  };

  try {
    await client.query(`SET session_replication_role = replica`); // Skip FK triggers during the load (superuser)
    await client.query(`SET work_mem = '256MB'`);
    await client.query(`SET maintenance_work_mem = '2GB'`);
    await client.query(`SET synchronous_commit = off`);

    const start: Record<string, number> = {};
    for (const table of TABLES) {
      const { rows } = await client.query(`SELECT coalesce(max(id), 0) + 1 AS start FROM "${table}"`);
      start[table] = Number(rows[0].start);
    }
    start['Collectives'] -= 1; // Account number i (1-based) gets ID start + i
    const { rows: platform } = await client.query(`SELECT id FROM "Collectives" WHERE slug = 'opencollective'`);
    const platformId = platform[0]?.id ?? 8686;
    console.log('Sizes', sizes, 'ID offsets', start);

    // Drop non-unique indexes during the load, rebuild them after (same definitions)
    const { rows: indexes } = options.keepIndexes
      ? { rows: [] }
      : await client.query(`
          SELECT i.indexrelid::regclass::text AS name, pg_get_indexdef(i.indexrelid) AS definition, i.indrelid::regclass::text AS "table"
          FROM pg_index i
          WHERE i.indrelid::regclass::text IN (${TABLES.map(t => `'"${t}"'`).join(',')})
          AND NOT i.indisunique AND NOT i.indisprimary
        `);
    for (const index of indexes) {
      await client.query(`DROP INDEX ${index.name}`);
    }

    // The first steps create the receiving accounts, whose count the other steps need
    let targetCount = 0;
    for (const [label, query] of getSteps(sizes, start, platformId, targetCount)) {
      if (label === 'target picker') {
        const { rows } = await client.query(`SELECT count(*)::int AS count FROM search_bench.targets`);
        targetCount = rows[0].count;
        break;
      }
      await timed(label, query);
    }
    const steps = getSteps(sizes, start, platformId, targetCount);
    for (const [label, query] of steps.slice(steps.findIndex(([label]) => label === 'target picker'))) {
      await timed(label, query);
    }

    for (const index of indexes) {
      await timed(`index ${index.name}`, index.definition);
    }

    for (const table of TABLES) {
      await client.query(`SELECT setval(pg_get_serial_sequence('"${table}"', 'id'), (SELECT max(id) FROM "${table}"))`);
    }

    await client.query(`SET session_replication_role = DEFAULT`);
    for (const table of TABLES) {
      await timed(`vacuum analyze ${table}`, `VACUUM (ANALYZE) "${table}"`);
    }

    const { rows: counts } = await client.query(
      TABLES.map(
        t =>
          `SELECT '${t}' AS "table", count(*)::int AS rows, pg_size_pretty(pg_relation_size('"${t}"')) AS heap, pg_size_pretty(pg_total_relation_size('"${t}"')) AS total FROM "${t}"`,
      ).join(' UNION ALL '),
    );
    console.table(counts);
  } finally {
    await client.end();
  }
};

main().catch(error => {
  console.error(error);
  process.exit(1);
});
