import { ModelNames, RecipeItem } from '../../server/lib/import-export/types';

const entries: RecipeItem[] = [
  {
    model: 'Collective',
    where: {
      slug: ['engineering'],
    },
    dependencies: [
      { model: 'Agreement', on: 'CollectiveId' },
      { model: 'AccountingCategory', on: 'CollectiveId' },
      {
        model: 'Transaction',
        on: 'CollectiveId',
        dependencies: [
          {
            model: 'Collective',
            from: 'FromCollectiveId',
          },
        ],
      },
      {
        model: 'Transaction',
        on: 'FromCollectiveId',
        dependencies: [
          {
            model: 'Collective',
            from: 'CollectiveId',
          },
        ],
      },
      { model: 'PayoutMethod', on: 'CollectiveId' },
      { model: 'PaymentMethod', on: 'CollectiveId' },
      { model: 'ConnectedAccount', on: 'CollectiveId' },
      {
        model: 'Order',
        on: 'CollectiveId',
      },
      {
        model: 'Order',
        on: 'FromCollectiveId',
      },
      {
        model: 'Expense',
        on: 'CollectiveId',
      },
      {
        model: 'Expense',
        on: 'FromCollectiveId',
      },
      { model: 'Tier', on: 'CollectiveId' },
      { model: 'Update', on: 'CollectiveId' },
      {
        model: 'Collective',
        on: 'ParentCollectiveId',
      },
      {
        model: 'Collective',
        from: 'HostCollectiveId',
      },
      {
        model: 'Member',
        on: 'CollectiveId',
      },
      {
        model: 'Member',
        on: 'MemberCollectiveId',
      },
      {
        model: 'User',
        on: 'CollectiveId',
        dependencies: [
          {
            model: 'Expense',
            on: 'UserId',
          },
        ],
      },
    ],
  },
];

const defaultDependencies: Partial<Record<ModelNames, RecipeItem[]>> = {
  Collective: [
    { model: 'User', from: 'CreatedByUserId' },
    { model: 'SocialLink', on: 'CollectiveId' },
  ],
  Activity: [
    { model: 'Collective', from: 'FromCollectiveId' },
    { model: 'Collective', from: 'CollectiveId' },
  ],
  Member: [
    {
      model: 'Collective',
      from: 'MemberCollectiveId',
    },
  ],
  Expense: [
    { model: 'Transaction', on: 'ExpenseId' },
    { model: 'ExpenseItem', on: 'ExpenseId' },
    { model: 'ExpenseAttachedFile', on: 'ExpenseId' },
    { model: 'PaymentMethod', from: 'PaymentMethodId' },
    { model: 'PayoutMethod', from: 'PayoutMethodId' },
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
