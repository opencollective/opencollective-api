const paypal = require('./paypal');

module.exports = (app) => {
  return {
    paypal: paypal,
    stripe: app.stripe
  }
};