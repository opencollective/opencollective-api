import { SupportedCurrency } from '../constants/currencies';
import { RefundKind } from '../constants/refund-kind';
import Order from '../models/Order';
import PaymentMethod from '../models/PaymentMethod';
import Transaction from '../models/Transaction';
import User from '../models/User';
import VirtualCardModel from '../models/VirtualCard';

export interface BasePaymentProviderService {
  /**
   * Describes the features implemented by this payment method
   */
  features: {
    recurring: boolean;
    isRecurringManagedExternally?: boolean;
    waitToCharge?: boolean;
  };

  /**
   * Triggers the payment for this order and updates it accordingly
   */
  processOrder(
    order: Order,
    options?: { isAddedFund?: boolean; invoiceTemplate?: string },
  ): Promise<Transaction | void>;

  /**
   * Refunds a transaction processed with this payment provider service
   */
  refundTransaction(
    transaction: Transaction,
    user?: User,
    reason?: string,
    refundKind?: RefundKind,
    options?: { ignoreBalanceCheck?: boolean },
  ): Promise<Transaction>;

  /**
   * Refunds a transaction processed with this payment provider service without calling the payment provider
   */
  refundTransactionOnlyInDatabase?(
    transaction: Transaction,
    user?: User,
    reason?: string,
    refundKind?: RefundKind,
    options?: { ignoreBalanceCheck?: boolean },
  ): Promise<Transaction>;

  getBalance?: (
    paymentMethod: PaymentMethod,
    params?: { currency?: SupportedCurrency },
  ) => Promise<number | { amount: number; currency: SupportedCurrency }>;

  updateBalance?: (paymentMethod: PaymentMethod) => Promise<number>;
}

export interface PaymentProviderServiceWithoutRecurring extends BasePaymentProviderService {
  features: BasePaymentProviderService['features'] & {
    recurring: false;
    isRecurringManagedExternally: never;
  };
}

export interface PaymentProviderServiceWithInternalRecurringManagement extends BasePaymentProviderService {
  features: BasePaymentProviderService['features'] & {
    recurring: true;
    isRecurringManagedExternally: false;
  };
}

export interface PaymentMethodServiceWithExternalRecurringManagement extends BasePaymentProviderService {
  features: BasePaymentProviderService['features'] & {
    recurring: true;
    isRecurringManagedExternally: true;
  };

  /**
   * For external recurring management, use this method to define how pausing a subscription should be handled.
   */
  pauseSubscription?: (order: Order, reason: string) => Promise<void>;

  /**
   * For external recurring management, use this method to define how resuming a subscription should be handled.
   */
  resumeSubscription?: (order: Order, reason: string) => Promise<void>;
}

export type PaymentProviderService =
  | PaymentProviderServiceWithoutRecurring
  | PaymentProviderServiceWithInternalRecurringManagement
  | PaymentMethodServiceWithExternalRecurringManagement;

export interface PaymentProvider {
  /**
   * Triggers the payment for this order and updates it accordingly
   */
  processOrder(order: Order): Promise<Transaction>;

  /**
   * The different types of payment methods supported by this provider
   */
  types: Record<string, PaymentProviderService>;
}

export interface CardProviderService {
  // Standardized
  deleteCard(virtualCard: VirtualCardModel): Promise<void>;
  pauseCard(virtualCard: VirtualCardModel): Promise<VirtualCardModel>;
  resumeCard(virtualCard: VirtualCardModel): Promise<VirtualCardModel>;

  // To be standardized
  processTransaction: any;
  assignCardToCollective: any;
  autoPauseResumeCard(virtualCard: VirtualCardModel): Promise<void>;
}

export const isPaymentProviderWithExternalRecurring = (
  paymentProvider: PaymentProviderService,
): paymentProvider is PaymentMethodServiceWithExternalRecurringManagement => {
  return paymentProvider.features.isRecurringManagedExternally;
};
