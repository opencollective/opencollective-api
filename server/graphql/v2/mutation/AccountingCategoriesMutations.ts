import { GraphQLList, GraphQLNonNull } from 'graphql';
import { cloneDeep, isNil, pick, uniq } from 'lodash';

import { isUniqueConstraintError, richDiffDBEntries } from '../../../lib/data';
import models, { sequelize } from '../../../models';
import AccountingCategory from '../../../models/AccountingCategory';
import { enforceScope } from '../../common/scope-check';
import { Forbidden, ValidationFailed } from '../../errors';
import { idDecode } from '../identifiers';
import { AccountingCategoryInput, AccountingCategoryInputFields } from '../input/AccountingCategoryInput';
import { fetchAccountWithReference, GraphQLAccountReferenceInput } from '../input/AccountReferenceInput';
import { GraphQLAccount } from '../interface/Account';

type AccountingCategoryInputWithNormalizedId = Omit<AccountingCategoryInputFields, 'id'> & { id?: number };

const EDITABLE_FIELDS: readonly (keyof AccountingCategoryInputFields)[] = [
  'code',
  'name',
  'friendlyName',
  'expensesTypes',
];

export default {
  editAccountingCategories: {
    type: new GraphQLNonNull(GraphQLAccount),
    description: 'Edit an accounting category. Returns the account with the updated categories.',
    args: {
      account: {
        type: new GraphQLNonNull(GraphQLAccountReferenceInput),
        description: 'The host to edit accounting categories for',
      },
      categories: {
        type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(AccountingCategoryInput))),
        description: 'The list of categories to edit',
      },
    },
    resolve: async (_: void, args: { account: any; categories: AccountingCategoryInputFields[] }, req) => {
      // Check scope
      enforceScope(req, 'host');

      // Load & validate account
      const account = await fetchAccountWithReference(args.account, { loaders: req.loaders, throwIfMissing: true });
      if (!req.remoteUser?.isAdminOfCollective(account)) {
        throw new Forbidden('You must be logged in as an admin of this account to edit its accounting categories');
      } else if (!account.isHostAccount) {
        throw new ValidationFailed('Accounting categories can only be set at the host level');
      } else if (args.categories.length > 120) {
        throw new ValidationFailed('You can only create up to 100 accounting categories at once');
      }

      const normalizedInputs: AccountingCategoryInputWithNormalizedId[] = args.categories.map(input => {
        return {
          ...input,
          id: input.id ? idDecode(input.id, 'accounting-category') : null,
          expensesTypes: isNil(input.expensesTypes) ? input.expensesTypes : uniq(input.expensesTypes).sort(), // Uniq & sort to avoid false positives in diff
        };
      });

      try {
        await sequelize.transaction(async transaction => {
          const existingCategories = await models.AccountingCategory.findAll({
            transaction,
            where: { CollectiveId: account.id },
            include: [{ association: 'expenses', required: false, attributes: ['id'], where: { status: 'PAID' } }],
          });

          const diffFn = richDiffDBEntries<AccountingCategory, AccountingCategoryInputWithNormalizedId>;
          const { toCreate, toRemove, toUpdate } = diffFn(existingCategories, normalizedInputs, EDITABLE_FIELDS);

          // If there's nothing to do, return early
          if (!toCreate.length && !toRemove.length && !toUpdate.length) {
            return;
          } else if (toRemove.some(c => c.expenses.length)) {
            // We'll probably want a way to archive a category at some point, but for now we'll prevent deleting a category that has expenses
            // attached as it could have bad consequences for accounting.
            throw new ValidationFailed(
              'Cannot remove accounting categories that have already been used in paid expenses. Please re-categorize the expenses first.',
            );
          }

          // Trigger changes
          // Remove - must always be first to avoid unique constraint errors on `code`
          await models.AccountingCategory.destroy({
            where: { id: toRemove.map(c => c.id), CollectiveId: account.id },
            transaction,
          });

          // Update
          const updated = await Promise.all(
            toUpdate.map(async ({ model, newValues }) => ({
              previousData: cloneDeep(model.publicInfo),
              newData: (await model.update(pick(newValues, EDITABLE_FIELDS), { transaction })).publicInfo,
            })),
          );

          // Create
          const newCategories = await models.AccountingCategory.bulkCreate(
            toCreate.map(params => ({ ...pick(params, EDITABLE_FIELDS), CollectiveId: account.id })),
            { transaction, returning: true },
          );

          // Create activity as a side effect
          models.AccountingCategory.createEditActivity(account, req.remoteUser, {
            added: newCategories.map(c => c.publicInfo),
            removed: toRemove.map(c => c.publicInfo),
            edited: updated,
          });
        });
      } catch (e) {
        if (isUniqueConstraintError(e, ['CollectiveId', 'code'])) {
          throw new ValidationFailed('A category with this code already exists');
        } else {
          throw e;
        }
      }

      return account;
    },
  },
};
