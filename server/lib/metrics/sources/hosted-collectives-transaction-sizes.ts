import { defineRelationMetricSource } from '..';

import { AMOUNT_BAND_VALUES, CONTRIBUTION_FREQUENCY_VALUES } from './hosted-collectives-enum-values';

export const HostedCollectivesTransactionSizes = defineRelationMetricSource('HostedCollectivesDailyTransactionSizes', {
  kind: 'dense',
  dateColumn: 'day',
  dimensions: {
    host: {
      name: 'host',
      column: 'HostCollectiveId',
      kind: 'account',
    },
    account: {
      name: 'account',
      column: 'CollectiveId',
      kind: 'account',
    },
    parent: {
      name: 'parent',
      column: 'ParentCollectiveId',
      kind: 'account',
      nullable: true,
    },
    mainAccount: {
      name: 'mainAccount',
      expression: eb => eb.fn.coalesce('ParentCollectiveId', 'CollectiveId'),
      kind: 'account',
    },
    isMainAccount: {
      name: 'isMainAccount',
      expression: eb => eb('ParentCollectiveId', 'is', null),
      kind: 'boolean',
    },
    accountType: {
      name: 'accountType',
      column: 'collectiveType',
      kind: 'enum',
      description: 'The account type of the account',
    },
    kindClass: {
      name: 'kindClass',
      column: 'kindClass',
      kind: 'enumValues',
      description: 'Whether the transaction is an incoming contribution (credit) or an outgoing payout (debit).',
      values: [
        { value: 'CONTRIBUTION', description: 'Incoming contribution (credit).' },
        { value: 'PAYOUT', description: 'Outgoing payout / expense (debit).' },
      ],
    },
    contributionFrequency: {
      name: 'contributionFrequency',
      column: 'contributionFrequency',
      kind: 'enumValues',
      description: 'How a contribution recurs.',
      values: CONTRIBUTION_FREQUENCY_VALUES,
    },
    amountBand: {
      name: 'amountBand',
      column: 'amountBand',
      kind: 'enumValues',
      description: 'Transaction-size band, by absolute amount in host-currency units.',
      values: AMOUNT_BAND_VALUES,
    },
    hostCurrency: { name: 'hostCurrency', column: 'hostCurrency', kind: 'string' },
  },
  measures: {
    transactionCount: {
      name: 'transactionCount',
      aggregation: eb => eb.fn.sum<number>('transactionCount'),
      kind: 'count',
      description: 'Number of contribution/payout transactions in the band.',
    },
    amount: {
      name: 'amount',
      aggregation: eb => eb.fn.sum<bigint>('amount'),
      kind: 'amount',
      currencyColumn: 'hostCurrency',
      description: 'Total absolute amount (host currency) of the transactions in the band.',
    },
  },
});
