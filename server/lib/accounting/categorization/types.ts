import { z, ZodError } from 'zod';

import { CollectiveType } from '../../../constants/collectives';
import { SUPPORTED_CURRENCIES, SupportedCurrency } from '../../../constants/currencies';
import { PAYMENT_METHOD_SERVICE } from '../../../constants/paymentMethods';
import Tiers from '../../../constants/tiers';
import { getIntervalFromTierFrequency, TierFrequencyKey } from '../../../graphql/v2/enum/TierFrequency';
import models, { Order } from '../../../models';

export enum ContributionAccountingCategoryRuleSubject {
  description = 'description',
  amount = 'amount',
  currency = 'currency',
  frequency = 'frequency',
  toAccount = 'toAccount',
  toAccountType = 'toAccountType',
  fromAccountType = 'fromAccountType',
  tierType = 'tierType',
  paymentProcessor = 'paymentProcessor',
}

export enum ContributionAccountingCategoryRuleOperator {
  eq = 'eq',
  gte = 'gte',
  lte = 'lte',
  contains = 'contains',
  in = 'in',
  childrenOf = 'childrenOf',
}

export type ContributionAccountingCategoryRulePredicate = {
  subject: ContributionAccountingCategoryRuleSubject;
  operator: ContributionAccountingCategoryRuleOperator;
  value: string | number | string[] | number[];
};

const CONTRIBUTION_ACCOUNTING_CATEGORY_RULE_FREQUENCIES: TierFrequencyKey[] = Object.values(TierFrequencyKey).filter(
  value => value !== TierFrequencyKey.FLEXIBLE,
);
const CONTRIBUTION_ACCOUNTING_CATEGORY_RULE_PAYMENT_PROCESSORS = [
  PAYMENT_METHOD_SERVICE.PAYPAL,
  PAYMENT_METHOD_SERVICE.STRIPE,
  PAYMENT_METHOD_SERVICE.OPENCOLLECTIVE,
];
const CONTRIBUTION_ACCOUNTING_CATEGORY_RULE_PAYMENT_PROCESSORS_LOWERCASE =
  CONTRIBUTION_ACCOUNTING_CATEGORY_RULE_PAYMENT_PROCESSORS.map(processor => processor.toLowerCase());
const nonEmptyStringSchema = z.string().min(1);
const nonEmptyStringArraySchema = z.array(nonEmptyStringSchema).nonempty();
const accountTypeSchema = z.nativeEnum(CollectiveType);
const tierTypeSchema = z.nativeEnum(Tiers);
const frequencySchema = z.enum(CONTRIBUTION_ACCOUNTING_CATEGORY_RULE_FREQUENCIES as [string, ...string[]]);
const paymentProcessorSchema = nonEmptyStringSchema.refine(
  value => CONTRIBUTION_ACCOUNTING_CATEGORY_RULE_PAYMENT_PROCESSORS_LOWERCASE.includes(value.toLowerCase()),
  { message: 'Invalid payment processor' },
);

const contributionAccountingCategoryRulePredicateValueSchema: Record<
  ContributionAccountingCategoryRuleSubject,
  Partial<Record<ContributionAccountingCategoryRuleOperator, z.ZodTypeAny>>
> = {
  [ContributionAccountingCategoryRuleSubject.description]: {
    [ContributionAccountingCategoryRuleOperator.contains]: nonEmptyStringSchema,
  },
  [ContributionAccountingCategoryRuleSubject.amount]: {
    [ContributionAccountingCategoryRuleOperator.eq]: z.number().min(0),
    [ContributionAccountingCategoryRuleOperator.gte]: z.number().min(0),
    [ContributionAccountingCategoryRuleOperator.lte]: z.number().min(0),
  },
  [ContributionAccountingCategoryRuleSubject.currency]: {
    [ContributionAccountingCategoryRuleOperator.eq]: nonEmptyStringSchema.refine(
      value => SUPPORTED_CURRENCIES.includes(value as SupportedCurrency),
      { message: 'Invalid currency' },
    ),
  },
  [ContributionAccountingCategoryRuleSubject.frequency]: {
    [ContributionAccountingCategoryRuleOperator.eq]: frequencySchema,
    [ContributionAccountingCategoryRuleOperator.in]: z.array(frequencySchema).nonempty(),
  },
  [ContributionAccountingCategoryRuleSubject.toAccount]: {
    [ContributionAccountingCategoryRuleOperator.eq]: nonEmptyStringSchema.transform(async value => {
      const collective = await models.Collective.findOne({ where: { slug: value }, attributes: ['slug'] });
      if (!collective) {
        throw new Error('Invalid account');
      }
      return collective.slug;
    }),
    [ContributionAccountingCategoryRuleOperator.in]: nonEmptyStringArraySchema.transform(async value => {
      const accounts = await Promise.all(
        value.map(v => models.Collective.findOne({ where: { slug: v }, attributes: ['slug'] })),
      );
      if (accounts.some(account => !account)) {
        throw new Error('Invalid account');
      }
      return accounts.map(account => account.slug);
    }),
  },
  [ContributionAccountingCategoryRuleSubject.toAccountType]: {
    [ContributionAccountingCategoryRuleOperator.eq]: accountTypeSchema,
    [ContributionAccountingCategoryRuleOperator.in]: z.array(accountTypeSchema).nonempty(),
  },
  [ContributionAccountingCategoryRuleSubject.fromAccountType]: {
    [ContributionAccountingCategoryRuleOperator.eq]: accountTypeSchema,
    [ContributionAccountingCategoryRuleOperator.in]: z.array(accountTypeSchema).nonempty(),
  },
  [ContributionAccountingCategoryRuleSubject.tierType]: {
    [ContributionAccountingCategoryRuleOperator.eq]: tierTypeSchema,
    [ContributionAccountingCategoryRuleOperator.in]: z.array(tierTypeSchema).nonempty(),
  },
  [ContributionAccountingCategoryRuleSubject.paymentProcessor]: {
    [ContributionAccountingCategoryRuleOperator.eq]: paymentProcessorSchema,
    [ContributionAccountingCategoryRuleOperator.in]: z.array(paymentProcessorSchema).nonempty(),
  },
};

const ContributionAccountingCategoryRulePredicateSchema = z
  .object({
    subject: z.nativeEnum(ContributionAccountingCategoryRuleSubject),
    operator: z.nativeEnum(ContributionAccountingCategoryRuleOperator),
    value: z.unknown(),
  })
  .superRefine((predicate, ctx) => {
    const operatorSchema =
      contributionAccountingCategoryRulePredicateValueSchema[predicate.subject]?.[predicate.operator];
    if (!operatorSchema) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Invalid operator: ${predicate.operator}`,
      });
    }
  })
  .transform(async predicate => {
    const operatorSchema =
      contributionAccountingCategoryRulePredicateValueSchema[predicate.subject]?.[predicate.operator];
    if (!operatorSchema) {
      throw new Error(`Invalid operator: ${predicate.operator}`);
    }

    try {
      const normalizedValue = await operatorSchema.parseAsync(predicate.value);
      return { ...predicate, value: normalizedValue } as ContributionAccountingCategoryRulePredicate;
    } catch {
      throw new Error(`Invalid value: ${predicate.value}`);
    }
  });

export async function validateAndNormalizeContributionAccountingCategoryRulePredicate(
  predicate: ContributionAccountingCategoryRulePredicate,
): Promise<ContributionAccountingCategoryRulePredicate> {
  try {
    return await ContributionAccountingCategoryRulePredicateSchema.parseAsync(predicate);
  } catch (error) {
    if (error instanceof ZodError && error.issues[0]?.message) {
      const firstIssue = error.issues[0];
      if (firstIssue.path[0] === 'subject') {
        throw new Error(`Invalid subject: ${predicate.subject}`);
      }
      throw new Error(error.issues[0].message);
    }
    throw error;
  }
}

export const ContributionAccountingCategoryRuleSubjectMatcher = {
  [ContributionAccountingCategoryRuleSubject.description]: async (
    operator: ContributionAccountingCategoryRuleOperator,
    value: unknown,
    order: Order,
  ) => {
    return typeof value === 'string' && value.length > 0 && order.description.includes(value as string);
  },
  [ContributionAccountingCategoryRuleSubject.amount]: async (
    operator: ContributionAccountingCategoryRuleOperator,
    value: unknown,
    order: Order,
  ) => {
    if (typeof value !== 'number') {
      return false;
    }

    switch (operator) {
      case ContributionAccountingCategoryRuleOperator.eq:
        return order.totalAmount === value;
      case ContributionAccountingCategoryRuleOperator.gte:
        return order.totalAmount >= value;
      case ContributionAccountingCategoryRuleOperator.lte:
        return order.totalAmount <= value;
    }
  },
  [ContributionAccountingCategoryRuleSubject.currency]: async (
    operator: ContributionAccountingCategoryRuleOperator,
    value: unknown,
    order: Order,
  ) => {
    return order.currency === value;
  },
  [ContributionAccountingCategoryRuleSubject.frequency]: async (
    operator: ContributionAccountingCategoryRuleOperator,
    value: unknown,
    order: Order,
  ) => {
    switch (operator) {
      case ContributionAccountingCategoryRuleOperator.eq:
        return order.interval === getIntervalFromTierFrequency(value as TierFrequencyKey);
      case ContributionAccountingCategoryRuleOperator.in:
        return (
          Array.isArray(value) &&
          value.length > 0 &&
          value.some(v => getIntervalFromTierFrequency(v as TierFrequencyKey) === order.interval)
        );
    }
  },
  [ContributionAccountingCategoryRuleSubject.toAccount]: async (
    operator: ContributionAccountingCategoryRuleOperator,
    value: unknown,
    order: Order,
  ) => {
    const collective = order.collective || (await order.getCollective());
    if (!collective) {
      return false;
    }
    switch (operator) {
      case ContributionAccountingCategoryRuleOperator.eq:
        return collective.slug === value;
      case ContributionAccountingCategoryRuleOperator.in:
        return Array.isArray(value) && value.length > 0 && value.includes(collective.slug);
    }
  },
  [ContributionAccountingCategoryRuleSubject.toAccountType]: async (
    operator: ContributionAccountingCategoryRuleOperator,
    value: unknown,
    order: Order,
  ) => {
    const collective = order.collective || (await order.getCollective());
    if (!collective) {
      return false;
    }
    switch (operator) {
      case ContributionAccountingCategoryRuleOperator.eq:
        return collective.type === value;
      case ContributionAccountingCategoryRuleOperator.in:
        return Array.isArray(value) && value.length > 0 && value.includes(collective.type);
    }
  },
  [ContributionAccountingCategoryRuleSubject.fromAccountType]: async (
    operator: ContributionAccountingCategoryRuleOperator,
    value: unknown,
    order: Order,
  ) => {
    const collective = order.fromCollective || (await order.getFromCollective());
    switch (operator) {
      case ContributionAccountingCategoryRuleOperator.eq:
        return collective.type === value;
      case ContributionAccountingCategoryRuleOperator.in:
        return Array.isArray(value) && value.length > 0 && value.includes(collective.type);
    }
  },
  [ContributionAccountingCategoryRuleSubject.tierType]: async (
    operator: ContributionAccountingCategoryRuleOperator,
    value: unknown,
    order: Order,
  ) => {
    if (!order.TierId) {
      return false;
    }

    const tier = order.Tier || (await order.getTier());
    if (!tier) {
      return false;
    }

    switch (operator) {
      case ContributionAccountingCategoryRuleOperator.eq:
        return tier.type === value;
      case ContributionAccountingCategoryRuleOperator.in:
        return Array.isArray(value) && value.length > 0 && value.includes(tier.type);
    }
  },
  [ContributionAccountingCategoryRuleSubject.paymentProcessor]: async (
    operator: ContributionAccountingCategoryRuleOperator,
    value: unknown,
    order: Order,
  ) => {
    const paymentMethod = order.paymentMethod || (await order.getPaymentMethod());
    if (!paymentMethod) {
      return false;
    }
    const paymentMethodService = paymentMethod.service.toLowerCase();
    switch (operator) {
      case ContributionAccountingCategoryRuleOperator.eq:
        return typeof value === 'string' && paymentMethodService === value.toLowerCase();
      case ContributionAccountingCategoryRuleOperator.in:
        return (
          Array.isArray(value) &&
          value.length > 0 &&
          value.some(v => typeof v === 'string' && paymentMethodService === v.toLowerCase())
        );
    }
  },
};
