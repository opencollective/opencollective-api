import { get, isEmpty, omit, pick } from 'lodash';
import {
  CreationOptional,
  DataTypes,
  FindOptions,
  ForeignKey,
  InferAttributes,
  InferCreationAttributes,
  Transaction,
} from 'sequelize';
import isEmail from 'validator/lib/isEmail';

import { SUPPORTED_CURRENCIES, SupportedCurrency } from '../constants/currencies';
import ExpenseStatuses from '../constants/expense-status';
import logger from '../lib/logger';
import { EntityShortIdPrefix } from '../lib/permalink/entity-map';
import { reportMessageToSentry } from '../lib/sentry';
import sequelize, { Op } from '../lib/sequelize';
import { objHasOnlyKeys } from '../lib/utils';
import { PayPalSupportedCurrencies } from '../paymentProviders/paypal/constants';
import { PaypalUserInfo } from '../paymentProviders/paypal/types';
import { RecipientAccount as BankAccountPayoutMethodData } from '../types/transferwise';

import type { Collective, Expense, User } from '.';
import { ModelWithPublicId } from './ModelWithPublicId';

/**
 * Match the Postgres enum defined for `PayoutMethods` > `type`
 */
export enum PayoutMethodTypes {
  OTHER = 'OTHER',
  PAYPAL = 'PAYPAL',
  BANK_ACCOUNT = 'BANK_ACCOUNT',
  ACCOUNT_BALANCE = 'ACCOUNT_BALANCE',
  CREDIT_CARD = 'CREDIT_CARD',
  STRIPE = 'STRIPE', // Created by ConnectedAccount hooks on connected accounts of type stripe.
}

export const IDENTIFIABLE_DATA_FIELDS = [
  'abartn',
  'accountNumber',
  'bankCode',
  'BIC',
  'billerCode',
  'branchCode',
  'bsbCode',
  'cardNumber',
  'cardToken',
  'customerReferenceNumber',
  'IBAN',
  'idDocumentNumber',
  'idDocumentType',
  'identificationNumber',
  'ifscCode',
  'institutionNumber',
  'interacAccount',
  'phoneNumber',
  'sortCode',
  'swiftCode',
  'transitNumber',
] as const;

/** An interface for the values stored in `data` field for PayPal payout methods */
export interface PaypalPayoutMethodData {
  email: string;
  /** ID of the ConnectedAccount that verified this PayPal account via OAuth */
  connectedAccountId?: number;
  verifiedAt?: string;
  currency?: string;
  paypalUserInfo?: PaypalUserInfo;
  isPayPalOAuth?: boolean;
}

interface StripePayoutMethodData {
  connectedAccountId: number;
  stripeAccountId: string;
  publishableKey: string;
}

/** An interface for the values stored in `data` field for Custom payout methods */
interface OtherPayoutMethodData {
  content: string;
}

/** Group all the possible types for payout method's data */
type PayoutMethodDataType = {
  currency?: string;
} & (
  | PaypalPayoutMethodData
  | OtherPayoutMethodData
  | StripePayoutMethodData
  | BankAccountPayoutMethodData
  | Record<string, unknown>
);

/**
 * Sequelize model to represent an PayoutMethod, linked to the `PayoutMethods` table.
 */
class PayoutMethod extends ModelWithPublicId<
  EntityShortIdPrefix.PayoutMethod,
  InferAttributes<PayoutMethod>,
  InferCreationAttributes<PayoutMethod>
> {
  public static readonly nanoIdPrefix = EntityShortIdPrefix.PayoutMethod;
  public static readonly tableName = 'PayoutMethods' as const;

  declare public readonly id: CreationOptional<number>;
  declare public type: PayoutMethodTypes;
  declare public createdAt: CreationOptional<Date>;
  declare public updatedAt: CreationOptional<Date>;
  declare public deletedAt: CreationOptional<Date>;
  declare public name: string;
  declare public data: PayoutMethodDataType;
  declare public isSaved: boolean;
  declare public CollectiveId: number;
  declare public CreatedByUserId: ForeignKey<User['id']>;
  declare public currency: SupportedCurrency | null;

  declare public Collective?: Collective;

  private static editableFields = ['name', 'isSaved', 'currency'] as const;

  public static getFilteredData(type: PayoutMethodTypes, data: PayoutMethodDataType): Partial<PayoutMethodDataType> {
    switch (type) {
      case PayoutMethodTypes.PAYPAL: {
        return pick(data, [
          'email',
          'verifiedAt',
          'currency',
          'isPayPalOAuth',
          'paypalUserInfo.name',
          'paypalUserInfo.email',
          'paypalUserInfo.payer_id',
          'paypalUserInfo.address.country',
        ]);
      }
      case PayoutMethodTypes.OTHER:
        return pick(data, ['currency', 'content']) as OtherPayoutMethodData;
      case PayoutMethodTypes.BANK_ACCOUNT:
        return data as BankAccountPayoutMethodData; // TODO: this should probably be filtered
      case PayoutMethodTypes.STRIPE:
        return pick(data, ['currency', 'stripeAccountId', 'publishableKey']) as StripePayoutMethodData;
      default:
        return pick(data, ['currency']);
    }
  }

  /** A whitelist filter on `data` field. The returned object is safe to send to allowed users. */
  public getFilteredData(): Partial<PayoutMethodDataType> {
    return PayoutMethod.getFilteredData(this.type, this.data);
  }

  /**
   * Create a payout method from user-submitted data.
   * @param userInput: The (potentially unsafe) user data. Fields will be whitelisted.
   * @param user: User creating this payout method
   */
  static async createFromUserData(
    userInput: Pick<PayoutMethod, (typeof PayoutMethod.editableFields)[number]> & {
      type: PayoutMethodTypes;
      data: PayoutMethodDataType;
    },
    user: User,
    collective: Collective,
    dbTransaction: Transaction | null | undefined = undefined,
  ): Promise<PayoutMethod> {
    const cleanInput = PayoutMethod.filterUserInput(userInput);
    const type = userInput['type'];
    if (!(type in PayoutMethodTypes)) {
      throw new Error(`Invalid payout method type: ${type}`);
    }

    const currency = cleanInput.currency || cleanInput.data?.currency;
    return PayoutMethod.create(
      { ...cleanInput, currency, type: type, CreatedByUserId: user.id, CollectiveId: collective.id },
      { transaction: dbTransaction },
    );
  }

  /**
   * Get or create a payout method from data.
   * @param userInput: The (potentially unsafe) user data. Fields will be whitelisted.
   * @param user: User creating this
   */
  static async getOrCreateFromUserData(
    userInput: Pick<PayoutMethod, (typeof PayoutMethod.editableFields)[number]> & {
      type: PayoutMethodTypes;
      data: PayoutMethodDataType;
    },
    user: User,
    collective: Collective,
    dbTransaction: Transaction | null,
  ): Promise<PayoutMethod> {
    // We try to load the existing payment method if it exists for this collective
    let existingPm = null;
    if (userInput['type'] === PayoutMethodTypes.PAYPAL) {
      const email = get(userInput, 'data.email');
      if (email && typeof email === 'string' && isEmail(email)) {
        existingPm = await PayoutMethod.scope('paypal').findOne({
          where: {
            CollectiveId: collective.id,
            data: { email },
          },
        });
      }
    } else if (userInput['type'] === PayoutMethodTypes.ACCOUNT_BALANCE) {
      // Just in case as the model doesn't accept empty data
      if (!userInput.data) {
        userInput.data = {};
      }
      existingPm = await PayoutMethod.findOne({
        order: [['isSaved', 'DESC']], // Prefer saved payout methods
        where: {
          CollectiveId: collective.id,
          type: PayoutMethodTypes.ACCOUNT_BALANCE,
        },
      });
    }

    // Otherwise we just call createFromData
    return existingPm || this.createFromUserData(userInput, user, collective, dbTransaction);
  }

  static getLabel(payoutMethod: PayoutMethod): string {
    if (!payoutMethod) {
      return 'Other';
    } else if (payoutMethod.type === PayoutMethodTypes.PAYPAL) {
      const email = (<PaypalPayoutMethodData>payoutMethod.data)?.email;
      return !email ? 'PayPal' : `PayPal (${email})`;
    } else if (payoutMethod.type === PayoutMethodTypes.BANK_ACCOUNT) {
      return 'Bank Transfer';
    } else {
      return 'Other';
    }
  }

  static typeSupportsFeesPayer = (payoutMethodType: PayoutMethodTypes): boolean => {
    return [PayoutMethodTypes.BANK_ACCOUNT, PayoutMethodTypes.OTHER, PayoutMethodTypes.STRIPE].includes(
      payoutMethodType,
    );
  };

  /** Filters out all the fields that cannot be edited by user */
  private static filterUserInput(input) {
    const type = input['type'] as PayoutMethodTypes;
    return {
      ...pick(input, PayoutMethod.editableFields),
      data: PayoutMethod.filterUserSubmittedData(type, input['data']),
    };
  }

  /** Whitelist filter on `data` field for user-submitted payloads. */
  static filterUserSubmittedData(
    type: PayoutMethodTypes,
    data: unknown,
    { isExistingPayPalOAuthMethod = false } = {},
  ): Record<string, unknown> {
    if (!data || typeof data !== 'object') {
      return {};
    }

    const dataObj = data as Record<string, unknown>;
    switch (type) {
      case PayoutMethodTypes.PAYPAL:
        return pick(dataObj, isExistingPayPalOAuthMethod ? ['currency'] : ['email', 'currency']);
      case PayoutMethodTypes.OTHER:
        return pick(dataObj, ['content', 'currency']);
      case PayoutMethodTypes.BANK_ACCOUNT: {
        const filtered: Record<string, unknown> = pick(dataObj, [
          'accountHolderName',
          'currency',
          'type',
          'legalType',
          'details',
        ]);
        return filtered;
      }
      case PayoutMethodTypes.CREDIT_CARD:
        return pick(dataObj, ['token', 'currency']);
      case PayoutMethodTypes.ACCOUNT_BALANCE:
      case PayoutMethodTypes.STRIPE:
      default:
        return pick(dataObj, ['currency']);
    }
  }

  async findSimilar({ include, where }: Partial<Pick<FindOptions, 'include' | 'where'>> = {}) {
    let data;
    if (this.type === PayoutMethodTypes.BANK_ACCOUNT) {
      const keyDetailFields: string[] = [...IDENTIFIABLE_DATA_FIELDS];
      if ((this.data as BankAccountPayoutMethodData)?.type === 'email') {
        keyDetailFields.push('email');
      }
      data = pick(this.data, ['type', ...keyDetailFields.map(k => `details.${k}`)]);
    } else if (this.type === PayoutMethodTypes.PAYPAL) {
      data = { email: (this.data as PaypalPayoutMethodData)?.email };
    }
    if (!isEmpty(omit(data, 'type'))) {
      return PayoutMethod.findAll({ where: { ...where, id: { [Op.ne]: this.id }, data }, include });
    } else {
      logger.warn(`Couldn't pick identifiable data fields from PayoutMethod #${this.id}`);
      return [];
    }
  }

  async canBeEdited(): Promise<boolean> {
    if (this.type === PayoutMethodTypes.STRIPE) {
      return false;
    }

    const expenses = await (sequelize.models.Expense as typeof Expense).findOne({
      where: {
        PayoutMethodId: this.id,
        status: {
          [Op.notIn]: [
            ExpenseStatuses.PENDING,
            ExpenseStatuses.DRAFT,
            ExpenseStatuses.CANCELED,
            ExpenseStatuses.REJECTED,
          ],
        },
      },
    });

    return !expenses;
  }

  async canBeDeleted({ transaction }: { transaction?: Transaction } = {}): Promise<boolean> {
    if (this.type === PayoutMethodTypes.STRIPE) {
      return false;
    }
    const expenses = await (sequelize.models.Expense as typeof Expense).findOne({
      where: {
        PayoutMethodId: this.id,
      },
      transaction,
    });

    return !expenses;
  }

  canBeArchived(): boolean {
    return this.type !== PayoutMethodTypes.STRIPE;
  }
}

// Link the model to database fields
PayoutMethod.init(
  {
    publicId: {
      type: DataTypes.STRING,
      unique: true,
    },
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    type: {
      // Enum entries must match `PayoutMethodType`
      type: DataTypes.ENUM(...Object.values(PayoutMethodTypes)),
      allowNull: false,
      validate: {
        isIn: {
          args: [Object.values(PayoutMethodTypes)],
          msg: `Must be one of ${Object.values(PayoutMethodTypes)}`,
        },
      },
    },
    data: {
      type: DataTypes.JSONB,
      allowNull: false,
      validate: {
        isValidValue(value): void {
          // General checks
          if (value && value.currency) {
            if (typeof value.currency !== 'string' || !SUPPORTED_CURRENCIES.includes(value.currency)) {
              throw new Error('Invalid currency');
            }
          }

          // Type-specific checks
          if (this.type === PayoutMethodTypes.PAYPAL) {
            if (!value || !value.email || !isEmail(value.email)) {
              throw new Error('Invalid PayPal email address');
            } else if (
              !objHasOnlyKeys(value, [
                'email',
                'currency',
                'connectedAccountId',
                'isPayPalOAuth',
                'verifiedAt',
                'paypalUserInfo',
              ])
            ) {
              throw new Error('Data for this payout method contains too much information');
            } else if (!PayPalSupportedCurrencies.includes(value.currency)) {
              throw new Error('This currency is not supported by PayPal');
            }
          } else if (this.type === PayoutMethodTypes.OTHER) {
            if (!value || !value.content || typeof value.content !== 'string') {
              throw new Error('Invalid format of custom payout method');
            } else if (!objHasOnlyKeys(value, ['content', 'currency'])) {
              throw new Error('Data for this payout method contains too much information');
            }
          } else if (this.type === PayoutMethodTypes.BANK_ACCOUNT) {
            if (!value || !value.accountHolderName || !value.currency || !value.type || !value.details) {
              throw new Error('Invalid format of BANK_ACCOUNT payout method data');
            }
          } else if (this.type === PayoutMethodTypes.CREDIT_CARD) {
            if (!value || !value.token) {
              throw new Error('Invalid format of CREDIT_CARD payout method data');
            }
          } else if (this.type === PayoutMethodTypes.STRIPE) {
            if (!value || !value.stripeAccountId || !value.connectedAccountId) {
              throw new Error('Invalid format of STRIPE payout method data');
            }
          } else if (!value || Object.keys(value).length > 0) {
            throw new Error('Data for this payout method is not properly formatted');
          }
        },
      },
    },
    createdAt: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
      allowNull: false,
    },
    updatedAt: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
      allowNull: false,
    },
    deletedAt: {
      type: DataTypes.DATE,
    },
    name: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    isSaved: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
    CollectiveId: {
      type: DataTypes.INTEGER,
      references: { model: 'Collectives', key: 'id' },
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
      allowNull: false,
    },
    CreatedByUserId: {
      type: DataTypes.INTEGER,
      references: { key: 'id', model: 'Users' },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
      allowNull: true,
    },
    currency: {
      type: DataTypes.STRING(3),
      allowNull: true,
      validate: {
        isIn: {
          args: [SUPPORTED_CURRENCIES],
          msg: 'Currency must be a supported currency',
        },
      },
    },
  },
  {
    sequelize,
    paranoid: true,
    tableName: 'PayoutMethods',
    scopes: {
      saved: {
        where: { isSaved: true },
      },
      paypal: {
        where: { type: PayoutMethodTypes.PAYPAL },
      },
    },
    hooks: {
      beforeValidate: (instance: PayoutMethod) => {
        // Auto-extract currency from data field if not explicitly set on the column
        const data = instance.getDataValue('data') as Record<string, unknown> | undefined;
        if (!instance.currency && data?.currency) {
          reportMessageToSentry(`Missing currency while creating payout method`, { extra: { data } });
          instance.currency = data.currency as SupportedCurrency;
        } else if (instance.currency && !data?.currency) {
          instance.data = { ...data, currency: instance.currency };
        }
      },
    },
  },
);

export default PayoutMethod;
