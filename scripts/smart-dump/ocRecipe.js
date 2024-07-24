const entries = [
  {
    model: 'Collective',
    where: {
      slug: ['opencollective'],
    },
    dependencies: [
      'PaymentMethod',
      'PayoutMethod',
      'ConnectedAccount',
      {
        model: 'Collective',
        on: 'HostCollectiveId',
        where: { isActive: true, deletedAt: null },
        order: [['id', 'DESC']],
        dependencies: [
          {
            model: 'Order',
            limit: 50,
            order: [['id', 'DESC']],
            where: { data: { isGuest: null } },
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
      {
        model: 'Activity',
        on: 'CollectiveId',
        limit: 50,
        order: [['id', 'DESC']],
        dependencies: [{ model: 'Collective', from: 'FromCollectiveId' }],
      },
      {
        model: 'Activity',
        on: 'FromCollectiveId',
        limit: 50,
        order: [['id', 'DESC']],
        dependencies: [{ model: 'Collective', from: 'CollectiveId' }],
      },
    ],
  },
];

const defaultDependencies = {
  Collective: ['ConnectedAccount', { model: 'User', from: 'CreatedByUserId' }],
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
    { model: 'Activity', on: 'ExpenseId' },
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
    { model: 'Activity', on: 'OrderId' },
  ],
  Transaction: [
    { model: 'Transaction', where: record => ({ TransactionGroup: record.TransactionGroup }) },
    {
      model: 'Collective',
      from: 'CollectiveId',
    },
    {
      model: 'Collective',
      from: 'FromCollectiveId',
    },
  ],
};

// eslint-disable-next-line import/no-commonjs
module.exports = {
  entries,
  defaultDependencies,
};
