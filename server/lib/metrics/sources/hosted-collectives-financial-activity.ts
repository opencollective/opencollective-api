import { defineRelationMetricSource } from '..';

export const HostedCollectivesFinancialActivity = defineRelationMetricSource(
  'HostedCollectivesDailyFinancialActivity',
  {
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
      mainAccountType: {
        name: 'mainAccountType',
        column: 'mainAccountType',
        kind: 'enum',
        description: 'The account type of the parent account',
      },
      isArchived: {
        name: 'isArchived',
        column: 'isArchived',
        kind: 'boolean',
        description: 'Whether the account was archived',
      },
      mainAccountIsArchived: {
        name: 'mainAccountIsArchived',
        column: 'mainAccountIsArchived',
        kind: 'boolean',
        description: 'Whether the main parent account was archived',
      },
      contributionFrequency: {
        name: 'contributionFrequency',
        column: 'contributionFrequency',
        kind: 'enum',
        description:
          'Frequency class of the contribution: ONE_TIME, RECURRING (order has an interval), ADDED_FUNDS; ' +
          'OTHER for payouts and non-contribution credits.',
      },
      hostCurrency: { name: 'hostCurrency', column: 'hostCurrency', kind: 'string' },
    },
    measures: {
      amountReceived: {
        name: 'amountReceived',
        aggregation: eb => eb.fn.sum<bigint>('amountReceived'),
        kind: 'amount',
        currencyColumn: 'hostCurrency',
        description:
          'Amount received in host currency, sums credit transactions, excluding refunds, refunded transactions and internal transfers.\n' +
          'Matches values returned from hostStats.totalAmountReceived(net: false).',
      },
      amountReceivedNet: {
        name: 'amountReceivedNet',
        aggregation: eb => eb.fn.sum<bigint>('amountReceivedNet'),
        kind: 'amount',
        currencyColumn: 'hostCurrency',
        description:
          'Net amount received in host currency, sums credit transactions with fees and taxes included, excluding refunds, refunded transactions and internal transfers.\n' +
          'Matches values returned from hostStats.totalAmountReceived(net: true).',
      },
      amountSpent: {
        name: 'amountSpent',
        aggregation: eb => eb.fn.sum<bigint>('amountSpent'),
        kind: 'amount',
        currencyColumn: 'hostCurrency',
        description:
          'Amount spent in host currency, sums debit transactions, excluding refunds, refunded transactions and internal transfers.' +
          'Matches values returned from hostStats.totalAmountSpent(net: false).',
      },
      amountSpentNet: {
        name: 'amountSpentNet',
        aggregation: eb => eb.fn.sum<bigint>('amountSpentNet'),
        kind: 'amount',
        currencyColumn: 'hostCurrency',
        description:
          'Net amount spent in host currency, sums debit transactions with fees and taxes included, excluding refunds, refunded transactions and internal transfers.' +
          'Matches values returned from hostStats.totalAmountSpent(net: true).',
      },
      transactionCount: {
        name: 'transactionCount',
        aggregation: eb => eb.fn.sum<number>('transactionCount'),
        kind: 'count',
        description: 'Total number of transactions in the queried scope.',
      },
      contributionsCount: {
        name: 'contributionsCount',
        aggregation: eb => eb.fn.sum<number>('contributionsCount'),
        kind: 'count',
        description:
          'Number of contribution (CREDIT) transactions, excluding refunds, refunded transactions and internal transfers.\n' +
          'Matches the count behind `amountReceived`.',
      },
      payoutsCount: {
        name: 'payoutsCount',
        aggregation: eb => eb.fn.sum<number>('payoutsCount'),
        kind: 'count',
        description:
          'Number of payout (DEBIT) transactions, excluding host/processor fees, refunds, refunded transactions and internal transfers.\n' +
          'Matches the count behind `amountSpent`.',
      },
      activeCollectives: {
        name: 'activeCollectives',
        aggregation: eb => eb.fn.count(eb.fn.coalesce('ParentCollectiveId', 'CollectiveId')).distinct(),
        kind: 'count',
        description:
          'Distinct main accounts with at least one transaction of any kind. Child events/projects roll up to their parent.',
      },
      lastActiveDate: {
        name: 'lastActiveDate',
        aggregation: eb => eb.fn.max('day'),
        kind: 'date',
        description: 'Most recent date with any ledger activity, as `YYYY-MM-DD`.',
      },
    },
  },
);
