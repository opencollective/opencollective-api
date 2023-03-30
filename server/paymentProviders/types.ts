import models from '../models';
import { OrderModelInterface } from '../models/Order';
import User from '../models/User';
import VirtualCardModel from '../models/VirtualCard';

export interface PaymentProvider {
  /**
   * Triggers the payment for this order and updates it accordingly
   */
  processOrder(order: OrderModelInterface): Promise<typeof models.Transaction>;

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
  processOrder(order: OrderModelInterface): Promise<typeof models.Transaction>;

  /**
   * Refunds a transaction processed with this payment provider service
   */
  refundTransaction(
    transaction: typeof models.Transaction,
    user: User,
    reason?: string,
  ): Promise<typeof models.Transaction>;
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
