import { get, result } from 'lodash';

import { createRefundTransaction } from '../../lib/payments';
import stripe, { extractFees, retrieveChargeWithRefund } from '../../lib/stripe';
import models from '../../models';

/** Refund a given transaction */
export const refundTransaction = async (
  transaction: typeof models.Transaction,
  user: typeof models.User,
  options?: { checkRefundStatus: boolean },
): Promise<typeof models.Transaction> => {
  /* What's going to be refunded */
  const chargeId = result(transaction.data, 'charge.id');
  if (transaction.data?.refund?.status === 'pending') {
    throw new Error(`Transaction #${transaction.id} refund was already requested and it is pending`);
  }

  /* From which stripe account it's going to be refunded */
  const collective = await models.Collective.findByPk(
    transaction.type === 'CREDIT' ? transaction.CollectiveId : transaction.FromCollectiveId,
  );
  const hostStripeAccount = await collective.getHostStripeAccount();

  /* Refund both charge & application fee */
  const fees = get(transaction.data, 'balanceTransaction.fee_details', []);
  const hasApplicationFees = fees.some(fee => fee.type === 'application_fee' && fee.amount > 0);
  const refund = await stripe.refunds.create(
    { charge: chargeId, refund_application_fee: hasApplicationFees }, // eslint-disable-line camelcase
    { stripeAccount: hostStripeAccount.username },
  );

  if (options?.checkRefundStatus && refund.status !== 'succeeded') {
    await transaction.update({ data: { ...transaction.data, refund } });
    return null;
  }

  const charge = await stripe.charges.retrieve(chargeId, { stripeAccount: hostStripeAccount.username });
  const refundBalance = await stripe.balanceTransactions.retrieve(refund.balance_transaction, {
    stripeAccount: hostStripeAccount.username,
  });
  const refundedFees = extractFees(refundBalance, refundBalance.currency);

  /* Create negative transactions for the received transaction */
  return await createRefundTransaction(
    transaction,
    refundedFees.stripeFee, // TODO: Ignoring `other` fees here could be a problem
    {
      ...transaction.data,
      refund,
      balanceTransaction: refundBalance, // TODO: This is overwriting the original balanceTransaction with the refund balance transaction, which remove important info
      charge,
    },
    user,
  );
};

/** Refund a given transaction that was already refunded
 * in stripe but not in our database
 */
export const refundTransactionOnlyInDatabase = async (
  transaction: typeof models.Transaction,
  user: typeof models.User,
): Promise<typeof models.Transaction> => {
  /* What's going to be refunded */
  const chargeId = result(transaction.data, 'charge.id');

  /* From which stripe account it's going to be refunded */
  const collective = await models.Collective.findByPk(
    transaction.type === 'CREDIT' ? transaction.CollectiveId : transaction.FromCollectiveId,
  );
  const hostStripeAccount = await collective.getHostStripeAccount();

  /* Refund both charge & application fee */
  const { charge, refund, dispute } = await retrieveChargeWithRefund(chargeId, hostStripeAccount);
  if (!refund && !dispute) {
    throw new Error('No refund or dispute found in Stripe.');
  }
  const refundBalance = await stripe.balanceTransactions.retrieve((refund || dispute).balance_transaction, {
    stripeAccount: hostStripeAccount.username,
  });
  const fees = extractFees(refundBalance, refundBalance.currency);

  /* Create negative transactions for the received transaction */
  return await createRefundTransaction(
    transaction,
    refund ? fees.stripeFee : 0, // With disputes, we get 1500 as a value but will not handle this
    { ...transaction.data, charge, refund, balanceTransaction: refundBalance },
    user,
  );
};
