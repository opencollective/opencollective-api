/**
 * This script can be used whenever PayPal webhooks event types change to update
 * Host's connected accounts.
 */

import '../../server/env';

import { Command } from 'commander';
import { cloneDeep } from 'lodash';

import models from '../../server/models';
import {
  fetchPaypalSubscription,
  fetchPaypalTransactionsForSubscription,
} from '../../server/paymentProviders/paypal/subscription';

const main = async (): Promise<void> => {
  const program = new Command();
  program.showSuggestionAfterError();

  // General options
  program
    .command('check <hostSlug> <subscriptionId>')
    .description('Check the status of a PayPal subscription')
    .action(checkSubscription);

  await program.parseAsync();
};

const checkSubscription = async (hostSlug: string, subscriptionId: string): Promise<void> => {
  const host = await models.Collective.findBySlug(hostSlug);
  if (!host) {
    throw new Error(`Host not found: ${hostSlug}`);
  }

  const subscription = await fetchPaypalSubscription(host, subscriptionId);
  console.log('Subscription:');
  console.log(subscription);
  console.log('-------');

  const result = await fetchPaypalTransactionsForSubscription(host, subscriptionId);
  const prettyTransactions: Record<string, unknown>[] = cloneDeep(result.transactions);
  prettyTransactions.forEach(t => (t['amount_with_breakdown'] = JSON.stringify(t.amount_with_breakdown)));
  console.log('Transactions:');
  console.table(prettyTransactions);
  console.log('-------');
};

main()
  .then(() => process.exit(0))
  .catch(e => {
    console.error(e);
    process.exit(1);
  });
