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
        limit: 30,
        where: { isActive: true },
        order: [['id', 'DESC']],
        dependencies: [
          {
            model: 'Order',
            limit: 50,
            order: [['id', 'DESC']],
          },
          {
            model: 'Expense',
            limit: 50,
            order: [['id', 'DESC']],
          },
          'Tier',
        ],
      },
      {
        model: 'Member',
        on: 'CollectiveId',
        where: {
          role: ['ADMIN', 'MEMBER', 'HOST'],
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
  Collective: ['User', 'ConnectedAccount'],
  Expense: [
    'Transaction',
    'ExpenseItem',
    'PayoutMethod',
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
  ],
  Order: [
    'Transaction',
    'PaymentMethod',
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
};

// eslint-disable-next-line import/no-commonjs
module.exports = {
  entries,
  defaultDependencies,
};
