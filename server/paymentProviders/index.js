import fs from 'fs';

/*
Each new paymentProvider should support following exported methods:
    - oauth: for connecting the payment method
    - webhook: for receiving incoming webhooks 
    - processOrder: for processing an order
 */

/* TODO: bring this back 
const paymentProviders = {};
fs.readdirSync(__dirname).forEach(file => {
  if (file === 'index.js') return;
  const name = file.substr(0, file.indexOf('.'));
  console.log("name is", name);
  paymentProviders[name] = require(`./${file}`);
});

*/

import stripe from './stripe';
import paypal from './paypal';
import opencollective from './opencollective';
import prepaid from './prepaid';

const paymentProviders = {
    stripe,
    paypal,
    opencollective,
    prepaid
}

export default paymentProviders;