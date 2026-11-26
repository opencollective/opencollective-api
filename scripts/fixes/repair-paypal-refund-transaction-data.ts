/**
 * Backfill script for a bug where PayPal refunds overwrote `Transaction.data` on both the
 * original (non-refund) and refund transaction rows with a flat refund payload, wiping out the
 * original capture/sale info (`data.capture`, `data.paypalCaptureId`, ...) in the process. This
 * broke `merchantId` resolution used to reconcile transactions against PayPal reports.
 *
 * Corrupted rows look like:
 *
 * {
 *   "hasPlatformTip": false,
 *   "paypalResponse": {
 *     "id": "22572252RX9045022",
 *     "links": [
 *       { "rel": "self", "href": ".../v2/payments/refunds/22572252RX9045022", "method": "GET" },
 *       { "rel": "up", "href": ".../v2/payments/captures/9GW92517ME7806848", "method": "GET" }
 *     ],
 *     "status": "COMPLETED"
 *   }
 * }
 *
 * This script finds transactions of kind `CONTRIBUTION` with that corrupted shape, re-fetches the
 * original capture and the refund from the PayPal API once per `TransactionGroup` (CREDIT/DEBIT
 * pairs share the same group and were corrupted identically), and re-persists `data` for both
 * rows in the pair following the new decoupled schema (see `associateTransactionRefundId` in
 * `server/lib/payments.ts`), where refund-time information is only ever recorded on the refund
 * transaction, and the original (non-refund) transaction keeps its own capture/sale data untouched:
 * - Non-refund rows only get `capture` / `paypalCaptureId` restored. They never get `refund` /
 *   `paypalRefundId`, since that information now belongs exclusively to the refund transaction.
 * - Refund rows (`isRefund: true`) get both `capture` / `paypalCaptureId` (inherited from the
 *   original transaction, as done when creating a refund) and `refund` / `paypalRefundId`,
 *   instead of the flattened `paypalResponse`.
 *
 * Usage:
 *   Dry run:  DRY=1 npx babel-node scripts/fixes/repair-paypal-refund-transaction-data.ts
 *   Live run: HOST_ID=123 SINCE=2023-01-01 npx babel-node scripts/fixes/repair-paypal-refund-transaction-data.ts
 *
 * Env vars:
 *   DRY       If set, only logs what would change without persisting anything.
 *   HOST_ID   Restricts the search to transactions for a single host (HostCollectiveId). This host
 *             must be connected to PayPal. If not set, all hosts connected to PayPal are scanned.
 *   SINCE     Restricts the search to transactions created on or after this date.
 */
import '../../server/env';

import assert from 'assert';

import { get, omit } from 'lodash';
import { QueryTypes } from 'sequelize';

import { Service } from '../../server/constants/connected-account';
import { TransactionKind } from '../../server/constants/transaction-kind';
import logger from '../../server/lib/logger';
import { getHostsWithPayPalConnected } from '../../server/lib/paypal';
import models, { sequelize } from '../../server/models';
import Collective from '../../server/models/Collective';
import Transaction from '../../server/models/Transaction';
import { paypalRequestV2 } from '../../server/paymentProviders/paypal/api';
import { PaypalCapture, PaypalRefund } from '../../server/types/paypal';

const parsePositiveIntEnvVar = (name: string, value: string): number => {
  if (!/^\d+$/.test(value.trim())) {
    throw new Error(`Invalid ${name}: "${value}" is not a positive integer`);
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${name}: "${value}" is not a positive safe integer`);
  }

  return parsed;
};

const DRY = Boolean(process.env.DRY);
const HOST_ID = process.env.HOST_ID !== undefined ? parsePositiveIntEnvVar('HOST_ID', process.env.HOST_ID) : undefined;
const SINCE = process.env.SINCE ? new Date(process.env.SINCE) : undefined;
const BATCH_SIZE = 100;

type PaypalLink = { href: string; rel: string; method: string };

/** Extracts the trailing resource id from a PayPal HATEOAS link whose href matches `/payments/{resourceType}/{id}` */
const getPaypalIdFromLink = (links: PaypalLink[] | undefined, resourceType: 'captures' | 'refunds'): string | null => {
  const link = links?.find(l => new RegExp(`/payments/${resourceType}/`).test(l.href));
  if (!link) {
    return null;
  }

  const path = link.href.replace(/^.+\/v2\//, ''); // https://api.paypal.com/v2/payments/captures/XXX -> payments/captures/XXX
  return path.split('/').pop() || null;
};

/**
 * Resolves the list of hosts to scan for corrupted transactions.
 * - If `HOST_ID` is set, validates that this specific host is connected to PayPal.
 * - Otherwise, returns all hosts connected to PayPal.
 */
const getHostsToScan = async (): Promise<Collective[]> => {
  if (HOST_ID === undefined) {
    return getHostsWithPayPalConnected();
  }

  const host = await models.Collective.findByPk(HOST_ID);
  if (!host) {
    throw new Error(`Host #${HOST_ID} not found`);
  }

  const paypalAccount = await host.getAccountForPaymentProvider(Service.PAYPAL);
  if (!paypalAccount) {
    throw new Error(`Host #${HOST_ID} (${host.slug}) is not connected to PayPal`);
  }

  return [host];
};

/**
 * Fetches one page of corrupted transaction groups using keyset pagination on the group's minimum
 * `id`. Since repaired transactions no longer match the WHERE clause (their `paypalResponse` key
 * is removed), this stays correct even when running live (non-DRY) without needing to track an
 * offset.
 *
 * CONTRIBUTION transactions are always created in CREDIT/DEBIT pairs sharing the same
 * `TransactionGroup`, and the refund bug overwrote `data` identically on both, so each returned
 * group contains all the rows that need to be repaired together.
 */
const findCorruptedTransactionGroups = async (
  hostIds: number[],
  lastId: number,
): Promise<Array<{ transactionGroup: string; minId: number }>> => {
  return sequelize.query(
    `
    SELECT t."TransactionGroup" AS "transactionGroup", MIN(t."id") AS "minId"
    FROM "Transactions" t
    WHERE t."kind" = 'CONTRIBUTION'
      AND t."data" -> 'paypalResponse' ->> 'id' IS NOT NULL
      AND jsonb_typeof(t."data" -> 'paypalResponse' -> 'links') = 'array'
      AND t."HostCollectiveId" IN (:hostIds)
      AND (:since::timestamp IS NULL OR t."createdAt" >= :since)
    GROUP BY t."TransactionGroup"
    HAVING MIN(t."id") > :lastId
    ORDER BY MIN(t."id")
    LIMIT :batchSize
    `,
    {
      type: QueryTypes.SELECT,
      replacements: { lastId, hostIds, since: SINCE ?? null, batchSize: BATCH_SIZE },
    },
  );
};

/**
 * Simple in-memory cache for PayPal refund/capture lookups, keyed by resource id.
 */
const paypalRefundCache = new Map<string, Promise<PaypalRefund>>();
const paypalCaptureCache = new Map<string, Promise<PaypalCapture>>();

const getCachedPaypalRefund = (refundId: string, host: Collective): Promise<PaypalRefund> => {
  if (!paypalRefundCache.has(refundId)) {
    paypalRefundCache.set(
      refundId,
      paypalRequestV2(`payments/refunds/${refundId}`, host, 'GET') as Promise<PaypalRefund>,
    );
  }
  return paypalRefundCache.get(refundId);
};

const getCachedPaypalCapture = (captureId: string, host: Collective): Promise<PaypalCapture> => {
  if (!paypalCaptureCache.has(captureId)) {
    paypalCaptureCache.set(
      captureId,
      paypalRequestV2(`payments/captures/${captureId}`, host, 'GET') as Promise<PaypalCapture>,
    );
  }
  return paypalCaptureCache.get(captureId);
};

const repairTransactionGroup = async (transactions: Transaction[], stats: Record<string, number>): Promise<void> => {
  const transactionWithPaypalResponse = transactions.find(t => get(t.data, 'paypalResponse.id'));
  const paypalResponse = get(transactionWithPaypalResponse?.data, 'paypalResponse') as {
    id: string;
    links?: PaypalLink[];
  };
  const refundId = paypalResponse?.id;
  if (!refundId) {
    stats.skipped += transactions.length;
    return;
  }

  const captureId = getPaypalIdFromLink(paypalResponse.links, 'captures');
  if (!captureId) {
    logger.warn(
      `TransactionGroup ${transactions[0]?.TransactionGroup}: could not find capture id in refund links, skipping`,
    );
    stats.skipped += transactions.length;
    return;
  }

  // All rows in the group were corrupted identically by the same bug, so every transaction that
  // still carries a `paypalResponse` payload must resolve to the same refund/capture ids.
  const otherIds = transactions
    .map(t => get(t.data, 'paypalResponse') as { id: string; links?: PaypalLink[] } | undefined)
    .filter(Boolean)
    .map(response => ({ refundId: response.id, captureId: getPaypalIdFromLink(response.links, 'captures') }));
  assert(
    otherIds.every(ids => ids.refundId === refundId && ids.captureId === captureId),
    `TransactionGroup ${transactions[0]?.TransactionGroup}: mismatched refund/capture ids across grouped transactions`,
  );

  const host = await transactionWithPaypalResponse.getHostCollective();
  if (!host) {
    logger.warn(`TransactionGroup ${transactions[0]?.TransactionGroup}: could not find host, skipping`);
    stats.skipped += transactions.length;
    return;
  }

  // Re-fetch fresh, authoritative data from PayPal rather than trusting whatever is left in `data`
  const [refundDetails, captureDetails] = await Promise.all([
    getCachedPaypalRefund(refundId, host),
    getCachedPaypalCapture(captureId, host),
  ]);

  for (const transaction of transactions) {
    const baseData = omit(transaction.data, [
      'paypalResponse',
      'refund',
      'paypalRefundId',
      'capture',
      'paypalCaptureId',
    ]);
    const newData = transaction.isRefund
      ? {
          ...baseData,
          capture: captureDetails,
          refund: refundDetails,
          paypalCaptureId: captureDetails.id,
          paypalRefundId: refundDetails.id,
        }
      : {
          ...baseData,
          capture: captureDetails,
          paypalCaptureId: captureDetails.id,
        };

    logger.info(
      DRY
        ? `Would update data for Transaction #${transaction.id} (isRefund=${transaction.isRefund}) from:\n${JSON.stringify(transaction.data, null, 2)}\n to \n${JSON.stringify(newData, null, 2)}`
        : `Updating data for Transaction #${transaction.id} (isRefund=${transaction.isRefund})`,
    );

    if (!DRY) {
      await transaction.update({ data: newData });
    }

    stats.updated++;
  }
};

const main = async () => {
  const hosts = await getHostsToScan();
  if (!hosts.length) {
    logger.info('No hosts connected to PayPal found, nothing to do');
    return;
  }

  const hostIds = hosts.map(host => host.id);
  const hostSlugs = hosts.map(host => host.slug).join(', ');
  logger.info(
    `Scanning ${hosts.length} host(s) connected to PayPal for corrupted transactions${DRY ? ' (DRY RUN, no changes will be made)' : ''}: ${hostSlugs}`,
  );

  const stats = { updated: 0, skipped: 0, errored: 0 };
  let lastId = 0;
  while (true) {
    const groups = await findCorruptedTransactionGroups(hostIds, lastId);
    if (!groups.length) {
      break;
    }

    for (const group of groups) {
      const transactions = await models.Transaction.findAll({
        where: { TransactionGroup: group.transactionGroup, kind: TransactionKind.CONTRIBUTION },
        order: [['id', 'ASC']],
      });

      try {
        await repairTransactionGroup(transactions, stats);
      } catch (e) {
        stats.errored += transactions.length;
        logger.error(`TransactionGroup ${transactions[0]?.TransactionGroup}: failed to repair - ${e.message}`);
      }
    }

    lastId = groups[groups.length - 1].minId;

    if (groups.length < BATCH_SIZE) {
      break;
    }
  }

  logger.info(`Done. Updated: ${stats.updated}, Skipped: ${stats.skipped}, Errored: ${stats.errored}`);
};

if (require.main === module) {
  main()
    .then(() => process.exit())
    .catch(e => {
      console.error(e);
      process.exit(1);
    });
}
