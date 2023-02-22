import { GraphQLInputObjectType, GraphQLInt, GraphQLString } from 'graphql';

import models, { Op } from '../../../models';
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

/**
 * Retrieves an order
 *
 * @param {object} input - id of the order
 */
export const fetchOrderWithReference = async (input, { include, throwIfMissing = true } = {}) => {
  const loadOrderById = id => {
    return models.Order.findByPk(id, { include });
  };

  let order;
  if (input.id) {
    const id = idDecode(input.id, IDENTIFIER_TYPES.ORDER);
    order = await loadOrderById(id);
  } else if (input.legacyId) {
    order = await loadOrderById(input.legacyId);
  } else {
    throw new Error('Please provide an id');
  }
  if (!order && throwIfMissing) {
    throw new NotFound('Order Not Found');
  }
  return order;
};

/**
 * Retrieves multiple orders from a list of references
 *
 * @param {object} input - id of the order
 */
export const fetchOrdersWithReferences = async (inputs, { include }) => {
  if (inputs.length === 0) {
    return [];
  }

  const getConditionFromInput = input => {
    if (input.id) {
      return { id: idDecode(input.id, IDENTIFIER_TYPES.ORDER) };
    } else if (input.legacyId) {
      return { id: input.legacyId };
    } else {
      throw new Error(`Please provide an id or a legacyId (got ${JSON.stringify(input)})`);
    }
  };

  // Fetch orders
  const orders = await models.Order.findAll({
    where: { [Op.or]: inputs.map(getConditionFromInput) },
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
