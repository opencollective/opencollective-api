import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../constants/paymentMethods.js';

export type PaymentMethod = {
  id: number;
  service: PAYMENT_METHOD_SERVICE;
  type: PAYMENT_METHOD_TYPE;
};
