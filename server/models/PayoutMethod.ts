import { get, isEmpty, omit, pick } from 'lodash';
import {
  CreationOptional,
  DataTypes,
  FindOptions,
  ForeignKey,
  InferAttributes,
  InferCreationAttributes,
  Model,
  NonAttribute,
  Transaction,
} from 'sequelize';
import isEmail from 'validator/lib/isEmail';

import logger from '../lib/logger';
import sequelize, { Op } from '../lib/sequelize';
import { objHasOnlyKeys } from '../lib/utils';
import { RecipientAccount as BankAccountPayoutMethodData } from '../types/transferwise';

import Collective from './Collective';
import User from './User';

/**
 * Match the Postgres enum defined for `PayoutMethods` > `type`
 */
export enum PayoutMethodTypes {
  OTHER = 'OTHER',
  PAYPAL = 'PAYPAL',
  BANK_ACCOUNT = 'BANK_ACCOUNT',
  ACCOUNT_BALANCE = 'ACCOUNT_BALANCE',
  CREDIT_CARD = 'CREDIT_CARD',
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
];

/** An interface for the values stored in `data` field for PayPal payout methods */
interface PaypalPayoutMethodData {
  email: string;
}

/** An interface for the values stored in `data` field for Custom payout methods */
interface OtherPayoutMethodData {
  content: string;
}

/** Group all the possible types for payout method's data */
type PayoutMethodDataType =
  | PaypalPayoutMethodData
  | OtherPayoutMethodData
  | BankAccountPayoutMethodData
  | Record<string, unknown>;

/**
 * Sequelize model to represent an PayoutMethod, linked to the `PayoutMethods` table.
 */
class PayoutMethod extends Model<InferAttributes<PayoutMethod>, InferCreationAttributes<PayoutMethod>> {
  public declare readonly id: CreationOptional<number>;
  public declare type: PayoutMethodTypes;
  public declare createdAt: CreationOptional<Date>;
  public declare updatedAt: CreationOptional<Date>;
  public declare deletedAt: CreationOptional<Date>;
  public declare name: string;
  public declare isSaved: boolean;
  public declare CollectiveId: number;
  public declare CreatedByUserId: ForeignKey<User['id']>;

  public declare Collective?: Collective;

  private static editableFields = ['data', 'name', 'isSaved'];

  /** A whitelist filter on `data` field. The returned object is safe to send to allowed users. */
  get data(): PayoutMethodDataType {
    switch (this.type) {
      case PayoutMethodTypes.PAYPAL:
        return { email: this.data['email'] } as PaypalPayoutMethodData;
      case PayoutMethodTypes.OTHER:
        return { content: this.data['content'] } as OtherPayoutMethodData;
      case PayoutMethodTypes.BANK_ACCOUNT:
        return this.data as BankAccountPayoutMethodData;
      default:
        return {};
    }
  }

  /** Returns the raw data for this field. Includes sensitive information that should not be leaked to the user */
  get unfilteredData(): NonAttribute<Record<string, unknown>> {
    return <Record<string, unknown>>this.getDataValue('data');
  }

  /**
   * Create a payout method from user-submitted data.
   * @param payoutMethodData: The (potentially unsafe) user data. Fields will be whitelisted.
   * @param user: User creating this payout method
   */
  static async createFromData(
    payoutMethodData: Record<string, unknown>,
    user: User,
    collective: Collective,
    dbTransaction: Transaction | null,
  ): Promise<PayoutMethod> {
    const cleanData = PayoutMethod.cleanData(payoutMethodData);
    const type = payoutMethodData['type'] as string;
    if (!(type in PayoutMethodTypes)) {
      throw new Error(`Invalid payout method type: ${type}`);
    }

    return PayoutMethod.create(
      { ...cleanData, type: type as PayoutMethodTypes, CreatedByUserId: user.id, CollectiveId: collective.id },
      { transaction: dbTransaction },
    );
  }

  /**
   * Get or create a payout method from data.
   * @param payoutMethodData: The (potentially unsafe) user data. Fields will be whitelisted.
   * @param user: User creating this
   */
  static async getOrCreateFromData(
    payoutMethodData: Record<string, unknown>,
    user: User,
    collective: Collective,
    dbTransaction: Transaction | null,
  ): Promise<PayoutMethod> {
    // We try to load the existing payment method if it exists for this collective
    let existingPm = null;
    if (payoutMethodData['type'] === PayoutMethodTypes.PAYPAL) {
      const email = get(payoutMethodData, 'data.email');
      if (email && typeof email === 'string' && isEmail(email)) {
        existingPm = await PayoutMethod.scope('paypal').findOne({
          where: {
            CollectiveId: collective.id,
            data: { email },
          },
        });
      }
    } else if (payoutMethodData['type'] === PayoutMethodTypes.ACCOUNT_BALANCE) {
      // Just in case as the model doesn't accept empty data
      if (!payoutMethodData.data) {
        payoutMethodData.data = {};
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
    return existingPm || this.createFromData(payoutMethodData, user, collective, dbTransaction);
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
    return [PayoutMethodTypes.BANK_ACCOUNT, PayoutMethodTypes.OTHER].includes(payoutMethodType);
  };

  /** Filters out all the fields that cannot be edited by user */
  private static cleanData(data: Record<string, unknown>): Record<string, unknown> {
    return pick(data, PayoutMethod.editableFields);
  }

  async findSimilar({ include, where }: Partial<Pick<FindOptions, 'include' | 'where'>> = {}) {
    let data;
    if (this.type === PayoutMethodTypes.BANK_ACCOUNT) {
      const keyDetailFields = IDENTIFIABLE_DATA_FIELDS;
      if (this.unfilteredData?.type === 'email') {
        keyDetailFields.push('email');
      }
      data = pick(this.unfilteredData, ['type', ...keyDetailFields.map(k => `details.${k}`)]);
    } else if (this.type === PayoutMethodTypes.PAYPAL) {
      data = { email: this.unfilteredData.email };
    }
    if (!isEmpty(omit(data, 'type'))) {
      return PayoutMethod.findAll({ where: { ...where, id: { [Op.ne]: this.id }, data }, include });
    } else {
      logger.warn(`Couldn't pick identifiable data fields from PayoutMethod #${this.id}`);
      return [];
    }
  }
}

// Link the model to database fields
PayoutMethod.init(
  {
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
          if (this.type === PayoutMethodTypes.PAYPAL) {
            if (!value || !value.email || !isEmail(value.email)) {
              throw new Error('Invalid PayPal email address');
            } else if (!objHasOnlyKeys(value, ['email'])) {
              throw new Error('Data for this payout method contains too much information');
            }
          } else if (this.type === PayoutMethodTypes.OTHER) {
            if (!value || !value.content || typeof value.content !== 'string') {
              throw new Error('Invalid format of custom payout method');
            } else if (!objHasOnlyKeys(value, ['content'])) {
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
  },
);

export default PayoutMethod;
