import { defineRelationMetricSource } from '..';

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
      kind: 'enum',
      description: 'Whether the transaction is a CONTRIBUTION (credit) or a PAYOUT (debit).',
    },
    contributionFrequency: {
      name: 'contributionFrequency',
      column: 'contributionFrequency',
      kind: 'enum',
      description: 'Frequency class: ONE_TIME, RECURRING, ADDED_FUNDS; OTHER for payouts / non-contribution credits.',
    },
    amountBand: {
      name: 'amountBand',
      column: 'amountBand',
      kind: 'string',
      description: 'Human label for the transaction-size band (e.g. `<5`, `<100`, `>=50k`) in host currency units.',
    },
    amountBandIndex: {
      name: 'amountBandIndex',
      column: 'amountBandIndex',
      kind: 'int',
      description: 'Ordinal (0–16) of the transaction-size band, smallest first. Use to order the histogram.',
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
