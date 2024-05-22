import '../../server/env';

import { floatAmountToCents } from '../../server/lib/math';
import models, { sequelize } from '../../server/models';

const IS_DRY = process.env.DRY !== 'false';

const getTransactions = async () => {
  return sequelize.query(
    `
        SELECT t.*
        FROM "Transactions" t
        WHERE t.kind = 'EXPENSE'
        AND t.type = 'DEBIT'
        AND t."PaymentMethodId" IS NOT NULL -- Adaptive
        AND t."data" -> 'createPaymentResponse' IS NOT NULL
        AND t."data" -> 'createPaymentResponse' -> 'defaultFundingPlan' ->> 'senderFees' IS NULL
        ORDER BY t.id ASC
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
    console.log('For now this will only generate a CSV file.');
    console.log('Host;Expense;Total Amount;Gross amount;Fees;Fee Percent');
  }

  for (const debitTransaction of transactions) {
    const host = await debitTransaction.getHostCollective();
    const collective = await debitTransaction.getCollective();
    const expense = await debitTransaction.getExpense();
    const { defaultFundingPlan } = debitTransaction.data.createPaymentResponse;

    // First approach was to fetch the transaction details from PayPal, but upon further verification
    // all amounts (paymentInfo.receiver.amount) are equal to the gross expense amount, so we can use that
    // const paymentDetails = await paypalAdaptive.paymentDetails({ payKey: debitTransaction.data.createPaymentResponse });
    // const paymentInfo = paymentDetails.paymentInfoList.paymentInfo[0];
    // const amountReceivedByPayee = floatAmountToCents(parseFloat(paymentInfo.receiver.amount));

    // Compute fees by looking at the amount paid by the host VS the expense amount
    const amountReceivedByPayee = expense.amount;
    const amountPaidByHost = floatAmountToCents(parseFloat(defaultFundingPlan.fundingAmount.amount));
    const paymentProcessorFee = amountPaidByHost - amountReceivedByPayee;
    const feePercent = (paymentProcessorFee / amountPaidByHost) * 100;

    // Update transactions
    const creditTransaction = await debitTransaction.getOppositeTransaction();
    const migrationName = '2022-11-25-fix-adaptive-processor-fee';

    debitTransaction.data.migration = migrationName;
    debitTransaction.paymentProcessorFeeInHostCurrency = paymentProcessorFee;
    debitTransaction.netAmountInCollectiveCurrency = -amountPaidByHost;

    creditTransaction.amount = amountPaidByHost;
    debitTransaction.paymentProcessorFeeInHostCurrency = paymentProcessorFee;
    creditTransaction.amountInHostCurrency = amountPaidByHost;

    // Validate / log if dry
    if (IS_DRY) {
      // Validate new transactions data
      try {
        await creditTransaction.validate({ validateOppositeTransaction: false });
        await debitTransaction.validate({ validateOppositeTransaction: false });
      } catch (e) {
        console.warn(`Error validating transactions for expense ${expense.id}: ${e.message}`);
      }

      // Log CSV entry
      console.log(
        [
          `https://opencollective.com/${host.slug}`,
          `https://opencollective.com/${collective.slug}/expenses/${debitTransaction.ExpenseId}`,
          amountPaidByHost,
          amountReceivedByPayee,
          paymentProcessorFee,
          feePercent,
        ].join(';'),
      );
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
