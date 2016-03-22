module.exports = function(app) {

  /**
   * Controllers.
   */
  var cs = {};
  var controllers = [
    'activities',
    'groups',
    'images',
    'middlewares',
    'params',
    'payments',
    'paypal',
    'notifications',
    'stripe',
    'subscriptions',
    'transactions',
    'paymentmethods',
    'users',
    'webhooks',
    'test'
  ];

  /**
   * Exports.
   */
  controllers.forEach(function(controller) {
    cs[controller] = require(__dirname + '/' + controller)(app);
  });

  return cs;

};
