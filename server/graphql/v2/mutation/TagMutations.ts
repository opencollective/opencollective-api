import type { Request } from 'express';
import { GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';

import models from '../../../models';
import { canEditExpenseTags } from '../../common/expenses';
import { checkRemoteUserCanUseExpenses, checkRemoteUserCanUseOrders } from '../../common/scope-check';
import { Unauthorized } from '../../errors';
import { fetchExpenseWithReference, GraphQLExpenseReferenceInput } from '../input/ExpenseReferenceInput';
import { fetchOrderWithReference, GraphQLOrderReferenceInput } from '../input/OrderReferenceInput';
import { GraphQLExpense } from '../object/Expense';
import { GraphQLOrder } from '../object/Order';
import { canSetOrderTags } from '../object/OrderPermissions';

const GraphQLTagResponse = new GraphQLObjectType({
  name: 'TagResponse',
  fields: () => ({
    order: {
      type: GraphQLOrder,
    },
    expense: {
      type: GraphQLExpense,
    },
  }),
});

const tagMutations = {
  setTags: {
    type: new GraphQLNonNull(GraphQLTagResponse),
    args: {
      tags: {
        type: new GraphQLList(GraphQLString),
        description: 'Tags associated with the object being updated',
      },
      order: {
        type: GraphQLOrderReferenceInput,
      },
      expense: {
        type: GraphQLExpenseReferenceInput,
      },
    },
    resolve: async (_: void, args, req: Request) => {
      if ([args.order, args.expense].filter(Boolean).length !== 1) {
        throw new Error('A single order or expense must be provided');
      }

      if (args.order) {
        checkRemoteUserCanUseOrders(req);

        const order = await fetchOrderWithReference(args.order, {
          throwIfMissing: true,
          include: [{ model: models.Collective, as: 'collective' }],
        });
        if (!(await canSetOrderTags(req, order))) {
          throw new Unauthorized('You do not have the permissions to set tags on this order');
        }

        await order.update({ tags: args.tags });

        return { order };
      } else if (args.expense) {
        checkRemoteUserCanUseExpenses(req);

        const expense = await fetchExpenseWithReference(args.expense, { throwIfMissing: true });
        if (!(await canEditExpenseTags(req, expense))) {
          throw new Unauthorized('You do not have the permissions to set tags on this expense');
        }

        await expense.update({ tags: args.tags });

        return { expense };
      }
    },
  },
};

export default tagMutations;
