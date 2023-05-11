import { GraphQLEnumType } from 'graphql';

export const ExpenseProcessAction = new GraphQLEnumType({
  name: 'ExpenseProcessAction',
  description: 'All supported expense types',
  values: {
    APPROVE: {
      description: 'To mark the expense as approved',
    },
    UNAPPROVE: {
      description: 'To mark the expense as pending after it has been approved',
    },
    REQUEST_RE_APPROVAL: {
      description: 'To request re-approval of the expense, marking it as pending.',
    },
    REJECT: {
      description: 'To mark the expense as rejected',
    },
    MARK_AS_UNPAID: {
      description: 'To mark the expense as unpaid (marks the transaction as refunded)',
    },
    SCHEDULE_FOR_PAYMENT: {
      description: 'To schedule the expense for payment',
    },
    UNSCHEDULE_PAYMENT: {
      description: 'To unschedule the expense payment',
    },
    PAY: {
      description: 'To trigger the payment',
    },
    MARK_AS_SPAM: {
      description: 'To mark the expense as spam',
    },
    MARK_AS_INCOMPLETE: {
      description: 'To mark the expense as incomplete and notify the payee it requires more information',
    },
  },
});
