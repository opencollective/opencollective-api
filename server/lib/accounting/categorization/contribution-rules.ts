import { ContributionRoles } from '../../../constants/contribution-roles';
import { AccountingCategory, Order } from '../../../models';
import { AccountingCategoryRule } from '../../../models/AccountingCategoryRule';
import { FEATURE, hasFeature } from '../../allowed-features';
import { reportErrorToSentry } from '../../sentry';

import {
  ContributionAccountingCategoryRulePredicate,
  ContributionAccountingCategoryRuleSubjectMatcher,
  validateAndNormalizeContributionAccountingCategoryRulePredicate,
} from './types';

export async function normalizeContributionAccountingCategoryRulePredicate(
  predicate: ContributionAccountingCategoryRulePredicate,
): Promise<ContributionAccountingCategoryRulePredicate> {
  return validateAndNormalizeContributionAccountingCategoryRulePredicate(predicate);
}

export async function resolveContributionAccountingCategory(
  rules: AccountingCategoryRule[],
  order: Order,
): Promise<AccountingCategory | null> {
  for (const rule of rules) {
    const matches = (
      await Promise.all(
        rule.predicates.map(async predicate => {
          const subjectMatcher = ContributionAccountingCategoryRuleSubjectMatcher[predicate.subject];
          if (!subjectMatcher) {
            throw new Error(`Invalid subject: ${predicate.subject}`);
          }
          return subjectMatcher(predicate.operator, predicate.value, order);
        }),
      )
    ).every(match => match);

    if (matches) {
      return rule.accountingCategory;
    }
  }

  return null;
}

export async function applyContributionAccountingCategoryRules(order: Order): Promise<void> {
  try {
    if (order.AccountingCategoryId) {
      return;
    }

    const accountingCategorySetByHostAdmin =
      order?.data?.valuesByRole?.[ContributionRoles.hostAdmin]?.accountingCategory;

    if (accountingCategorySetByHostAdmin) {
      return;
    }

    const collective = order.collective || (await order.getCollective());
    const host = collective.host || (await collective.getHostCollective());

    if (!host) {
      return;
    }

    if (!(await hasFeature(host, FEATURE.ACCOUNTING_CATEGORIZATION_RULES))) {
      return;
    }

    const rules = await AccountingCategoryRule.getRulesForCollective(collective.HostCollectiveId, 'CONTRIBUTION');
    if (!rules.length) {
      return;
    }

    const accountingCategory = await resolveContributionAccountingCategory(rules, order);

    if (accountingCategory) {
      await order.update({
        AccountingCategoryId: accountingCategory.id,
        data: {
          ...order.data,
          valuesByRole: {
            ...(order.data.valuesByRole || {}),
            ...{
              [ContributionRoles.accountingRulesEngine]: {
                accountingCategory: accountingCategory?.publicInfo,
              },
            },
          },
        },
      });
    }
  } catch (error) {
    reportErrorToSentry(error);
    return;
  }
}
