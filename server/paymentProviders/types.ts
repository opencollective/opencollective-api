import models from '../models';

export interface PaymentProvider {
  /**
   * Triggers the payment for this order and updates it accordingly
   */
  processOrder(order: typeof models.Order): Promise<typeof models.Transaction>;

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
  };

  /**
   * Triggers the payment for this order and updates it accordingly
   */
  processOrder(order: typeof models.Order): Promise<typeof models.Transaction>;
}
