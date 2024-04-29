import { GraphQLBoolean, GraphQLInputObjectType, GraphQLInt, GraphQLString } from 'graphql';
import { intersection, uniq } from 'lodash';
import { FindOptions, InferAttributes, ProjectionAlias } from 'sequelize';

import models, { Collective, Op } from '../../../models';
import { NotFound } from '../../errors';
import { idDecode } from '../identifiers';

export const AccountReferenceInputFields = {
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

export const GraphQLAccountReferenceInput = new GraphQLInputObjectType({
  name: 'AccountReferenceInput',
  fields: () => AccountReferenceInputFields,
});

const GraphQLNewAccountOrganizationInput = new GraphQLInputObjectType({
  name: 'NewAccountOrganizationInput',
  fields: () => ({
    name: { type: GraphQLString },
    legalName: { type: GraphQLString },
    slug: { type: GraphQLString },
    description: { type: GraphQLString },
    website: { type: GraphQLString },
  }),
});

export const GraphQLNewAccountOrReferenceInput = new GraphQLInputObjectType({
  name: 'NewAccountOrReferenceInput',
  fields: () => ({
    ...AccountReferenceInputFields,
    name: {
      type: GraphQLString,
    },
    legalName: {
      type: GraphQLString,
    },
    email: {
      type: GraphQLString,
    },
    organization: {
      type: GraphQLNewAccountOrganizationInput,
    },
    newsletterOptIn: {
      type: GraphQLBoolean,
    },
  }),
});

export type AccountReferenceInput = {
  id?: string;
  legacyId?: number;
  slug?: string;
};

// This type is required because, in https://github.com/opencollective/opencollective-api/blame/883ce648b63f8f90fa0a3635d95c0801496579e2/server/graphql/v2/mutation/ExpenseMutations.ts#L160,
// some collective models stored in JSON are being passed as inputs.
type FailoverAccountReferenceInput = {
  id?: number;
  slug?: string;
};

/**
 * Retrieves an account
 *
 * @param {object} input - object containing slug or id of the collective
 * @param {object} params
 *    - dbTransaction: An SQL transaction to run the query. Will skip `loaders`
 *    - lock: If true and `dbTransaction` is set, the row will be locked
 *    - throwIfMissing: throws an exception if collective is missing for the given id or slug
 */
export const fetchAccountWithReference = async (
  input: AccountReferenceInput | FailoverAccountReferenceInput,
  { loaders = null, throwIfMissing = false, dbTransaction = undefined, lock = false, paranoid = true } = {},
): Promise<Collective> => {
  const loadCollectiveById = id => {
    if (!loaders || dbTransaction) {
      return models.Collective.findByPk(id, { transaction: dbTransaction, lock, paranoid });
    } else {
      return loaders.Collective.byId.load(id);
    }
  };

  let collective;
  if (input.id && typeof input.id === 'string') {
    const id = idDecode(input.id, 'account');
    collective = await loadCollectiveById(id);
  } else if (input['legacyId'] || typeof input.id === 'number') {
    // TODO: It makes no sense to check for `input.id` being a number here, we're suppose to only use this function with account references
    collective = await loadCollectiveById(input['legacyId'] || input.id);
  } else if (input.slug) {
    collective = await models.Collective.findOne({
      where: { slug: input.slug.toLowerCase() },
      paranoid,
      transaction: dbTransaction,
      lock,
    });
  } else {
    throw new Error('Please provide an id or a slug');
  }
  if (!collective && throwIfMissing) {
    throw new NotFound('Account Not Found');
  }
  return collective;
};

/**
 * Retrieves accounts for given ids or slugs
 *
 * @param {object} inputs - object containing slugs or ids of the collectives
 * @param {object} params
 *    - throwIfMissing: throws an exception if a collective is missing for a given id or slug
 *    - whereConditions: additional where conditions to apply to the query
 *    - attributes: to apply a SELECT on the query
 *    - include: to include associated models
 */
export const fetchAccountsWithReferences = async (
  inputs: AccountReferenceInput | AccountReferenceInput[],
  {
    throwIfMissing = false,
    attributes,
    include,
  }: {
    throwIfMissing?: boolean;
    attributes?: Array<string | ProjectionAlias>;
    include?: FindOptions<InferAttributes<Collective>>['include'];
  } = {},
) => {
  // Compatibility with simple reference inputs not wrapped in an array
  inputs = Array.isArray(inputs) ? inputs : [inputs];

  if (inputs.length > 200) {
    throw new Error('You can only fetch up to 200 accounts at once');
  } else if (inputs.length === 0) {
    return [];
  }

  const getSQLConditionFromAccountReferenceInput = inputs => {
    const conditions = [];
    inputs.forEach(input => {
      if (input.id) {
        conditions.push({ id: idDecode(input.id, 'account') });
      } else if (input.legacyId) {
        conditions.push({ id: input.legacyId });
      } else if (input.slug) {
        conditions.push({ slug: input.slug.toLowerCase() });
      } else {
        throw new Error('Please provide an id or a slug');
      }
    });

    return conditions;
  };

  // Checks whether the given account and input matches
  const accountMatchesInput = (account, input) => {
    if (input.id) {
      return account.id === idDecode(input.id, 'account');
    } else if (input.legacyId) {
      return account.id === input.legacyId;
    } else if (input.slug) {
      return account.slug.toLowerCase() === input.slug.toLowerCase();
    }
  };

  // id and slug must always be included in the result if throwIfMissing is true
  if (throwIfMissing && attributes && intersection(['id', 'slug'], attributes).length !== 2) {
    attributes = uniq([...attributes, 'id', 'slug']);
  }

  // Fetch accounts
  const conditions = getSQLConditionFromAccountReferenceInput(inputs);
  const accounts = await models.Collective.findAll({
    attributes,
    include,
    where: { [Op.or]: conditions },
  });

  // Check if all accounts were found
  const accountLoadedForInput = input => accounts.some(account => accountMatchesInput(account, input));
  if (throwIfMissing && !inputs.every(accountLoadedForInput)) {
    throw new NotFound('Accounts not found for some of the given inputs');
  }

  return accounts;
};

/**
 * A quick helper around `fetchAccountsWithReferences` optimized to fetch accounts IDs
 * from AccountReferenceInputs
 * TODO: this should be renamed to `fetchAccountsIdsWithReferences` (plural)
 */
export const fetchAccountsIdsWithReference = async (accounts, options = null) => {
  if (!accounts?.length) {
    return [];
  } else {
    const fetchedAccounts = await fetchAccountsWithReferences(accounts, { ...options, attributes: ['id'] });
    return fetchedAccounts.map(account => account.id);
  }
};
