import { ContributionRoles } from '../../../constants/contribution-roles';
import { AccountingCategory, Order } from '../../../models';
import { ContributionAccountingCategoryRule } from '../../../models/ContributionAccountingCategoryRule';
import { FEATURE, hasFeature } from '../../allowed-features';
import { reportErrorToSentry } from '../../sentry';

import {
  ContributionAccountingCategoryRulePredicate,
  ContributionAccountingCategoryRuleSubjectDefinition,
} from './types';

export async function normalizeContributionAccountingCategoryRulePredicate(
  predicate: ContributionAccountingCategoryRulePredicate,
): Promise<ContributionAccountingCategoryRulePredicate> {
  const subjectDefinition = ContributionAccountingCategoryRuleSubjectDefinition[predicate.subject];
  if (!subjectDefinition) {
    throw new Error(`Invalid subject: ${predicate.subject}`);
  }
  if (!subjectDefinition.operators.includes(predicate.operator)) {
    throw new Error(`Invalid operator: ${predicate.operator}`);
  }

  return {
    subject: predicate.subject,
    operator: predicate.operator,
    value: await subjectDefinition.normalize(predicate.operator, predicate.value),
  };
}

export async function resolveContributionAccountingCategory(
  rules: ContributionAccountingCategoryRule[],
  order: Order,
): Promise<AccountingCategory | null> {
  for (const rule of rules) {
    const matches = (
      await Promise.all(
        rule.predicates.map(async predicate => {
          const subjectDefinition = ContributionAccountingCategoryRuleSubjectDefinition[predicate.subject];
          if (!subjectDefinition) {
            throw new Error(`Invalid subject: ${predicate.subject}`);
          }
          return subjectDefinition.matches(predicate.operator, predicate.value, order);
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

    if (!(await hasFeature(host, FEATURE.CONTRIBUTION_CATEGORIZATION_RULES))) {
      return;
    }

    const rules = await ContributionAccountingCategoryRule.getRulesForCollective(collective.HostCollectiveId);
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
              [ContributionRoles.accountingRules]: {
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
