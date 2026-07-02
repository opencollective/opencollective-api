/**
 * Convert legacy-format platform tips to the NEW_PLATFORM_TIPS_LEDGER format for a single
 * fiscal host over a given time period.
 *
 * Context: platform tips can be recorded two ways (see docs/platform-tips-ledger.md):
 *   - Legacy: PLATFORM_TIP credit lands on OFiTech (HostCollectiveId = OFiTech); a per-tip
 *     PLATFORM_TIP_DEBT pair carries the host's obligation, with the OWED/INVOICED/SETTLED
 *     lifecycle on a TransactionSettlement keyed (TransactionGroup, PLATFORM_TIP_DEBT).
 *   - New: PLATFORM_TIP credit lands on the host-scoped platform-tips account
 *     (HostCollectiveId = host); the lifecycle lives on a TransactionSettlement keyed
 *     (TransactionGroup, PLATFORM_TIP). Stripe application-fee tips additionally carry an
 *     APPLICATION_FEE pair instead of a debt/settlement.
 *
 * This script rewrites legacy tips in place so a host's books for a past period look as if
 * they had always been on the new ledger. The PLATFORM_TIP face value (collective-currency
 * `amount`) is unchanged; what changes is the account it sits on, its host-currency
 * denomination, and the bookkeeping rows around it. The re-denomination matters: the legacy
 * credit sits on the platform's USD books (hostCurrency = USD), whereas the new-ledger credit
 * lives on the host-scoped platform-tips account, i.e. the host's own books, and must be valued in
 * the host currency — otherwise we leave a foreign (USD) hostCurrency on a host ledger and force
 * the settlement cron to convert it back at a later FX rate.
 *
 * Scope / safety:
 *   - Only legacy tips are touched (PLATFORM_TIP credit still routed to the platform account).
 *     Already-converted tips (credit on platform-tips) are skipped, so the script is idempotent.
 *   - Non-application-fee tips are converted only while their settlement is still OWED. INVOICED/SETTLED
 *     tips already have a settlement Expense and are skipped with a warning (converting them
 *     would require reworking that expense too).
 *   - Refunded tips are skipped.
 *
 * Audit / rollback: every row this script writes or deletes is stamped with
 * `data.migration = 'convert-platform-tips-to-new-ledger'` plus a `data.platformTipsLedgerConversion`
 * block recording the action and the pre-conversion values. This is enough to write a rollback
 * later (restore the re-pointed account ids and host-currency fields from `previous`, un-soft-delete the PLATFORM_TIP_DEBT
 * rows and re-key their settlement, and delete the APPLICATION_FEE rows). The rollback script
 * itself is intentionally not included here.
 *
 * Run (dry-run by default):
 *   HOST_SLUG=opensource FROM=2026-01-01 TO=2026-05-01 \
 *     npx babel-node --extensions .js,.ts scripts/fixes/convert-platform-tips-to-new-ledger.ts
 *
 * Apply for real:
 *   DRY_RUN=false HOST_SLUG=opensource FROM=2026-01-01 TO=2026-05-01 \
 *     npx babel-node --extensions .js,.ts scripts/fixes/convert-platform-tips-to-new-ledger.ts
 *
 * Env:
 *   HOST_SLUG  (required) slug of the fiscal host whose tips to convert
 *   FROM       (required) inclusive lower bound on the PLATFORM_TIP credit createdAt (ISO date).
 *              Must be >= 2024-10-01: earlier tips used the previous platform account and are not handled.
 *   TO         (required) exclusive upper bound on the PLATFORM_TIP credit createdAt (ISO date)
 *   DRY_RUN    defaults to true; set DRY_RUN=false to write changes
 *   LIMIT      optional cap on the number of tips processed
 */

import '../../server/env';

import { QueryTypes } from 'sequelize';

import PlatformConstants from '../../server/constants/platform';
import { TransactionKind } from '../../server/constants/transaction-kind';
import { roundCentsAmount } from '../../server/lib/currency';
import logger from '../../server/lib/logger';
import { getHostPlatformTipsAccount, getOrCreateHostPlatformTipsAccount } from '../../server/lib/transactions';
import models, { sequelize } from '../../server/models';
import { TransactionSettlementStatus } from '../../server/models/TransactionSettlement';

const PLATFORM_TIP = TransactionKind.PLATFORM_TIP;
const PLATFORM_TIP_DEBT = TransactionKind.PLATFORM_TIP_DEBT;
const APPLICATION_FEE = TransactionKind.APPLICATION_FEE;

// Every row this script touches is stamped with `data.migration = MIGRATION` (matching the
// repo convention, e.g. `WHERE "data"->>'migration' = '...'`) plus a `data.platformTipsLedgerConversion`
// block recording what changed and the pre-conversion values, so a rollback script can:
//   - restore the re-pointed PLATFORM_TIP rows from `previous` (CollectiveId/HostCollectiveId/FromCollectiveId
//     plus the credit's hostCurrency/hostCurrencyFxRate/amountInHostCurrency),
//   - un-soft-delete the PLATFORM_TIP_DEBT rows and re-key their TransactionSettlement back, and
//   - hard-delete the APPLICATION_FEE rows it created.
const MIGRATION = 'convert-platform-tips-to-new-ledger';

export const convertPlatformTipsToNewLedger = async ({
  hostSlug,
  from,
  to,
  dryRun = true,
  limit = null,
}: {
  hostSlug: string;
  from: string;
  to: string;
  dryRun?: boolean;
  limit?: number | null;
}) => {
  // Local aliases keep the body below identical to the env-driven CLI wrapper at the bottom.
  const HOST_SLUG = hostSlug;
  const FROM = from;
  const TO = to;
  const DRY_RUN = dryRun;
  const LIMIT = limit;

  if (!HOST_SLUG || !FROM || !TO) {
    throw new Error('hostSlug, from and to are required');
  }

  // The tipCredits query only matches PLATFORM_TIP credits routed to the current platform account
  // (PlatformConstants.PlatformCollectiveId). Before 2024-10-01, tips were routed to the previous
  // platform account (PlatformConstants.OCICollectiveId), which this script does not handle — such
  // tips would be silently missed. We don't intend to convert anything that old, so reject the
  // range outright rather than partially process it.
  const PLATFORM_ACCOUNT_CUTOFF = '2024-10-01';
  if (new Date(FROM) < new Date(PLATFORM_ACCOUNT_CUTOFF)) {
    throw new Error(
      `FROM (${FROM}) is before ${PLATFORM_ACCOUNT_CUTOFF}: pre-cutoff tips were routed to the previous ` +
        `platform account (OCICollectiveId) and are not handled by this script. Use FROM >= ${PLATFORM_ACCOUNT_CUTOFF}.`,
    );
  }

  const host = await models.Collective.findBySlug(HOST_SLUG);
  if (!host) {
    throw new Error(`No collective found for slug "${HOST_SLUG}"`);
  }
  if (!(await host.isHost())) {
    throw new Error(`Collective "${HOST_SLUG}" (#${host.id}) is not a fiscal host`);
  }
  if (!host.hasNewPlatformTipsLedger()) {
    logger.warn(
      `Host "${HOST_SLUG}" does not have settings.newPlatformTipsLedger enabled. ` +
        `This script will still convert historical tips, but new tips will keep using the legacy flow until the flag is set.`,
    );
  }

  // A dry run must stay read-only: look the account up without creating it (it's only dereferenced on
  // the non-dry conversion path below). Creating it eagerly would leave an internal Collective behind
  // for a host that was only inspected.
  const platformTipsAccount = DRY_RUN
    ? await getHostPlatformTipsAccount(host)
    : await getOrCreateHostPlatformTipsAccount(host);
  const platformCollectiveId = PlatformConstants.PlatformCollectiveId;
  const convertedAt = new Date().toISOString();

  // Builds the `data` block stamped on a converted row: the queryable `migration` marker plus a
  // detail object explaining what happened and (for re-pointed rows) the values to restore on rollback.
  const conversionMeta = (existingData, detail) => ({
    ...(existingData || {}),
    migration: MIGRATION,
    platformTipsLedgerConversion: { convertedAt, host: host.slug, ...detail },
  });

  // Legacy PLATFORM_TIP credits attributed to this host (host carried by a sibling transaction in
  // the same group). CollectiveId = platform account filters to the legacy routing only, so
  // already-converted tips are excluded and the script is idempotent.
  const tipCredits = await sequelize.query(
    `
      SELECT DISTINCT pt.id
      FROM "Transactions" pt
      INNER JOIN "Transactions" sib
        ON sib."TransactionGroup" = pt."TransactionGroup"
       AND sib."HostCollectiveId" = :hostId
       AND sib."kind" NOT IN ('PLATFORM_TIP', 'PLATFORM_TIP_DEBT')
       AND sib."deletedAt" IS NULL
      WHERE pt."kind" = 'PLATFORM_TIP'
        AND pt."type" = 'CREDIT'
        AND pt."CollectiveId" = :platformCollectiveId
        AND pt."RefundTransactionId" IS NULL
        AND (pt."isRefund" IS NULL OR pt."isRefund" IS FALSE)
        AND pt."deletedAt" IS NULL
        AND pt."createdAt" >= :from
        AND pt."createdAt" < :to
      ORDER BY pt.id ASC
    `,
    {
      type: QueryTypes.SELECT,
      replacements: { hostId: host.id, platformCollectiveId, from: FROM, to: TO },
    },
  );

  logger.info(
    `Found ${tipCredits.length} legacy platform-tip group(s) for host "${HOST_SLUG}" (#${host.id}) between ${FROM} and ${TO}`,
  );

  const stats = { converted: 0, applicationFee: 0, owed: 0, skipped: 0 };
  let count = 0;

  for (const { id } of tipCredits as Array<{ id: number }>) {
    if (LIMIT && count >= LIMIT) {
      logger.info(`Reached LIMIT of ${LIMIT}, stopping`);
      break;
    }
    count++;

    const creditRow = await models.Transaction.findByPk(id);
    if (!creditRow) {
      continue;
    }
    const { TransactionGroup } = creditRow;

    // Validate the legacy group shape before mutating anything, so a malformed group (e.g. a
    // half-written pair) is skipped rather than half-converted. A well-formed group has exactly one
    // PLATFORM_TIP pair (1 CREDIT + 1 DEBIT). Application-fee tips carry no PLATFORM_TIP_DEBT;
    // non-application-fee tips carry exactly one PLATFORM_TIP_DEBT pair (1 DEBIT + 1 CREDIT).
    const platformTipRows = await models.Transaction.findAll({
      where: { TransactionGroup, kind: PLATFORM_TIP },
    });
    const debtRows = await models.Transaction.findAll({
      where: { TransactionGroup, kind: PLATFORM_TIP_DEBT },
    });

    const tipCreditCount = platformTipRows.filter(t => t.type === 'CREDIT').length;
    const tipDebitCount = platformTipRows.filter(t => t.type === 'DEBIT').length;
    if (tipCreditCount !== 1 || tipDebitCount !== 1) {
      logger.warn(
        `[${TransactionGroup}] unexpected PLATFORM_TIP shape (${tipCreditCount} credit / ${tipDebitCount} debit row(s)), skipping`,
      );
      stats.skipped++;
      continue;
    }

    const debtCreditCount = debtRows.filter(t => t.type === 'CREDIT').length;
    const debtDebitCount = debtRows.filter(t => t.type === 'DEBIT').length;
    let isApplicationFee: boolean;
    if (debtRows.length === 0) {
      // Application-fee tip: no debt, settled at collection via Stripe's application fee.
      isApplicationFee = true;
    } else if (debtCreditCount === 1 && debtDebitCount === 1) {
      // Non-application-fee tip: exactly one PLATFORM_TIP_DEBT pair carrying the obligation.
      isApplicationFee = false;
    } else {
      logger.warn(
        `[${TransactionGroup}] unexpected PLATFORM_TIP_DEBT shape (${debtDebitCount} debit / ${debtCreditCount} credit row(s)), skipping`,
      );
      stats.skipped++;
      continue;
    }

    // For non-application-fee tips, only OWED ones are safe to convert.
    if (!isApplicationFee) {
      const settlement = await models.TransactionSettlement.findOne({
        where: { TransactionGroup, kind: PLATFORM_TIP_DEBT },
      });
      if (!settlement) {
        logger.warn(`[${TransactionGroup}] non-application-fee tip has no TransactionSettlement, skipping`);
        stats.skipped++;
        continue;
      }
      if (settlement.status !== TransactionSettlementStatus.OWED) {
        logger.warn(
          `[${TransactionGroup}] settlement is ${settlement.status} (not OWED), skipping — it already has a settlement expense`,
        );
        stats.skipped++;
        continue;
      }
    }

    const label = isApplicationFee ? 'application-fee' : 'OWED';

    // The legacy credit sits on the platform's USD books; on the new ledger it lives on the
    // host-scoped platform-tips account (the host's own books) and must be denominated in the host
    // currency, exactly as createPlatformTipTransactions does for a native tip. Re-denominate the
    // host-currency valuation here so we never leave a USD hostCurrency on a host ledger and the
    // settlement cron's host-currency sum hits its no-conversion fast path. The collective-currency
    // face value (amount/currency) is untouched; only the host-currency valuation changes. When the
    // tip currency already equals the host currency, getFxRate returns 1 (a pure no-op re-stamp).
    const newHostCurrency = host.currency;
    const newHostCurrencyFxRate = await models.Transaction.getFxRate(creditRow.currency, newHostCurrency, creditRow);
    const newAmountInHostCurrency = roundCentsAmount(creditRow.amount * newHostCurrencyFxRate, newHostCurrency);

    if (DRY_RUN) {
      logger.info(
        `[${TransactionGroup}] would convert ${label} tip #${creditRow.id} (${creditRow.amount / 100} ${creditRow.currency}; ` +
          `host-currency valuation ${creditRow.amountInHostCurrency / 100} ${creditRow.hostCurrency} -> ${newAmountInHostCurrency / 100} ${newHostCurrency})`,
      );
      stats.converted++;
      if (isApplicationFee) {
        stats.applicationFee++;
      } else {
        stats.owed++;
      }
      continue;
    }

    const path = isApplicationFee ? 'application-fee' : 'owed';

    await sequelize.transaction(async sequelizeTransaction => {
      // 1. Re-point the PLATFORM_TIP CREDIT (platform side) onto the host-scoped platform-tips account
      //    and re-denominate it to the host currency, stashing the pre-conversion account ids and
      //    host-currency fields under data.platformTipsLedgerConversion.previous for rollback.
      creditRow.set({
        CollectiveId: platformTipsAccount.id,
        HostCollectiveId: host.id,
        hostCurrency: newHostCurrency,
        hostCurrencyFxRate: newHostCurrencyFxRate,
        amountInHostCurrency: newAmountInHostCurrency,
        data: conversionMeta(creditRow.data, {
          path,
          action: 're-pointed-platform-tip-credit',
          previous: {
            CollectiveId: creditRow.CollectiveId,
            HostCollectiveId: creditRow.HostCollectiveId,
            hostCurrency: creditRow.hostCurrency,
            hostCurrencyFxRate: creditRow.hostCurrencyFxRate,
            amountInHostCurrency: creditRow.amountInHostCurrency,
          },
        }),
      });
      await creditRow.save({ transaction: sequelizeTransaction });

      // ...and its mirror DEBIT (on the contributor): the counterparty is now platform-tips. Its
      // host-currency fields are deliberately left untouched — the DEBIT lives on the contributor's
      // books (HostCollectiveId = contributor host, or null), never on this host's ledger, so it is
      // valued in the contributor-side currency just as createDoubleEntry produces for a native tip.
      const debitRow = await models.Transaction.findOne({
        where: { TransactionGroup, kind: PLATFORM_TIP, type: 'DEBIT' },
        transaction: sequelizeTransaction,
      });
      if (debitRow) {
        debitRow.set({
          FromCollectiveId: platformTipsAccount.id,
          data: conversionMeta(debitRow.data, {
            path,
            action: 're-pointed-platform-tip-debit',
            previous: { FromCollectiveId: debitRow.FromCollectiveId },
          }),
        });
        await debitRow.save({ transaction: sequelizeTransaction });
      }

      if (isApplicationFee) {
        // New flow: application-fee tips carry an APPLICATION_FEE pair (platform-tips -> OFiTech)
        // instead of a debt/settlement. Reload the re-pointed credit so the pair derives the right accounts.
        const platformTipTransaction = await models.Transaction.findByPk(creditRow.id, {
          transaction: sequelizeTransaction,
        });
        await models.Transaction.createApplicationFeeTransactions({ platformTipTransaction }, { sequelizeTransaction });
        // Stamp the freshly-created APPLICATION_FEE pair so a rollback can find and delete it.
        await sequelize.query(
          `
            UPDATE "Transactions"
            SET "data" = COALESCE("data", '{}'::jsonb) || :meta::jsonb
            WHERE "TransactionGroup" = :TransactionGroup AND "kind" = :kind
          `,
          {
            type: QueryTypes.UPDATE,
            replacements: {
              TransactionGroup,
              kind: APPLICATION_FEE,
              meta: JSON.stringify(conversionMeta(null, { path, action: 'created-application-fee' })),
            },
            transaction: sequelizeTransaction,
          },
        );
      } else {
        // New flow: drop the per-tip PLATFORM_TIP_DEBT pair and move the OWED lifecycle from the
        // debt onto the PLATFORM_TIP credit by re-keying the TransactionSettlement row. Stamp the
        // debt rows before soft-deleting so a rollback can locate and un-delete them.
        await sequelize.query(
          `
            UPDATE "Transactions"
            SET "data" = COALESCE("data", '{}'::jsonb) || :meta::jsonb
            WHERE "TransactionGroup" = :TransactionGroup AND "kind" = :kind AND "deletedAt" IS NULL
          `,
          {
            type: QueryTypes.UPDATE,
            replacements: {
              TransactionGroup,
              kind: PLATFORM_TIP_DEBT,
              meta: JSON.stringify(conversionMeta(null, { path, action: 'soft-deleted-platform-tip-debt' })),
            },
            transaction: sequelizeTransaction,
          },
        );
        await models.Transaction.destroy({
          where: { TransactionGroup, kind: PLATFORM_TIP_DEBT },
          transaction: sequelizeTransaction,
        });
        await sequelize.query(
          `
            UPDATE "TransactionSettlements"
            SET "kind" = 'PLATFORM_TIP', "updatedAt" = NOW()
            WHERE "TransactionGroup" = :TransactionGroup
              AND "kind" = 'PLATFORM_TIP_DEBT'
              AND "deletedAt" IS NULL
          `,
          { type: QueryTypes.UPDATE, replacements: { TransactionGroup }, transaction: sequelizeTransaction },
        );
      }
    });

    logger.info(`[${TransactionGroup}] converted ${label} tip #${creditRow.id}`);
    stats.converted++;
    if (isApplicationFee) {
      stats.applicationFee++;
    } else {
      stats.owed++;
    }
  }

  logger.info(
    `${DRY_RUN ? '[DRY RUN] ' : ''}Done. Converted ${stats.converted} tip(s) ` +
      `(${stats.owed} OWED, ${stats.applicationFee} application-fee), skipped ${stats.skipped}.`,
  );
  if (DRY_RUN) {
    logger.info('This was a dry run. Re-run with DRY_RUN=false to apply.');
  }

  return stats;
};

const main = async () =>
  convertPlatformTipsToNewLedger({
    hostSlug: process.env.HOST_SLUG,
    from: process.env.FROM,
    to: process.env.TO,
    dryRun: process.env.DRY_RUN !== 'false',
    limit: process.env.LIMIT ? parseInt(process.env.LIMIT, 10) : null,
  });

if (!module.parent) {
  main()
    .then(() => process.exit(0))
    .catch(e => {
      logger.error(e);
      process.exit(1);
    });
}
