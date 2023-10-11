import { GraphQLList, GraphQLNonNull, GraphQLString } from 'graphql';
import { GraphQLNonEmptyString } from 'graphql-scalars';
import { cloneDeep, pick, uniq } from 'lodash';

import models, { Collective } from '../../../models';
import { enforceScope } from '../../common/scope-check';
import { Forbidden, ValidationFailed } from '../../errors';
import collective from '../../loaders/collective';
import { idDecode, IDENTIFIER_TYPES } from '../identifiers';
import {
  AccountCategoryCreateInput,
  AccountCategoryCreateInputFields,
  AccountCategoryReferenceInput,
  AccountCategoryReferenceInputFields,
  AccountCategoryUpdateInput,
} from '../input/AccountCategoryInput';
import { GraphQLAccountReferenceInput } from '../input/AccountReferenceInput';
import { GraphQLAccount } from '../interface/Account';
import GraphQLAccountingCategory from '../object/AccountingCategory';

/**
 * Load account and check permissions
 */
const loadAccountAndCheckPermissions = async (args, req): Promise<Collective> => {
  // Check scope
  enforceScope(req, 'host');

  // Load & validate account
  const account = await req.loaders.Collective.byId.load(args.account.id);
  if (!account) {
    throw new ValidationFailed('Account not found');
  } else if (!req.remoteUser?.isAdminOfCollective(account)) {
    throw new Forbidden('You must be logged in as an admin of this account to edit its accounting categories');
  } else if (!account.isHostAccount) {
    throw new ValidationFailed('Accounting categories can only be set at the host level');
  }

  return account;
};

export default {
  createAccountingCategories: {
    type: new GraphQLNonNull(GraphQLAccount),
    description: 'Create accounting categories',
    args: {
      account: {
        type: new GraphQLNonNull(GraphQLAccountReferenceInput),
        description: 'The host to edit accounting categories for',
      },
      categories: {
        type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(AccountCategoryCreateInput))),
        description: 'The list of categories to create',
      },
    },
    resolve: async (_: void, args: { categories: AccountCategoryCreateInputFields[] }, req) => {
      const account = await loadAccountAndCheckPermissions(args, req);
      const categoryInputs = args.categories.map(category => ({ ...category, CollectiveId: account.id }));
      return models.AccountingCategory.createMany(account, categoryInputs, req.remoteUser);
    },
  },
  deleteAccountingCategories: {
    type: new GraphQLNonNull(new GraphQLList(GraphQLAccount)),
    description: 'Edit accounting categories. Returns the list of deleted categories.',
    args: {
      account: {
        type: new GraphQLNonNull(GraphQLAccountReferenceInput),
        description: 'The host to edit accounting categories for',
      },
      categories: {
        type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(AccountCategoryReferenceInput))),
        description: 'The list of categories to delete',
      },
    },
    resolve: async (_: void, args: { categories: AccountCategoryReferenceInputFields[] }, req) => {
      const account = await loadAccountAndCheckPermissions(args, req);
      const ids = args.categories.map(({ id }) => idDecode(id, IDENTIFIER_TYPES.ACCOUNTING_CATEGORY));
      await models.AccountingCategory.deleteMany(account, ids, req.remoteUser);
      return account;
    },
  },
  editAccountingCategories: {
    type: new GraphQLNonNull(GraphQLAccountingCategory),
    description: 'Edit an accounting category',
    args: {
      account: {
        type: new GraphQLNonNull(GraphQLAccountReferenceInput),
        description: 'The host to edit accounting categories for',
      },
      categories: {
        type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(AccountCategoryUpdateInput))),
        description: 'The list of categories to edit',
      },
    },
    resolve: async (
      _: void,
      args: { category: AccountCategoryReferenceInputFields; code?: string; name?: string; friendlyName?: string },
      req,
    ) => {
      const account = await loadAccountAndCheckPermissions(args, req);
      const category = await models.AccountingCategory.findOne({
        where: { CollectiveId: account.id, id: args.category.id },
      });

      const previousData = cloneDeep(category.publicInfo);
      const newData = pick(args, ['code', 'name', 'friendlyName']);
      const updatedCategory = await models.AccountingCategory.update(newValues);

      // Not awaiting on purpose
      models.AccountingCategory.createEditActivity(account, req.remoteUser, { edited: [{ previousData, newData }] });

      return updatedCategory;
    },
  },
};
