import { GraphQLInt, GraphQLString, GraphQLInputObjectType } from 'graphql';

import models from '../../../models';
import { NotFound } from '../../errors';
import { idDecode } from '../identifiers';

export const AccountReferenceInput = new GraphQLInputObjectType({
  name: 'AccountReferenceInput',
  fields: () => ({
    id: {
      type: GraphQLString,
      description: 'The public id identifying the account (ie: dgm9bnk8-0437xqry-ejpvzeol-jdayw5re)',
    },
    legacyId: {
      type: GraphQLInt,
      description: 'The internal id of the account (ie: 580)',
      deprecationReason: '2020-01-01: should only be used during the transition to GraphQL API v2.',
    },
    slug: {
      type: GraphQLString,
      description: 'The slug identifying the account (ie: babel for https://opencollective.com/babel)',
    },
  }),
});

/**
 * Retrieves an account
 *
 * @param {string|number} input - slug or id of the collective
 * @param {object} params
 *    - dbTransaction: An SQL transaction to run the query. Will skip `loaders`
 *    - lock: If true and `dbTransaction` is set, the row will be locked
 */
export const fetchAccountWithReference = async (
  input,
  { loaders = null, throwIfMissing = false, dbTransaction = undefined, lock = false } = {},
) => {
  // Load collective by ID using GQL loaders if we're not using a transaction & loaders are available
  const loadCollectiveById = id => {
    if (!loaders || dbTransaction) {
      return models.Collective.findByPk(id, { transaction: dbTransaction, lock });
    } else {
      return loaders.Collective.byId.load(id);
    }
  };

  let collective;
  if (input.id) {
    const id = idDecode(input.id, 'account');
    collective = await loadCollectiveById(id);
  } else if (input.legacyId) {
    collective = await loadCollectiveById(input.legacyId);
  } else if (input.slug) {
    collective = await models.Collective.findOne(
      { where: { slug: input.slug.toLowerCase() } },
      { transaction: dbTransaction, lock },
    );
  } else {
    throw new Error('Please provide an id or a slug');
  }
  if (!collective && throwIfMissing) {
    throw new NotFound({ message: 'Account Not Found' });
  }
  return collective;
};
