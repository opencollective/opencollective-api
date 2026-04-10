import { GraphQLList, GraphQLNonNull } from 'graphql';
import { cloneDeep, isNil, pick, uniq } from 'lodash';
import { Transaction } from 'sequelize';

import { CollectiveType } from '../../../constants/collectives';
import FEATURE from '../../../constants/feature';
import { normalizeContributionAccountingCategoryRulePredicate } from '../../../lib/accounting/categorization/contribution-rules';
import { checkFeatureAccess } from '../../../lib/allowed-features';
import { isUniqueConstraintError, richDiffDBEntries } from '../../../lib/data';
import { EntityShortIdPrefix, isEntityPublicId } from '../../../lib/permalink/entity-map';
import models, { sequelize } from '../../../models';
import AccountingCategory, { AccountingCategoryAppliesTo } from '../../../models/AccountingCategory';
import { AccountingCategoryRule } from '../../../models/AccountingCategoryRule';
import { enforceScope } from '../../common/scope-check';
import { Forbidden, ValidationFailed } from '../../errors';
import { idDecode, IDENTIFIER_TYPES } from '../identifiers';
import { AccountingCategoryInput, AccountingCategoryInputFields } from '../input/AccountingCategoryInput';
import { fetchAccountWithReference, GraphQLAccountReferenceInput } from '../input/AccountReferenceInput';
import { GraphQLContributionAccountingCategoryRuleInput } from '../input/ContributionAccountingCategoryRuleInput';
import { GraphQLAccount } from '../interface/Account';

type AccountingCategoryInputWithNormalizedId = Omit<AccountingCategoryInputFields, 'id'> & {
  id?: number;
};

const EDITABLE_FIELDS: readonly (keyof AccountingCategoryInputFields)[] = [
  'kind',
  'code',
  'name',
  'friendlyName',
  'expensesTypes',
  'hostOnly',
  'instructions',
  'appliesTo',
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
    resolve: async (
      _: void,
      args: { account: any; categories: AccountingCategoryInputFields[] },
      req: Express.Request,
    ) => {
      // Check scope
      enforceScope(req, 'host');

      // Load & validate account
      const account = await fetchAccountWithReference(args.account, { loaders: req.loaders, throwIfMissing: true });
      if (!req.remoteUser?.isAdminOfCollective(account)) {
        throw new Forbidden('You must be logged in as an admin of this account to edit its accounting categories');
      } else if (!account.hasMoneyManagement) {
        throw new ValidationFailed('Accounting categories can only be set at the host level');
      } else if (args.categories.length > 120) {
        throw new ValidationFailed('You can only create up to 100 accounting categories at once');
      }

      await checkFeatureAccess(account, FEATURE.CHART_OF_ACCOUNTS, { loaders: req.loaders });

      const isIndependentCollective = account.type === CollectiveType.COLLECTIVE;

      const normalizedInputs = await Promise.all(
        args.categories.map(async input => {
          let id;
          if (isEntityPublicId(input.id, EntityShortIdPrefix.AccountingCategory)) {
            id = await req.loaders.AccountingCategory.idByPublicId.load(input.id);
            if (!id) {
              throw new ValidationFailed(`Accounting category with public id ${input.id} not found`);
            }
          } else if (input.id) {
            id = idDecode(input.id, 'accounting-category');
          }

          return {
            ...input,
            id,
            expensesTypes: isNil(input.expensesTypes) ? input.expensesTypes : uniq(input.expensesTypes).sort(), // Uniq & sort to avoid false positives in diff
            appliesTo: input.appliesTo,
          };
        }),
      );

      if (
        isIndependentCollective &&
        normalizedInputs.some(c => c.appliesTo === AccountingCategoryAppliesTo.HOSTED_COLLECTIVES)
      ) {
        throw new ValidationFailed(
          'Independent collectives cannot create accounting categories applicable to hosted collectives',
        );
      }

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
  updateContributionAccountingCategoryRules: {
    type: new GraphQLNonNull(GraphQLAccount),
    description: 'Update the contribution accounting category rules. Returns the account with the updated rules.',
    args: {
      account: {
        type: new GraphQLNonNull(GraphQLAccountReferenceInput),
        description: 'The host to update the contribution accounting category rules for',
      },
      rules: {
        type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLContributionAccountingCategoryRuleInput))),
        description: 'The contribution accounting category rules to update',
      },
    },
    resolve: async (_: void, args, req) => {
      // Check scope
      enforceScope(req, 'host');

      // Load & validate account
      const account = await fetchAccountWithReference(args.account, { loaders: req.loaders, throwIfMissing: true });
      if (!req.remoteUser?.isAdminOfCollective(account)) {
        throw new Forbidden(
          'You must be logged in as an admin of this account to update its contribution accounting category rules',
        );
      } else if (!account.hasMoneyManagement) {
        throw new ValidationFailed('Contribution accounting category rules can only be set at the host level');
      }

      await checkFeatureAccess(account, FEATURE.ACCOUNTING_CATEGORIZATION_RULES, { loaders: req.loaders });

      const rules = await Promise.all(
        args.rules.map(async (rule, ruleIndex) => {
          let existingRuleId = null;
          if (rule.id) {
            const existingRule = await AccountingCategoryRule.findOne({ where: { publicId: rule.id } });

            if (existingRule && existingRule.type !== 'CONTRIBUTION') {
              throw new ValidationFailed('This mutation can only update contribution accounting category rules');
            }

            if (existingRule && existingRule.CollectiveId !== account.id) {
              throw new Forbidden('You are not authorized to update this rule');
            }

            existingRuleId = existingRule.id;
          }

          const normalizedPredicates = [];
          for (let predicateIndex = 0; predicateIndex < (rule.predicates?.length || 0); predicateIndex++) {
            const predicate = rule.predicates[predicateIndex];
            const normalizedPredicate = await normalizeContributionAccountingCategoryRulePredicate(predicate);
            normalizedPredicates[predicateIndex] = normalizedPredicate;
          }

          const accountingCategoryId = isEntityPublicId(
            rule.accountingCategory.id,
            EntityShortIdPrefix.AccountingCategory,
          )
            ? await AccountingCategory.findOne({ where: { publicId: rule.accountingCategory.id } }).then(c => c?.id)
            : idDecode(rule.accountingCategory.id, IDENTIFIER_TYPES.ACCOUNTING_CATEGORY);

          return {
            id: existingRuleId,
            publicId: rule.id,
            CollectiveId: account.id,
            AccountingCategoryId: accountingCategoryId,
            name: rule.name,
            enabled: isNil(rule.enabled) ? true : rule.enabled,
            type: 'CONTRIBUTION',
            predicates: normalizedPredicates,
            order: ruleIndex,
          };
        }),
      );

      await sequelize.transaction(async transaction => {
        const existingRules = await AccountingCategoryRule.findAll({
          where: { CollectiveId: account.id, type: 'CONTRIBUTION' },
          transaction,
          lock: Transaction.LOCK.UPDATE,
        });

        const toDelete = existingRules.filter(rule => !rules.some(r => r.publicId === rule.publicId));

        await AccountingCategoryRule.destroy({
          where: { publicId: toDelete.map(r => r.publicId) },
          transaction,
        });

        await AccountingCategoryRule.bulkCreate(rules, {
          transaction,
          updateOnDuplicate: ['order', 'enabled', 'name', 'predicates', 'AccountingCategoryId', 'updatedAt'],
        });
      });

      return account;
    },
  },
};
