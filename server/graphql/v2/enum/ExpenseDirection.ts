import { GraphQLEnumType } from 'graphql';

export const GraphQLExpenseDirection = new GraphQLEnumType({
  name: 'ExpenseDirection',
  description:
    'Describes the role of the filtered account/host in an expense. Controls which side the account, accounts, and host/hostContext arguments apply to.',
  values: {
    SUBMITTED: {
      description: 'Submitted: The account is the one who submitted the expense and possibly the beneficiary.',
    },
    RECEIVED: {
      description: "Received: The account is the one who received the expense and the one who's paying for it.",
    },
  },
});
