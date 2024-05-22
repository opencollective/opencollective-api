import '../../server/env';

import { groupBy } from 'lodash';

import models, { sequelize } from '../../server/models';

const IS_DRY = process.env.DRY !== 'false';

const getTransactions = async () => {
  return sequelize.query(
    `
    SELECT t.*
    FROM "Transactions" t
    INNER JOIN "Expenses" e ON e.id = t."ExpenseId"
    WHERE t."deletedAt" IS NULL
    AND t."ExpenseId" IS NOT NULL
    AND t."currency" = "hostCurrency"
    AND t."hostCurrencyFxRate" != 1
    order by t."createdAt" DESC
  `,
    {
      type: sequelize.QueryTypes.SELECT,
      model: models.Transaction,
      mapToModel: true,
    },
  );
};

// List of collectives where neither the host nor the collective currency changed
const COLLECTIVES_WITH_STABLE_CURRENCY = [
  'opencollective', // Never changed currency
  'huneeds', // Never changed currency
  'flarum', // Switched from USD to EUR in 2019, but buggy expenses are all from 2020
  'kendraio', // Changed currency in 2019, expense's from 2021
  'xr-belgium', // Changed currency in 2019, expense's from 2021
  'sunbeam-city', // Changed currency in 2018, expense's from 2021
  'tealwiki', // Changed currency in 2018, expense's from 2019
];

const main = async (): Promise<void> => {
  if (IS_DRY) {
    console.log('Running in DRY mode! To mutate data set DRY=false when calling this script.');
  }

  const transactions = await getTransactions();
  if (!transactions.length) {
    console.log('No transactions to fix!');
    process.exit(0);
  }

  const transactionPairs = groupBy(transactions, t => t.TransactionGroup);
  for (const [group, transactions] of Object.entries(transactionPairs)) {
    // No case like this in DB, but just in case...
    if (transactions.length !== 2) {
      console.log(`Transaction group ${group} has ${transactions.length} transactions, skipping...`);
      continue;
    }

    // Update all amounts
    const credit = transactions.find(t => t.type === 'CREDIT');
    const debit = transactions.find(t => t.type === 'DEBIT');
    const collective = await debit.getCollective({ include: [{ association: 'host' }] });

    if (COLLECTIVES_WITH_STABLE_CURRENCY.includes(collective.slug)) {
      // If there was only one currency involved, we can assume that amounts were right, only the conversation rate was wrong
      debit.hostCurrencyFxRate = 1;
      debit.amountInHostCurrency = debit.amount;
      debit.netAmountInCollectiveCurrency = debit.amount + debit.paymentProcessorFeeInHostCurrency;

      credit.hostCurrencyFxRate = 1;
      credit.amountInHostCurrency = credit.amount;
      credit.amount = Math.abs(debit.netAmountInCollectiveCurrency);
      credit.amountInHostCurrency = credit.amount;
      credit.netAmountInCollectiveCurrency = Math.abs(debit.amount);
    } else {
      // None case like this in DB
      console.log(`Need to fix transaction group ${group}!`);
    }

    // Some of them were not set, `validate` does not like that
    debit.hostFeeInHostCurrency = debit.hostFeeInHostCurrency || 0;
    debit.platformFeeInHostCurrency = debit.platformFeeInHostCurrency || 0;
    credit.hostFeeInHostCurrency = credit.hostFeeInHostCurrency || 0;
    credit.platformFeeInHostCurrency = credit.platformFeeInHostCurrency || 0;

    // Validate
    try {
      await models.Transaction.validate(debit, { validateOppositeTransaction: false });
      await models.Transaction.validate(credit, { validateOppositeTransaction: false });
    } catch (e) {
      console.error(`Failed to validate transaction group ${group}: ${e.message}`);
    }

    // Save
    if (!IS_DRY) {
      console.log(`Saving transaction group ${group}...`);
      await Promise.all(transactions.map(t => t.save()));
    } else {
      console.log(
        `DRY: would have updated transaction group ${group} (host=${collective.host.slug}, collective=${collective.slug})`,
      );
    }
  }
};

main()
  .then(() => process.exit(0))
  .catch(e => {
    console.error(e);
    process.exit(1);
  });
