import { GraphQLInputObjectType, GraphQLInt, GraphQLString } from 'graphql';
import { uniq } from 'lodash';
import { Includeable } from 'sequelize';

import { EntityShortIdPrefix, isEntityPublicId } from '../../../lib/permalink/entity-map';
import models, { Order } from '../../../models';
import { NotFound } from '../../errors';
import { Loaders } from '../../loaders';
import { idDecode, IDENTIFIER_TYPES } from '../identifiers';

export const GraphQLOrderReferenceInput = new GraphQLInputObjectType({
  name: 'OrderReferenceInput',
  fields: () => ({
    id: {
      type: GraphQLString,
      description: `The public id identifying the order (ie: dgm9bnk8-0437xqry-ejpvzeol-jdayw5re, ${models.Order.nanoIdPrefix}_xxxxxxxx)`,
    },
    legacyId: {
      type: GraphQLInt,
      description: 'The legacy public id identifying the order (ie: 4242)',
      deprecationReason: '2026-02-25: use id',
    },
  }),
});

export type OrderReferenceInputGraphQLType = { id?: string; legacyId?: number };

export const getDatabaseIdFromOrderReference = async (
  input: OrderReferenceInputGraphQLType,
  { loaders = null }: { loaders?: Loaders } = {},
): Promise<number | null> => {
  if (isEntityPublicId(input.id, EntityShortIdPrefix.Order)) {
    return (
      loaders
        ? loaders.Order.byPublicId.load(input.id)
        : models.Order.findOne({ where: { publicId: input.id }, attributes: ['id'] })
    ).then(order => {
      if (!order) {
        throw new NotFound(`Order with public id ${input.id} not found`);
      }
      return order.id;
    });
  } else if (input.id) {
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
    loaders = null,
    include = undefined,
    throwIfMissing = true,
  }: { loaders?: Loaders; include?: Includeable | Includeable[]; throwIfMissing?: boolean } = {},
) => {
  const loadOrderById = id => {
    return models.Order.findByPk(id, { include });
  };

  let order: Order | null = null;
  if (isEntityPublicId(input.id, EntityShortIdPrefix.Order)) {
    order = await (loaders
      ? loaders.Order.byPublicId.load(input.id)
      : models.Order.findOne({ where: { publicId: input.id }, include }));
  } else {
    const id = await getDatabaseIdFromOrderReference(input, { loaders });
    order = await loadOrderById(id);
  }
  if (!order && throwIfMissing) {
    throw new NotFound('Order Not Found');
  }
  return order;
};

export const fetchOrdersWithReferences = async (
  inputs: OrderReferenceInputGraphQLType[],
  { loaders = null, include }: { loaders?: Loaders; include?: Includeable | Includeable[] },
) => {
  if (inputs.length === 0) {
    return [];
  }

  const ids = uniq(await Promise.all(inputs.map(input => getDatabaseIdFromOrderReference(input, { loaders }))));

  const where = { id: ids };

  // Fetch orders
  const orders = await models.Order.findAll({
    where,
    include,
  });

  // Check if all orders were found
  const inputHasMatchingOrder = input => {
    return orders.some(order => {
      if (isEntityPublicId(input.id, EntityShortIdPrefix.Order)) {
        return order.publicId === input.id;
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
          isEntityPublicId(input.id, EntityShortIdPrefix.Order)
            ? `#${input.id}`
            : `#${input.legacyId || idDecode(input.id, IDENTIFIER_TYPES.ORDER)}`,
        )
        .join(', ')})`,
    );
  }

  return orders;
};
