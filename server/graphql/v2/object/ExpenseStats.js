import { GraphQLInt, GraphQLObjectType } from 'graphql';

export const ExpenseStats = new GraphQLObjectType({
  name: 'ExpenseStats',
  description: 'Expense statistics related to the given accounts',
  fields: () => ({
    numExpenses: { type: GraphQLInt, description: 'The total number of expenses'},
    dailyAverage: { type: GraphQLInt, description: 'The daily average paid in expenses' },
    numInvoices: { type: GraphQLInt, description: 'Number of invoices' },
    numReimbursements: { type: GraphQLInt, description: 'Number of reimbursements' },
    numGrants: { type: GraphQLInt, description: 'Number of grants' },
  }),
});
