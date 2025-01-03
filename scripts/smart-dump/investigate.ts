import { compact } from 'lodash';

import { ModelNames, RecipeItem } from '../../server/lib/import-export/types';

const expenses = process.env.EXPENSES ? process.env.EXPENSES.split(',') : [];
const orders = process.env.ORDERS ? process.env.ORDERS.split(',') : [];
const transactions = process.env.TRANSACTIONS ? process.env.TRANSACTIONS.split(',') : [];

const entries: RecipeItem[] = compact([
  expenses.length > 0 && {
    model: 'Expense',
    where: { id: expenses },
  },
  orders.length > 0 && {
    model: 'Order',
    where: { id: orders },
  },
  transactions.length > 0 && {
    model: 'Transaction',
    where: { id: transactions },
  },
]);

const collectiveInfo: RecipeItem[] = [
  {
    model: 'Collective',
    from: 'CollectiveId',
    dependencies: [
      {
        model: 'Member',
        on: 'CollectiveId',
      },
    ],
  },
  {
    model: 'Collective',
    from: 'FromCollectiveId',
    dependencies: [
      {
        model: 'Member',
        on: 'CollectiveId',
      },
    ],
  },
  {
    model: 'Collective',
    from: 'HostCollectiveId',
    dependencies: [
      {
        model: 'Member',
        on: 'CollectiveId',
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
  PaymentMethod: [{ model: 'Collective', from: 'CollectiveId' }],
  PayoutMethod: [{ model: 'Collective', from: 'CollectiveId' }],
  Expense: [
    { model: 'Transaction', on: 'ExpenseId', dependencies: collectiveInfo },
    { model: 'ExpenseItem', on: 'ExpenseId' },
    { model: 'ExpenseAttachedFile', on: 'ExpenseId' },
    { model: 'PaymentMethod', from: 'PaymentMethodId' },
    { model: 'PayoutMethod', from: 'PayoutMethodId' },
    {
      model: 'RecurringExpense',
      from: 'RecurringExpenseId',
    },
    { model: 'Activity', on: 'ExpenseId' },
    {
      model: 'Comment',
      on: 'ExpenseId',
      dependencies: [
        { model: 'User', from: 'CreatedByUserId' },
        { model: 'Collective', from: 'FromCollectiveId' },
      ],
    },
  ],
  Order: [
    { model: 'Transaction', on: 'OrderId', dependencies: collectiveInfo },
    { model: 'PaymentMethod', from: 'PaymentMethodId' },
    {
      model: 'Subscription',
      from: 'SubscriptionId',
    },
    { model: 'Activity', on: 'OrderId' },
    {
      model: 'Comment',
      on: 'OrderId',
      dependencies: [
        { model: 'User', from: 'CreatedByUserId' },
        { model: 'Collective', from: 'FromCollectiveId' },
      ],
    },
  ],
};

// eslint-disable-next-line import/no-commonjs
module.exports = {
  entries,
  defaultDependencies,
};
