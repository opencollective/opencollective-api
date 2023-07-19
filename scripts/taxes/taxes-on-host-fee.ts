#!/usr/bin/env ./node_modules/.bin/babel-node

import '../../server/env.js';

import { Command } from 'commander';
import { groupBy, mapValues, pick, sumBy } from 'lodash-es';

import logger from '../../server/lib/logger.js';
import { formatCurrency } from '../../server/lib/utils.js';
import models, { sequelize } from '../../server/models/index.js';

const DRY_RUN = process.env.DRY_RUN !== 'false';

const program = new Command().description('Helper to remove collected taxes from host fees');

type BaseDataQueryResult = {
  hostId: number;
  hostSlug: string;
  hostCurrency: string;
  transactionId: number;
  hostFeeTransactionId: number;
  hostFeeCurrencyFxRate: number;
  hostFeeInHostCurrency: number;
  exceptedHostFeeInHostCurrency: number;
};

const baseDataQuery = `
  WITH all_results AS (
    SELECT
    host.id AS "hostId",
    host.slug AS "hostSlug",
    host."currency" AS "hostCurrency",
    t.id AS "transactionId",
    host_fee.id AS "hostFeeTransactionId",
    host_fee."hostCurrencyFxRate" AS "hostFeeCurrencyFxRate",
    host_fee."amountInHostCurrency" AS "hostFeeInHostCurrency",
    ROUND(
      ROUND(
        -- Before this fix, this was computed without the tax amount omitted
        (t."amount" + t."taxAmount") * CASE
          -- Get the right host fee rate based on host
          WHEN host.slug = 'europe' THEN 0.06
          WHEN host.slug = 'allforclimate' THEN 0.05
          WHEN host.slug = 'reculture' THEN 0.05
          WHEN host.slug = 'paris' THEN 0.05
          WHEN host.slug = 'ocnz' AND t.id <= 906632 THEN 0.05
          WHEN host.slug = 'ocnz' AND t.id > 906632 THEN 0.0575
          ELSE 0 -- Will be considered as a bug
        END
      ) * t."hostCurrencyFxRate"
    ) AS "exceptedHostFeeInHostCurrency"
  FROM "Transactions" t
  INNER JOIN "Collectives" host
    ON host.id = t."HostCollectiveId"
  INNER JOIN "Collectives" collective
    ON collective.id = t."CollectiveId"
  INNER JOIN "Transactions" host_fee
    ON host_fee."TransactionGroup" = t."TransactionGroup"
    AND host_fee."kind" = 'HOST_FEE' AND host_fee.type = t.type
    AND host_fee."deletedAt" IS NULL
    AND host_fee."RefundTransactionId" IS NULL
  WHERE host.slug IN ('europe', 'ocnz') -- Skipping AllForClimate since there's only 3cents to refund
  AND t."RefundTransactionId" IS NULL
  AND t."taxAmount" < 0
  AND t.kind = 'CONTRIBUTION'
  AND t."type" = 'CREDIT'
  AND t."deletedAt" IS NULL
  AND t."HostCollectiveId" = collective."HostCollectiveId" -- Make sure the collective is still hosted by the same host (we have no cases like that, but just in case)
  AND collective."isActive" IS TRUE -- Ignore archived/unhosted collectives. This will affect two profiles for a total of €2.30: https://opencollective.com/the-digital-circle/events/mapathon-mapping-hackathon-2021-88a863b4 and https://opencollective.com/pistil
  ORDER BY host.slug, t.id DESC
  ) SELECT *
    FROM all_results
    WHERE "exceptedHostFeeInHostCurrency" != "hostFeeInHostCurrency"
    ORDER BY "hostSlug", "transactionId" DESC;
`;

program
  .command('check-pending')
  .description("Check host fees with taxes that haven't been fixed yet")
  .action(async () => {
    const data = await sequelize.query(baseDataQuery, { type: sequelize.QueryTypes.SELECT });
    const groupedByHost = groupBy(data, 'hostSlug');
    const nbHosts = Object.keys(groupedByHost).length;
    logger.info(`Found ${data.length} transactions to update for a total of ${nbHosts} hosts`);
    for (const [hostSlug, transactions] of Object.entries(groupedByHost)) {
      logger.info(`==== Host ${hostSlug} ====`);
      const totalTaxesCollected = sumBy(transactions, 'hostFeeInHostCurrency');
      const totalTaxesExpected = sumBy(transactions, 'exceptedHostFeeInHostCurrency');
      const amountToRefund = totalTaxesCollected - totalTaxesExpected;
      const currency = transactions[0].hostCurrency;
      logger.info(
        `${transactions.length} transactions to update for a total of ${formatCurrency(amountToRefund, currency)}\n`,
      );
    }
  });

const migrateHostFeeTransaction = (transaction, newValues, dbTransaction): Promise<typeof models.Transaction> => {
  return transaction.update(
    {
      ...newValues,
      data: {
        ...transaction.data,
        fixHostFeeWithTaxes: {
          migratedAt: new Date(),
          previousValues: pick(transaction.dataValues, Object.keys(newValues)),
        },
      },
    },
    { transaction: dbTransaction },
  );
};

program
  .command('fix')
  .description('Remove taxes from host fees')
  .action(async () => {
    if (DRY_RUN) {
      logger.info('This is a dry run, use --run to trigger changes');
    }

    const data: BaseDataQueryResult[] = await sequelize.query(baseDataQuery, { type: sequelize.QueryTypes.SELECT });
    const groupedByHost = groupBy(data, 'hostSlug');
    const nbHosts = Object.keys(groupedByHost).length;
    logger.info(`Found ${data.length} transactions to update for a total of ${nbHosts} hosts`);

    for (const [hostSlug, transactions] of Object.entries(groupedByHost)) {
      logger.info(`==== Host ${hostSlug} ====`);
      for (const { exceptedHostFeeInHostCurrency, hostFeeCurrencyFxRate, hostFeeTransactionId } of transactions) {
        const hostFeeCredit = await models.Transaction.findByPk(hostFeeTransactionId);
        const hostFeeDebit = await hostFeeCredit.getOppositeTransaction();

        // Update all values in a transaction to avoid inconsistencies if something fails in the middle
        await sequelize.transaction(async dbTransaction => {
          const expectedHostFeeInCollectiveCurrency = Math.round(exceptedHostFeeInHostCurrency / hostFeeCurrencyFxRate);
          const newCreditValues = {
            amount: expectedHostFeeInCollectiveCurrency,
            netAmountInCollectiveCurrency: expectedHostFeeInCollectiveCurrency,
            amountInHostCurrency: exceptedHostFeeInHostCurrency,
          };
          const newDebitValues = mapValues(newCreditValues, value => -value);

          // Update HOST_FEE transactions
          await migrateHostFeeTransaction(hostFeeCredit, newCreditValues, dbTransaction);
          await migrateHostFeeTransaction(hostFeeDebit, newDebitValues, dbTransaction);

          // We're not updating the HOST_FEE_SHARE / HOST_FEE_SHARE_DEBT transactions on purpose: they'll be settled
          // by manually creating expenses form OC Inc.
          if (DRY_RUN) {
            logger.info(`Would update transaction ${hostFeeCredit.id} and ${hostFeeDebit.id}`);
            await models.Transaction.validate(hostFeeCredit, {
              validateOppositeTransaction: true,
              oppositeTransaction: hostFeeDebit,
            });
            throw new Error('Dry run: Rolling back changes');
          } else {
            logger.info(`Updated host fee transactions ${hostFeeCredit.id}/${hostFeeDebit.id}`);
          }
        });
      }
    }
  });

// Check
program
  .command('check-fixed')
  .description('Check host fees with taxes that have already been fixed')
  .action(async () => {
    const results = await sequelize.query(
      `
      SELECT
        t."TransactionGroup",
        host.slug AS "hostSlug",
        host.currency AS "hostCurrency",
        collective.slug AS "collectiveSlug",
        t."amountInHostCurrency" AS "hostFeeInHostCurrency",
        (t."data" -> 'fixHostFeeWithTaxes' -> 'previousValues' ->> 'amountInHostCurrency')::integer AS "previousHostFeeInHostCurrency",
        COALESCE(host_fee_share."amount", 0) AS "hostFeeShareInHostCurrency",
        CASE WHEN
          host_fee_share."amount" IS NULL THEN 0
          WHEN host.slug = 'europe' THEN CASE WHEN t."createdAt" < '2022-06-01' THEN 0.15 ELSE 0.395 END
          WHEN host.slug = 'ocnz' THEN 0.15
        END AS "hostFeeSharePercent"
      FROM "Transactions" t
      INNER JOIN "Collectives" host ON host.id = t."HostCollectiveId"
      INNER JOIN "Collectives" collective ON collective.id = t."CollectiveId"
      LEFT JOIN "Transactions" host_fee_share ON host_fee_share."TransactionGroup" = t."TransactionGroup" AND host_fee_share."type" = 'DEBIT' AND host_fee_share."kind" = 'HOST_FEE_SHARE' AND host_fee_share."deletedAt" IS NULL
      WHERE t."data"->>'fixHostFeeWithTaxes' IS NOT NULL
      AND t."kind" = 'HOST_FEE'
      AND t."deletedAt" IS NULL
      AND t."type" = 'DEBIT' -- To make sure we get the collective with 'CollectiveId'
      GROUP BY t.id, host_fee_share.id, host.id, collective.id
      ORDER BY t.id
    `,
      {
        type: sequelize.QueryTypes.SELECT,
      },
    );

    if (!results.length) {
      logger.info('No transactions fixed yet, run the "fix" command first');
      return;
    }

    const groupedByHost = groupBy(results, 'hostSlug');
    for (const [hostSlug, hostResults] of Object.entries(groupedByHost)) {
      logger.info(`==== Host ${hostSlug} ====`);
      const totalTaxes = sumBy(hostResults, 'hostFeeInHostCurrency');
      const previousTotalTaxes = sumBy(hostResults, 'previousHostFeeInHostCurrency');
      const totalRefunded = Math.abs(previousTotalTaxes - totalTaxes);
      const totalHostFeeShare = sumBy(hostResults, 'hostFeeShareInHostCurrency');
      const totalHostFeeShareExpected = sumBy(hostResults, result => {
        const rate = parseFloat(result.hostFeeSharePercent);
        return !rate ? 0 : Math.round(result.hostFeeInHostCurrency * rate);
      });

      logger.info(`Total amount refunded by script: ${formatCurrency(totalRefunded, hostResults[0].hostCurrency)}`);
      logger.info(
        `Total host fee share to refund from OC Inc to host: ${formatCurrency(
          totalHostFeeShare - totalHostFeeShareExpected,
          hostResults[0].hostCurrency,
        )}`,
      );

      const groupedByCollective = groupBy(hostResults, 'collectiveSlug');
      for (const [collectiveSlug, collectiveResults] of Object.entries(groupedByCollective)) {
        const totalTaxes = sumBy(collectiveResults, 'hostFeeInHostCurrency');
        const previousTotalTaxes = sumBy(collectiveResults, 'previousHostFeeInHostCurrency');
        const totalRefunded = Math.abs(previousTotalTaxes - totalTaxes);
        logger.info(`  - ${collectiveSlug}: ${formatCurrency(totalRefunded, collectiveResults[0].hostCurrency)}`);
      }
    }
  });

program
  .parseAsync(process.argv)
  .then(() => process.exit(0))
  .catch(e => {
    console.error(e);
    process.exit(1);
  });
