// import { OrderModelInterface } from '../models/Order';
// import { PaymentMethodModelInterface } from '../models/PaymentMethod';
// import { TransactionInterface } from '../models/Transaction';
// import User from '../models/User';

import opencollective from './opencollective';
import paypal from './paypal';
import stripe from './stripe';
import transferwise from './transferwise';

export default {
  opencollective,
  paypal,
  stripe,
  transferwise,
};
