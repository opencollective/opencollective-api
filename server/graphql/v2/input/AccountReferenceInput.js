import { GraphQLBoolean, GraphQLInputObjectType, GraphQLInt, GraphQLString } from 'graphql';

import models from '../../../models';
import { NotFound } from '../../errors';
import { idDecode } from '../identifiers';

const AccountReferenceInputFields = {
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
};

export const AccountReferenceInput = new GraphQLInputObjectType({
  name: 'AccountReferenceInput',
  fields: () => AccountReferenceInputFields,
});

const NewAccountOrganizationInput = new GraphQLInputObjectType({
  name: 'NewAccountOrganizationInput',
  fields: () => ({
    name: { type: GraphQLString },
    slug: { type: GraphQLString },
    description: { type: GraphQLString },
    website: { type: GraphQLString },
  }),
});

export const NewAccountOrReferenceInput = new GraphQLInputObjectType({
  name: 'NewAccountOrReferenceInput',
  fields: () => ({
    ...AccountReferenceInputFields,
    name: {
      type: GraphQLString,
    },
    email: {
      type: GraphQLString,
    },
    organization: {
      type: NewAccountOrganizationInput,
    },
    newsletterOptIn: {
      type: GraphQLBoolean,
    },
  }),
});

/**
 * Retrieves an account
 *
 * @param {object} input - object containing slug or id of the collective
 * @param {object} params
 *    - dbTransaction: An SQL transaction to run the query. Will skip `loaders`
 *    - lock: If true and `dbTransaction` is set, the row will be locked
 */
export const fetchAccountWithReference = async (
  input,
  { loaders = null, throwIfMissing = false, dbTransaction = undefined, lock = false } = {},
) => {
  const loadCollectiveById = id => {
    if (!loaders || dbTransaction) {
      return models.Collective.findByPk(id, { transaction: dbTransaction, lock });
    } else {
      return loaders.Collective.byId.load(id);
    }
  };

  let collective;
  if (input.id && typeof input.id == 'string') {
    const id = idDecode(input.id, 'account');
    collective = await loadCollectiveById(id);
  } else if (input.legacyId || typeof input.id == 'number') {
    collective = await loadCollectiveById(input.legacyId || input.id);
  } else if (input.slug) {
    collective = await models.Collective.findOne(
      { where: { slug: input.slug.toLowerCase() } },
      { transaction: dbTransaction, lock },
    );
  } else {
    throw new Error('Please provide an id or a slug');
  }
  if (!collective && throwIfMissing) {
    throw new NotFound('Account Not Found');
  }
  return collective;
};
