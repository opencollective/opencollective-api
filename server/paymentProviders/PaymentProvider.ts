import models from '../models';

import { PaymentProviderService } from './PaymentProviderService';

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
