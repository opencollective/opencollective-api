const entries = [
  {
    model: 'Collective',
    where: {
      slug: ['opencollective', 'opensource', 'europe'],
    },
    dependencies: [
      { model: 'PayoutMethod', on: 'CollectiveId' },
      { model: 'PaymentMethod', on: 'CollectiveId' },
      { model: 'ConnectedAccount', on: 'CollectiveId' },
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
            where: { data: { isGuest: null } },
          },
          {
            model: 'Expense',
            limit: 50,
            order: [['id', 'DESC']],
          },
          { model: 'Tier', on: 'CollectiveId' },
          { model: 'Update', on: 'CollectiveId' },
        ],
      },
      {
        model: 'Member',
        on: 'CollectiveId',
        where: {
          role: ['ADMIN', 'HOST'],
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
      },
      {
        model: 'Activity',
        on: 'FromCollectiveId',
        limit: 50,
        order: [['id', 'DESC']],
      },
    ],
  },
];

const defaultDependencies = {
  Collective: [
    { model: 'ConnectedAccount', on: 'CollectiveId' },
    { model: 'User', from: 'CreatedByUserId' },
    { model: 'Member', on: 'CollectiveId' },
  ],
  Activity: [[{ model: 'Collective', from: 'FromCollectiveId' }], [{ model: 'Collective', from: 'CollectiveId' }]],
  Member: [
    {
      model: 'Collective',
      from: 'MemberCollectiveId',
    },
  ],
  Expense: [
    { model: 'Transaction', on: 'ExpenseId' },
    { model: 'ExpenseItem', on: 'ExpenseId' },
    { model: 'PayoutMethod', from: 'PayoutMethodId' },
    { model: 'PaymentMethod', from: 'PaymentMethodId' },
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
    { model: 'Transaction', on: 'OrderId' },
    { model: 'PaymentMethod', from: 'PaymentMethodId' },
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
};

// eslint-disable-next-line import/no-commonjs
module.exports = {
  entries,
  defaultDependencies,
};
