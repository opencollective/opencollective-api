import { ModelNames, RecipeItem } from '../../server/lib/import-export/types';

const basicDependencies: RecipeItem[] = [
  { model: 'PayoutMethod', on: 'CollectiveId' },
  { model: 'PaymentMethod', on: 'CollectiveId' },
  { model: 'ConnectedAccount', on: 'CollectiveId' },
  {
    model: 'Order',
    on: 'CollectiveId',
    limit: 200,
    order: [['id', 'DESC']],
  },
  {
    model: 'Expense',
    on: 'CollectiveId',
    limit: 200,
    order: [['id', 'DESC']],
  },
  { model: 'Tier', on: 'CollectiveId' },
  { model: 'Update', on: 'CollectiveId' },
  {
    model: 'Collective',
    on: 'ParentCollectiveId',
  },
  {
    model: 'Member',
    on: 'CollectiveId',
  },
  { model: 'Agreement', on: 'CollectiveId' },
];

const entries: RecipeItem[] = [
  {
    model: 'Collective',
    where: {
      HostCollectiveId: [11004],
      deletedAt: null,
      isActive: true,
    },
    limit: 200,
    dependencies: [...basicDependencies],
  },
  {
    model: 'Collective',
    where: {
      HostCollectiveId: [9807],
      deletedAt: null,
      isActive: true,
    },
    limit: 200,
    dependencies: [...basicDependencies],
  },
  {
    model: 'Collective',
    where: {
      slug: ['opensource', 'ofico', 'ofitech', 'europe'],
    },
    dependencies: [{ model: 'AccountingCategory', on: 'CollectiveId' }, ...basicDependencies],
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
