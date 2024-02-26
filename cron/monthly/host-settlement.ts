#!/usr/bin/env node
import '../../server/env';

import { Parser } from '@json2csv/plainjs';
import config from 'config';
import { groupBy, sumBy } from 'lodash';
import moment from 'moment';

import activityType from '../../server/constants/activities';
import expenseStatus from '../../server/constants/expense-status';
import expenseTypes from '../../server/constants/expense-type';
import { TransactionKind } from '../../server/constants/transaction-kind';
import { SETTLEMENT_EXPENSE_PROPERTIES } from '../../server/constants/transactions';
import { getTransactionsCsvUrl } from '../../server/lib/csv';
import { getPendingHostFeeShare, getPendingPlatformFees, getPendingPlatformTips } from '../../server/lib/host-metrics';
import { reportErrorToSentry, reportMessageToSentry } from '../../server/lib/sentry';
import { parseToBoolean } from '../../server/lib/utils';
import models, { sequelize } from '../../server/models';
import { PayoutMethodTypes } from '../../server/models/PayoutMethod';

const json2csv = (data, opts = undefined) => new Parser(opts).parse(data);

const today = moment.utc();

const defaultDate = process.env.START_DATE ? moment.utc(process.env.START_DATE) : moment.utc();

const DRY = process.env.DRY;
const HOST_ID = process.env.HOST_ID;
const isProduction = config.env === 'production';
const { PLATFORM_TIP_DEBT, HOST_FEE_SHARE_DEBT, PLATFORM_FEE_DEBT } = TransactionKind;

// Only run on the 1th of the month
if (isProduction && new Date().getDate() !== 1 && !process.env.OFFCYCLE) {
  console.log('OC_ENV is production and today is not the 1st of month, script aborted!');
  process.exit();
} else if (parseToBoolean(process.env.SKIP_HOST_SETTLEMENT)) {
  console.log('Skipping because SKIP_HOST_SETTLEMENT is set.');
  process.exit();
}

if (DRY) {
  console.info('Running dry, changes are not going to be persisted to the DB.');
}

export async function run(baseDate: Date | moment.Moment = defaultDate): Promise<void> {
  const momentDate = moment(baseDate).subtract(1, 'month');
  const year = momentDate.year();
  const month = momentDate.month();
  const startDate = new Date(year, month, 1);
  const endDate = new Date(year, month + 1, 1);

  console.info(`Invoicing hosts pending fees and tips for ${momentDate.format('MMMM')}.`);

  const payoutMethods = groupBy(
    await models.PayoutMethod.findAll({
      where: { CollectiveId: SETTLEMENT_EXPENSE_PROPERTIES.FromCollectiveId, isSaved: true },
    }),
    'type',
  );
  const settlementBankAccountPayoutMethod = payoutMethods[PayoutMethodTypes.BANK_ACCOUNT].find(
    pm => pm.data?.['currency'] === 'USD',
  );

  const hosts = await sequelize.query(
    `
      SELECT c.*
      FROM "Collectives" c
      INNER JOIN "Transactions" t ON t."HostCollectiveId" = c.id AND t."deletedAt" IS NULL
      WHERE c."isHostAccount" IS TRUE
      AND t."createdAt" >= :startDate AND t."createdAt" < :endDate
      AND c.id != 8686 -- Make sure we don't invoice OC Inc as reverse settlements are not supported yet
      GROUP BY c.id
    `,
    {
      mapToModel: true,
      type: sequelize.QueryTypes.SELECT,
      model: models.Collective,
      replacements: { startDate: startDate, endDate: endDate },
    },
  );

  for (const host of hosts) {
    if (HOST_ID && host.id !== parseInt(HOST_ID)) {
      continue;
    }

    const pendingPlatformTips = await getPendingPlatformTips(host, { status: ['OWED'], endDate });
    const pendingHostFeeShare = await getPendingHostFeeShare(host, { status: ['OWED'], endDate });
    const pendingPlatformFees = await getPendingPlatformFees(host, { status: ['OWED'], endDate });

    const plan = await host.getPlan();

    let items = [];

    const transactions = await sequelize.query(
      `
      SELECT t.*
      FROM "Transactions" as t
      INNER JOIN "TransactionSettlements" ts ON ts."TransactionGroup" = t."TransactionGroup" AND t.kind = ts.kind
      WHERE t."CollectiveId" = :CollectiveId
        AND t."kind" IN ('PLATFORM_TIP_DEBT', 'HOST_FEE_SHARE_DEBT', 'PLATFORM_FEE_DEBT')
        AND t."isDebt" IS TRUE
        AND t."deletedAt" IS NULL
        AND ts."status" = 'OWED'
        AND t."createdAt" < :endDate
      `,
      {
        replacements: { CollectiveId: host.id, endDate: endDate },
        model: models.Transaction,
        mapToModel: true, // pass true here if you have any mapped fields
      },
    );

    if (pendingPlatformTips) {
      items.push({
        incurredAt: new Date(),
        amount: pendingPlatformTips,
        currency: host.currency,
        description: 'Platform Tips',
      });
    }

    if (pendingPlatformFees) {
      items.push({
        incurredAt: new Date(),
        amount: pendingPlatformFees,
        currency: host.currency,
        description: 'Platform Fees',
      });
    }

    if (pendingHostFeeShare) {
      items.push({
        incurredAt: new Date(),
        amount: pendingHostFeeShare,
        currency: host.currency,
        description: 'Shared Revenue',
      });
    }

    if (plan.pricePerCollective) {
      const activeHostedCollectives = await host.getHostedCollectivesCount();
      const amount = (activeHostedCollectives || 0) * plan.pricePerCollective;
      if (amount) {
        items.push({
          incurredAt: new Date(),
          amount,
          currency: host.currency,
          description: 'Fixed Fee per Hosted Collective',
        });
      }
    }

    const totalAmountCharged = sumBy(items, 'amount');

    if (totalAmountCharged < 1000) {
      console.warn(
        `${host.name} (#${host.id}) skipped, total amount pending ${totalAmountCharged / 100} < 10.00 ${
          host.currency
        }.\n`,
      );
      continue;
    }
    console.info(
      `${host.name} (#${host.id}) has ${transactions.length} pending transactions and owes ${
        totalAmountCharged / 100
      } (${host.currency})`,
    );

    const connectedAccounts = await host.getConnectedAccounts({
      where: { deletedAt: null },
    });

    let payoutMethod = payoutMethods[PayoutMethodTypes.OTHER]?.[0] || settlementBankAccountPayoutMethod;
    if (connectedAccounts?.find(c => c.service === 'transferwise') && settlementBankAccountPayoutMethod) {
      payoutMethod = settlementBankAccountPayoutMethod;
    } else if (
      connectedAccounts?.find(c => c.service === 'paypal') &&
      !host.settings?.disablePaypalPayouts &&
      payoutMethods[PayoutMethodTypes.PAYPAL]?.[0]
    ) {
      payoutMethod = payoutMethods[PayoutMethodTypes.PAYPAL]?.[0];
    }

    if (!payoutMethod) {
      console.error('No Payout Method found, Open Collective Inc. needs to have at least one payout method.');
      reportMessageToSentry('No Payout Method found, Open Collective Inc. needs to have at least one payout method.');
      process.exit();
    }

    const transactionIds = transactions.map(t => t.id);
    const expenseData = {
      ...SETTLEMENT_EXPENSE_PROPERTIES,
      PayoutMethodId: payoutMethod.id,
      amount: totalAmountCharged,
      CollectiveId: host.id,
      currency: host.currency,
      description: `Platform settlement for ${momentDate.utc().format('MMMM')}`,
      incurredAt: today.toDate(),
      // isPlatformTipSettlement is deprecated but we keep it for now, we should rely on type=SETTLEMENT
      data: { isPlatformTipSettlement: true, transactionIds },
      type: expenseTypes.SETTLEMENT,
      status: expenseStatus.PENDING,
    };
    if (DRY) {
      console.debug(`Expense:\n${JSON.stringify(expenseData, null, 2)}`);
      console.debug(`Items:\n${json2csv(items)}\n`);
    } else {
      // Create the Expense
      const expense = await models.Expense.create(expenseData);

      // Create Expense Items
      items = items.map(i => ({
        ...i,
        ExpenseId: expense.id,
        CreatedByUserId: SETTLEMENT_EXPENSE_PROPERTIES.UserId,
      }));
      await models.ExpenseItem.bulkCreate(items);

      // Attach CSV
      const csvUrl = getTransactionsCsvUrl('transactions', host, {
        startDate,
        endDate,
        kind: [PLATFORM_TIP_DEBT, HOST_FEE_SHARE_DEBT, PLATFORM_FEE_DEBT],
        add: ['orderLegacyId'],
      });
      if (csvUrl) {
        await models.ExpenseAttachedFile.create({
          url: csvUrl,
          ExpenseId: expense.id,
          CreatedByUserId: SETTLEMENT_EXPENSE_PROPERTIES.UserId,
        });
      }

      // Mark transactions as invoiced
      await models.TransactionSettlement.markTransactionsAsInvoiced(transactions, expense.id);
      await expense.createActivity(activityType.COLLECTIVE_EXPENSE_CREATED);
    }
  }
}

if (require.main === module) {
  run(defaultDate)
    .catch(e => {
      console.error(e);
      reportErrorToSentry(e);
      process.exit(1);
    })
    .then(() => {
      process.exit();
    });
}
