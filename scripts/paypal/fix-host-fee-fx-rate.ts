import '../../server/env';

import models, { sequelize } from '../../server/models';

const IS_DRY = process.env.DRY !== 'false';

const getTransactions = async () => {
  return sequelize.query(
    `
      SELECT t.*
      FROM "Transactions" t 
      INNER JOIN "Orders" o ON t."OrderId" = o.id
      INNER JOIN "PaymentMethods" pm ON t."PaymentMethodId" = pm.id
      INNER JOIN "Collectives" h ON h.id = t."HostCollectiveId"
      INNER JOIN "Collectives" c ON c.id = o."CollectiveId"
      WHERE t."hostCurrency" != t.currency
      AND "hostFeeInHostCurrency" < 0
      AND t.kind = 'CONTRIBUTION'
      AND pm.service = 'paypal'
      AND t.type = 'CREDIT'
    `,
    {
      type: sequelize.QueryTypes.SELECT,
      model: models.Transaction,
      mapToModel: true,
    },
  );
};

/**
 * Address a bug where we did not record the processor fee for Adaptive payments.
 * This script takes a few shortcuts based on analysis of the data:
 * - There are no refunded expenses in this batch
 * - All amounts are correctly stored in transactions data
 */
const main = async (): Promise<void> => {
  const transactions = await getTransactions();
  if (!transactions.length) {
    console.log('No transactions to fix!');
    process.exit(0);
  }

  if (IS_DRY) {
    console.log('Running in DRY mode! To mutate data set DRY=false when calling this script.');
  }

  for (const creditTransaction of transactions) {
    const debitTransaction = await creditTransaction.getOppositeTransaction();
    const migrationName = '2022-11-25-fix-host-fee-fx-rate';
    const oldFee = creditTransaction.hostFeeInHostCurrency;
    const newFee = Math.round(oldFee * creditTransaction.hostCurrencyFxRate);

    debitTransaction.data.migration = migrationName;
    creditTransaction.data.migration = migrationName;

    debitTransaction.hostFeeInHostCurrency = Math.round(newFee);
    creditTransaction.hostFeeInHostCurrency = Math.round(newFee);

    // Validate / log if dry
    if (IS_DRY) {
      try {
        await creditTransaction.validate({ validateOppositeTransaction: false });
        await debitTransaction.validate({ validateOppositeTransaction: false });
        console.log(
          `Would update transaction ${creditTransaction.id} and ${debitTransaction.id}: ${oldFee} -> ${newFee}`,
        );
      } catch (e) {
        console.warn(`Error validating transactions ${creditTransaction.TransactionGroup}: ${e.message}`);
      }
    } else {
      // Update transactions
      await Promise.all([debitTransaction.save(), creditTransaction.save()]);
    }
  }
};

main()
  .then(() => process.exit(0))
  .catch(e => {
    console.error(e);
    process.exit(1);
  });
