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

function normalizeAccountType(operator: ContributionAccountingCategoryRuleOperator, value: unknown) {
  switch (operator) {
    case ContributionAccountingCategoryRuleOperator.eq:
      if (
        typeof value === 'string' &&
        value.length > 0 &&
        Object.values(CollectiveType).includes(value as CollectiveType)
      ) {
        return value;
      } else {
        throw new Error(`Invalid value: ${value}`);
      }
    case ContributionAccountingCategoryRuleOperator.in:
      if (
        Array.isArray(value) &&
        value.length > 0 &&
        value.every(v => Object.values(CollectiveType).includes(v as CollectiveType))
      ) {
        return value;
      } else {
        throw new Error(`Invalid value: ${value}`);
      }
  }
}

export const ContributionAccountingCategoryRuleSubjectDefinition = {
  [ContributionAccountingCategoryRuleSubject.description]: {
    operators: [ContributionAccountingCategoryRuleOperator.contains],
    normalize: async (operator: ContributionAccountingCategoryRuleOperator, value: unknown) => {
      if (typeof value === 'string' && value.length > 0) {
        return value;
      } else {
        throw new Error(`Invalid value: ${value}`);
      }
    },
    matches: async (operator: ContributionAccountingCategoryRuleOperator, value: unknown, order: Order) => {
      return typeof value === 'string' && value.length > 0 && order.description.includes(value as string);
    },
  },
  [ContributionAccountingCategoryRuleSubject.amount]: {
    operators: [
      ContributionAccountingCategoryRuleOperator.eq,
      ContributionAccountingCategoryRuleOperator.gte,
      ContributionAccountingCategoryRuleOperator.lte,
    ],
    normalize: async (operator: ContributionAccountingCategoryRuleOperator, value: unknown) => {
      if (typeof value === 'number' && value >= 0) {
        return value;
      } else {
        throw new Error(`Invalid value: ${value}`);
      }
    },
    matches: async (operator: ContributionAccountingCategoryRuleOperator, value: unknown, order: Order) => {
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
  },
  [ContributionAccountingCategoryRuleSubject.currency]: {
    operators: [ContributionAccountingCategoryRuleOperator.eq],
    normalize: async (operator: ContributionAccountingCategoryRuleOperator, value: unknown) => {
      if (typeof value === 'string' && value.length > 0 && SUPPORTED_CURRENCIES.includes(value as SupportedCurrency)) {
        return value;
      } else {
        throw new Error(`Invalid value: ${value}`);
      }
    },
    matches: async (operator: ContributionAccountingCategoryRuleOperator, value: unknown, order: Order) => {
      return order.currency === value;
    },
  },
  [ContributionAccountingCategoryRuleSubject.frequency]: {
    operators: [ContributionAccountingCategoryRuleOperator.eq, ContributionAccountingCategoryRuleOperator.in],
    normalize: async (operator: ContributionAccountingCategoryRuleOperator, value: unknown) => {
      switch (operator) {
        case ContributionAccountingCategoryRuleOperator.eq:
          if (
            typeof value === 'string' &&
            value.length > 0 &&
            Object.values(TierFrequencyKey)
              .filter(v => v !== TierFrequencyKey.FLEXIBLE)
              .includes(value as any)
          ) {
            return value;
          } else {
            throw new Error(`Invalid value: ${value}`);
          }
        case ContributionAccountingCategoryRuleOperator.in:
          if (
            Array.isArray(value) &&
            value.length > 0 &&
            value.every(v =>
              Object.values(TierFrequencyKey)
                .filter(v => v !== TierFrequencyKey.FLEXIBLE)
                .includes(v),
            )
          ) {
            return value;
          } else {
            throw new Error(`Invalid value: ${value}`);
          }
      }
    },
    matches: async (operator: ContributionAccountingCategoryRuleOperator, value: unknown, order: Order) => {
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
  },
  [ContributionAccountingCategoryRuleSubject.toAccount]: {
    operators: [ContributionAccountingCategoryRuleOperator.eq, ContributionAccountingCategoryRuleOperator.in],
    normalize: async (operator: ContributionAccountingCategoryRuleOperator, value: unknown) => {
      switch (operator) {
        case ContributionAccountingCategoryRuleOperator.eq: {
          if (typeof value !== 'string' || value.length === 0) {
            throw new Error(`Invalid value: ${value}`);
          }
          const collective = await models.Collective.findOne({ where: { slug: value }, attributes: ['id', 'slug'] });
          if (collective) {
            return collective.slug;
          } else {
            throw new Error(`Invalid value: ${value}`);
          }
        }
        case ContributionAccountingCategoryRuleOperator.in: {
          if (!Array.isArray(value) || value.length === 0) {
            throw new Error(`Invalid value: ${value}`);
          }

          const accounts = await Promise.all(
            value.map(v => models.Collective.findOne({ where: { slug: v }, attributes: ['slug'] })),
          );
          if (accounts.every(account => account !== null)) {
            return accounts.map(account => account.slug);
          } else {
            throw new Error(`Invalid value: ${value}`);
          }
        }
      }
    },
    matches: async (operator: ContributionAccountingCategoryRuleOperator, value: unknown, order: Order) => {
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
  },
  [ContributionAccountingCategoryRuleSubject.toAccountType]: {
    operators: [ContributionAccountingCategoryRuleOperator.eq, ContributionAccountingCategoryRuleOperator.in],
    normalize: normalizeAccountType,
    matches: async (operator: ContributionAccountingCategoryRuleOperator, value: unknown, order: Order) => {
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
  },
  [ContributionAccountingCategoryRuleSubject.fromAccountType]: {
    operators: [ContributionAccountingCategoryRuleOperator.eq, ContributionAccountingCategoryRuleOperator.in],
    normalize: normalizeAccountType,
    matches: async (operator: ContributionAccountingCategoryRuleOperator, value: unknown, order: Order) => {
      const collective = order.fromCollective || (await order.getFromCollective());
      switch (operator) {
        case ContributionAccountingCategoryRuleOperator.eq:
          return collective.type === value;
        case ContributionAccountingCategoryRuleOperator.in:
          return Array.isArray(value) && value.length > 0 && value.includes(collective.type);
      }
    },
  },
  [ContributionAccountingCategoryRuleSubject.tierType]: {
    operators: [ContributionAccountingCategoryRuleOperator.eq, ContributionAccountingCategoryRuleOperator.in],
    normalize: async (operator: ContributionAccountingCategoryRuleOperator, value: unknown) => {
      switch (operator) {
        case ContributionAccountingCategoryRuleOperator.eq:
          if (typeof value === 'string' && value.length > 0 && Object.values(Tiers).includes(value as Tiers)) {
            return value;
          } else {
            throw new Error(`Invalid value: ${value}`);
          }
        case ContributionAccountingCategoryRuleOperator.in:
          if (Array.isArray(value) && value.length > 0 && value.every(v => Object.values(Tiers).includes(v))) {
            return value;
          } else {
            throw new Error(`Invalid value: ${value}`);
          }
      }
    },
    matches: async (operator: ContributionAccountingCategoryRuleOperator, value: unknown, order: Order) => {
      if (!order.TierId) {
        return false;
      }

      const tier = order.Tier || (await order.getTier());
      if (!tier) {
        return false;
      }

      switch (operator) {
        case ContributionAccountingCategoryRuleOperator.eq:
          return tier.id === value;
        case ContributionAccountingCategoryRuleOperator.in:
          return Array.isArray(value) && value.length > 0 && value.includes(tier.id);
      }
    },
  },
  [ContributionAccountingCategoryRuleSubject.paymentProcessor]: {
    operators: [ContributionAccountingCategoryRuleOperator.eq, ContributionAccountingCategoryRuleOperator.in],
    normalize: async (operator: ContributionAccountingCategoryRuleOperator, value: unknown) => {
      switch (operator) {
        case ContributionAccountingCategoryRuleOperator.eq:
          if (
            typeof value === 'string' &&
            value.length > 0 &&
            [
              PAYMENT_METHOD_SERVICE.PAYPAL,
              PAYMENT_METHOD_SERVICE.STRIPE,
              PAYMENT_METHOD_SERVICE.OPENCOLLECTIVE,
            ].includes(value.toLowerCase() as any)
          ) {
            return value;
          } else {
            throw new Error(`Invalid value: ${value}`);
          }
        case ContributionAccountingCategoryRuleOperator.in:
          if (
            Array.isArray(value) &&
            value.length > 0 &&
            value.every(v =>
              [
                PAYMENT_METHOD_SERVICE.PAYPAL,
                PAYMENT_METHOD_SERVICE.STRIPE,
                PAYMENT_METHOD_SERVICE.OPENCOLLECTIVE,
              ].includes(v.toLowerCase() as any),
            )
          ) {
            return value;
          } else {
            throw new Error(`Invalid value: ${value}`);
          }
      }
    },
    matches: async (operator: ContributionAccountingCategoryRuleOperator, value: unknown, order: Order) => {
      const paymentMethod = order.paymentMethod || (await order.getPaymentMethod());
      if (!paymentMethod) {
        return false;
      }
      return paymentMethod.service.toLowerCase() === (value as string).toLowerCase();
    },
  },
};
