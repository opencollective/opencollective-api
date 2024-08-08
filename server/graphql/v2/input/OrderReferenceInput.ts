import { GraphQLInputObjectType, GraphQLInt, GraphQLString } from 'graphql';
import { Includeable } from 'sequelize';

import models from '../../../models';
import { NotFound } from '../../errors';
import { idDecode, IDENTIFIER_TYPES } from '../identifiers';

export const GraphQLOrderReferenceInput = new GraphQLInputObjectType({
  name: 'OrderReferenceInput',
  fields: () => ({
    id: {
      type: GraphQLString,
      description: 'The public id identifying the order (ie: dgm9bnk8-0437xqry-ejpvzeol-jdayw5re)',
    },
    legacyId: {
      type: GraphQLInt,
      description: 'The legacy public id identifying the order (ie: 4242)',
    },
  }),
});

export type ObjectReference = { id?: string; legacyId?: number };

export const getDatabaseIdFromOrderReference = (input: ObjectReference): number => {
  if (input.id) {
    return idDecode(input.id, IDENTIFIER_TYPES.ORDER);
  } else if (input.legacyId) {
    return input.legacyId;
  } else {
    throw new Error(`Please provide an id or a legacyId (got ${JSON.stringify(input)})`);
  }
};

export const fetchOrderWithReference = async (
  input: ObjectReference,
  {
    include = undefined,
    throwIfMissing = true,
  }: { include?: Includeable | Includeable[]; throwIfMissing?: boolean } = {},
) => {
  const loadOrderById = id => {
    return models.Order.findByPk(id, { include });
  };

  const id = getDatabaseIdFromOrderReference(input);
  const order = await loadOrderById(id);
  if (!order && throwIfMissing) {
    throw new NotFound('Order Not Found');
  }
  return order;
};

export const fetchOrdersWithReferences = async (
  inputs: ObjectReference[],
  { include }: { include?: Includeable | Includeable[] },
) => {
  if (inputs.length === 0) {
    return [];
  }

  // Fetch orders
  const orders = await models.Order.findAll({
    where: { id: inputs.map(getDatabaseIdFromOrderReference) },
    include,
  });

  // Check if all orders were found
  const inputHasMatchingOrder = input => {
    return orders.some(order => {
      if (input.id) {
        return order.id === idDecode(input.id, IDENTIFIER_TYPES.ORDER);
      } else if (input.legacyId) {
        return order.id === input.legacyId;
      }
    });
  };

  if (!inputs.every(inputHasMatchingOrder)) {
    throw new NotFound(
      `Orders not found for some of the given inputs (${inputs
        .filter(i => !inputHasMatchingOrder(i))
        .map(input => `#${input.legacyId || idDecode(input.id, IDENTIFIER_TYPES.ORDER)}`)
        .join(', ')})`,
    );
  }

  return orders;
};
