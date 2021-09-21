import { GraphQLInputObjectType, GraphQLInt, GraphQLString } from 'graphql';

import models from '../../../models';
import { NotFound } from '../../errors';
import { idDecode } from '../identifiers';

export const OrderReferenceInput = new GraphQLInputObjectType({
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
export const fetchOrderWithReference = async input => {
  const loadOrderById = id => {
    return models.Order.findByPk(id);
  };

  let order;
  if (input.id) {
    const id = idDecode(input.id, 'order');
    order = await loadOrderById(id);
  } else if (input.legacyId) {
    order = await loadOrderById(input.legacyId);
  } else {
    throw new Error('Please provide an id');
  }
  if (!order) {
    throw new NotFound('Order Not Found');
  }
  return order;
};
