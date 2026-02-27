import { GraphQLInputObjectType, GraphQLInt, GraphQLString } from 'graphql';
import { uniq } from 'lodash';
import { Includeable, Op } from 'sequelize';

import models from '../../../models';
import { NotFound } from '../../errors';
import { idDecode, IDENTIFIER_TYPES } from '../identifiers';

export const GraphQLOrderReferenceInput = new GraphQLInputObjectType({
  name: 'OrderReferenceInput',
  fields: () => ({
    publicId: {
      type: GraphQLString,
      description: `The resource public id (ie: ${models.Order.nanoIdPrefix}_xxxxxxxx)`,
    },
    id: {
      type: GraphQLString,
      description: 'The public id identifying the order (ie: dgm9bnk8-0437xqry-ejpvzeol-jdayw5re)',
      deprecationReason: '2026-02-25: use publicId',
    },
    legacyId: {
      type: GraphQLInt,
      description: 'The legacy public id identifying the order (ie: 4242)',
      deprecationReason: '2026-02-25: use publicId',
    },
  }),
});

export type OrderReferenceInputGraphQLType = { publicId?: string; id?: string; legacyId?: number };

export const getDatabaseIdFromOrderReference = (input: OrderReferenceInputGraphQLType): number => {
  if (input.id) {
    return idDecode(input.id, IDENTIFIER_TYPES.ORDER);
  } else if (input.legacyId) {
    return input.legacyId;
  } else {
    throw new Error(`Please provide an id or a legacyId (got ${JSON.stringify(input)})`);
  }
};

export const fetchOrderWithReference = async (
  input: OrderReferenceInputGraphQLType,
  {
    include = undefined,
    throwIfMissing = true,
  }: { include?: Includeable | Includeable[]; throwIfMissing?: boolean } = {},
) => {
  const loadOrderById = id => {
    return models.Order.findByPk(id, { include });
  };

  let order;
  if (input.publicId) {
    const expectedPrefix = models.Order.nanoIdPrefix;
    if (!input.publicId.startsWith(`${expectedPrefix}_`)) {
      throw new Error(`Invalid publicId for Order, expected prefix ${expectedPrefix}_`);
    }

    order = await models.Order.findOne({ where: { publicId: input.publicId }, include });
  } else {
    const id = getDatabaseIdFromOrderReference(input);
    order = await loadOrderById(id);
  }
  if (!order && throwIfMissing) {
    throw new NotFound('Order Not Found');
  }
  return order;
};

export const fetchOrdersWithReferences = async (
  inputs: OrderReferenceInputGraphQLType[],
  { include }: { include?: Includeable | Includeable[] },
) => {
  if (inputs.length === 0) {
    return [];
  }

  const expectedPrefix = models.Order.nanoIdPrefix;
  const inputsWithPublicId = inputs.filter(input => input.publicId);
  inputsWithPublicId.forEach(input => {
    if (!input.publicId.startsWith(`${expectedPrefix}_`)) {
      throw new Error(`Invalid publicId for Order, expected prefix ${expectedPrefix}_`);
    }
  });

  const ids = uniq(inputs.filter(input => !input.publicId).map(getDatabaseIdFromOrderReference));
  const publicIds = uniq(inputsWithPublicId.map(input => input.publicId));

  const where: any = {};
  if (ids.length && publicIds.length) {
    where[Op.or] = [{ id: ids }, { publicId: publicIds }];
  } else if (ids.length) {
    where.id = ids;
  } else if (publicIds.length) {
    where.publicId = publicIds;
  }

  // Fetch orders
  const orders = await models.Order.findAll({
    where,
    include,
  });

  // Check if all orders were found
  const inputHasMatchingOrder = input => {
    return orders.some(order => {
      if (input.publicId) {
        return order.publicId === input.publicId;
      } else if (input.id) {
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
        .map(input =>
          input.publicId ? `#${input.publicId}` : `#${input.legacyId || idDecode(input.id, IDENTIFIER_TYPES.ORDER)}`,
        )
        .join(', ')})`,
    );
  }

  return orders;
};
