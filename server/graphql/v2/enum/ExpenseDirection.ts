import { GraphQLEnumType } from 'graphql';

export const GraphQLExpenseDirection = new GraphQLEnumType({
  name: 'ExpenseDirection',
  description: 'Describes the role in which an account is involved in an expense. This is used to filter',
  values: {
    SUBMITTED: {
      description: 'Submitted: The account is the one who submitted the expense and possibly the beneficiary.',
    },
    RECEIVED: {
      description: "Received: The account is the one who received the expense and the one who's paying for it.",
    },
  },
});
