const entries = [
  {
    model: 'Collective',
    where: {
      slug: ['opencollective', 'foundation', 'opensource', 'ocnz', 'europe'],
    },
    dependencies: [
      'PaymentMethod',
      'PayoutMethod',
      'ConnectedAccount',
      {
        model: 'Collective',
        on: 'HostCollectiveId',
        limit: 20,
        dependencies: [
          {
            model: 'Order',
            limit: 50,
            dependencies: [
              'Transaction',
              {
                model: 'Collective',
                from: 'CollectiveId',
              },
              {
                model: 'Collective',
                from: 'FromCollectiveId',
              },
              {
                model: 'Subscription',
                from: 'SubscriptionId',
              },
            ],
          },
          {
            model: 'Expense',
            limit: 50,
            dependencies: [
              {
                model: 'Collective',
                from: 'CollectiveId',
              },
              {
                model: 'Collective',
                from: 'FromCollectiveId',
              },
              {
                model: 'RecurringExpense',
                from: 'RecurringExpenseId',
              },
              'Transaction',
              'ExpenseItem',
            ],
          },
          'Tier',
        ],
      },
      {
        model: 'Member',
        on: 'CollectiveId',
        where: {
          role: 'ADMIN',
        },
        dependencies: [
          {
            model: 'Collective',
            from: 'MemberCollectiveId',
          },
        ],
      },
    ],
  },
];

const defaultDependencies = {
  Collective: ['User', 'PaymentMethod', 'PayoutMethod', 'ConnectedAccount'],
};

// eslint-disable-next-line import/no-commonjs
module.exports = {
  entries,
  defaultDependencies,
};
