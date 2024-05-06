import { SupportedCurrency } from '../constants/currencies';
import Order from '../models/Order';
import { PaymentMethodModelInterface } from '../models/PaymentMethod';
import Transaction from '../models/Transaction';
import User from '../models/User';
import VirtualCardModel from '../models/VirtualCard';

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

export interface PaymentProviderService {
  /**
   * Describes the features implemented by this payment method
   */
  features: {
    recurring: boolean;
    isRecurringManagedExternally: boolean;
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
  refundTransaction(transaction: Transaction, user?: User, reason?: string): Promise<Transaction>;

  /**
   * Refunds a transaction processed with this payment provider service without calling the payment provider
   */
  refundTransactionOnlyInDatabase?(transaction: Transaction, user?: User, reason?: string): Promise<Transaction>;

  getBalance?: (
    paymentMethod: PaymentMethodModelInterface,
  ) => Promise<number | { amount: number; currency: SupportedCurrency }>;

  updateBalance?: (paymentMethod: PaymentMethodModelInterface) => Promise<number>;
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
