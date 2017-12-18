import fs from 'fs';

/*
Each new paymentProvider should support following exported methods:
    - oauth: for connecting the payment method
    - webhook: for receiving incoming webhooks 
    - processOrder: for processing an order
 */


const paymentProviders = {};
fs.readdirSync(__dirname).forEach(file => {
  if (file === 'index.js') return;
  paymentProviders[file] = require(`./${file}`);
});

export default paymentProviders;