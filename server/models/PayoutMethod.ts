import { get, pick } from 'lodash';
import { DataTypes, Model, Transaction } from 'sequelize';
import { isEmail } from 'validator';

import restoreSequelizeAttributesOnClass from '../lib/restore-sequelize-attributes-on-class';
import sequelize from '../lib/sequelize';
import { objHasOnlyKeys } from '../lib/utils';
import { RecipientAccount as BankAccountPayoutMethodData } from '../types/transferwise';

import models from '.';

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

/** An interface for the values stored in `data` field for PayPal payout methods */
export interface PaypalPayoutMethodData {
  email: string;
}

/** An interface for the values stored in `data` field for Custom payout methods */
export interface OtherPayoutMethodData {
  content: string;
}

/** Group all the possible types for payout method's data */
export type PayoutMethodDataType =
  | PaypalPayoutMethodData
  | OtherPayoutMethodData
  | BankAccountPayoutMethodData
  | Record<string, unknown>;

/**
 * Sequelize model to represent an PayoutMethod, linked to the `PayoutMethods` table.
 */
export class PayoutMethod extends Model {
  public readonly id!: number;
  public type!: PayoutMethodTypes;
  public createdAt!: Date;
  public updatedAt!: Date;
  public deletedAt: Date;
  public name: string;
  public isSaved: boolean;
  public CollectiveId!: number;
  public CreatedByUserId!: number;

  private static editableFields = ['data', 'name', 'isSaved'];

  constructor(...args) {
    super(...args);
    restoreSequelizeAttributesOnClass(new.target, this);
  }

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
  get unfilteredData(): Record<string, unknown> {
    return this.getDataValue('data');
  }

  /**
   * Create a payout method from user-submitted data.
   * @param payoutMethodData: The (potentially unsafe) user data. Fields will be whitelisted.
   * @param user: User creating this payout method
   */
  static async createFromData(
    payoutMethodData: Record<string, unknown>,
    user: typeof models.User,
    collective: typeof models.Collective,
    dbTransaction: Transaction | null,
  ): Promise<PayoutMethod> {
    const cleanData = PayoutMethod.cleanData(payoutMethodData);
    return PayoutMethod.create(
      { ...cleanData, type: payoutMethodData['type'], CreatedByUserId: user.id, CollectiveId: collective.id },
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
    user: typeof models.User,
    collective: typeof models.Collective,
    dbTransaction: Transaction | null,
  ): Promise<PayoutMethod> {
    // We try to load the existing payment method if it exists for this collective
    let existingPm = null;
    if (payoutMethodData['type'] === PayoutMethodTypes.PAYPAL) {
      const email = get(payoutMethodData, 'data.email');
      if (email && isEmail(email)) {
        existingPm = await PayoutMethod.scope('paypal').findOne({
          where: {
            CollectiveId: collective.id,
            data: { email },
          },
        });
      }
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
      return 'Wire Transfer';
    } else {
      return 'Other';
    }
  }

  /** Filters out all the fields that cannot be edited by user */
  private static cleanData(data: Record<string, unknown>): Record<string, unknown> {
    return pick(data, PayoutMethod.editableFields);
  }
}

function setupModel(PayoutMethod) {
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
}

// We're using the setupModel function to keep the indentation and have a clearer git history.
// Please consider this if you plan to refactor.
setupModel(PayoutMethod);

export default PayoutMethod;
