/**
 * Dependencies.
 */
var async = require('async');
var config = require('config');
var moment = require('moment');

/**
 * Controller.
 */
module.exports = function(app) {

  /**
   * Internal Dependencies.
   */
  var models = app.set('models');
  var Activity = models.Activity;
  var PaymentMethod = models.PaymentMethod;
  var errors = app.errors;

  /**
   * Get Preapproval Details.
   */
  var getPreapprovalDetails = (preapprovalKey, callback) => {
    var payload = {
      requestEnvelope: {
        errorLanguage:  'en_US',
        detailLevel:    'ReturnAll'
      },
      preapprovalKey: preapprovalKey
    };
    app.paypalAdaptive.preapprovalDetails(payload, callback);
  };

  /**
   * Get preapproval details route
   */
  var getDetails = (req, res, next) => {
    var preapprovalKey = req.params.preapprovalkey;

    getPreapprovalDetails(preapprovalKey, (err, response) => {
      if (err) return next(err);
      res.json(response);
    });
  };

  /**
   * Get a preapproval key for a user.
   */
  var getPreapprovalKey = (req, res, next) => {
    console.log("getPreapprovalKey");
    // TODO: This return and cancel URL doesn't work - no routes right now.
    var uri = `/users/${req.remoteUser.id}/paypal/preapproval/`;
    var baseUrl = config.host.webapp + uri;
    var cancelUrl = req.query.cancelUrl || (`${baseUrl}/cancel`);
    var returnUrl = req.query.returnUrl || (`${baseUrl}/success`);
    var endingDate = (req.query.endingDate && (new Date(req.query.endingDate)).toISOString()) || moment().add(1, 'years').toISOString();
    var maxTotalAmountOfAllPayments = req.query.maxTotalAmountOfAllPayments || 2000; // 2000 is the maximum: https://developer.paypal.com/docs/classic/api/adaptive-payments/Preapproval_API_Operation/

    async.auto({

      getExistingPaymentMethod: [(cb) => {
        console.log("getExistingPaymentMethod");
        PaymentMethod
          .findAndCountAll({
            where: {
              service: 'paypal',
              UserId: req.remoteUser.id
            }
          })
          .then(paymentMethod => cb(null, paymentMethod))
          .catch(cb);
      }],

      checkExistingPaymentMethod: ['getExistingPaymentMethod', (cb, results) => {
        console.log("checkExistingPaymentMethod");
        async.each(results.getExistingPaymentMethod.rows, (paymentMethod, cbEach) => {
          if (!paymentMethod.token) {
            return paymentMethod.destroy()
              .then(() => cbEach())
              .catch(cbEach);
          }

          getPreapprovalDetails(paymentMethod.token, (err, response) => {
            if (err) return cbEach(err);
            if (response.approved === 'false' || new Date(response.endingDate) < new Date()) {
              paymentMethod.destroy()
                .then(() => cbEach())
                .catch(cbEach);
            } else {
              cbEach();
            }
          });
        }, cb);
      }],

      createPaymentMethod: ['checkExistingPaymentMethod', cb => {
        console.log("createPaymentMethod");
        PaymentMethod.create({
          service: 'paypal',
          UserId: req.remoteUser.id
        })
          .then(paymentMethod => cb(null, paymentMethod))
          .catch(cb);
      }],

      createPayload: ['createPaymentMethod', (cb, results) => {
        console.log("createPayload");
        var payload = {
          currencyCode: 'USD',
          startingDate: new Date().toISOString(),
          endingDate: endingDate,
          returnUrl: returnUrl,
          cancelUrl: cancelUrl,
          displayMaxTotalAmount: false,
          feesPayer: 'SENDER',
          maxTotalAmountOfAllPayments: maxTotalAmountOfAllPayments,
          requestEnvelope: {
            errorLanguage:  'en_US'
          },
          clientDetails: results.createPaymentMethod.id
        };
        return cb(null, payload);
      }],

      callPaypal: ['createPayload', (cb, results) => {
        console.log("callPaypal");
        app.paypalAdaptive.preapproval(results.createPayload, cb);
      }],

      updatePaymentMethod: ['createPaymentMethod', 'createPayload', 'callPaypal', (cb, results) => {
        console.log("updatePaymentMethod");
        var paymentMethod = results.createPaymentMethod;
        paymentMethod.token = results.callPaypal.preapprovalKey;
        paymentMethod.save()
          .then(paymentMethod => cb(null, paymentMethod))
          .catch(cb);
      }]

    }, (err, results) => {
      if (err) return next(err);
      res.json(results.callPaypal);
    });

  };

  /**
   * Confirm a preapproval.
   */
  var confirmPreapproval = (req, res, next) => {

    async.auto({

      getPaymentMethod: [(cb) => {
        PaymentMethod
          .findAndCountAll({
            where: {
              service: 'paypal',
              UserId: req.remoteUser.id,
              token: req.params.preapprovalkey
            }
          })
          .then(paymentMethod => cb(null, paymentMethod))
          .catch(cb);
      }],

      checkPaymentMethod: ['getPaymentMethod', (cb, results) => {
        if (results.getPaymentMethod.rows.length === 0) {
          return cb(new errors.NotFound('This preapprovalKey doesn not exist.'));
        } else {
          cb();
        }
      }],

      callPaypal: [cb => {
        getPreapprovalDetails(req.params.preapprovalkey, (err, response) => {
          if (err) {
            return cb(err);
          }

          if (response.approved === 'false') {
            return cb(new errors.BadRequest('This preapprovalkey is not approved yet.'));
          }

          cb(null, response);
        });
      }],

      updatePaymentMethod: ['callPaypal', 'getPaymentMethod', 'checkPaymentMethod', (cb, results) => {
        var paymentMethod = results.getPaymentMethod.rows[0];
        paymentMethod.confirmedAt = new Date();
        paymentMethod.data = results.callPaypal;
        paymentMethod.number = results.callPaypal.senderEmail;
        paymentMethod.save()
          .then(paymentMethod => cb(null, paymentMethod))
          .catch(cb);
      }],

      cleanOldPaymentMethods: ['updatePaymentMethod', cb => {
        PaymentMethod
          .findAndCountAll({
            where: {
              service: 'paypal',
              UserId: req.remoteUser.id,
              token: {$ne: req.params.preapprovalkey}
            }
          })
          .then((results) => {
            async.each(results.rows, (paymentMethod, cbEach) => {
              paymentMethod.destroy()
                .then(() => cbEach())
                .catch(cbEach);
            }, cb);
          })
          .catch(cb);
      }],

      createActivity: ['updatePaymentMethod', (cb, results) => {
        Activity.create({
          type: 'user.paymentMethod.created',
          UserId: req.remoteUser.id,
          data: {
            user: req.remoteUser,
            paymentMethod: results.updatePaymentMethod
          }
        })
          .then(activity => cb(null, activity))
          .catch(cb);
      }]

    }, (err, results) => {
      if (err) return next(err);
      else res.json(results.updatePaymentMethod.info);
    });

  };

  /**
   * Public methods.
   */
  return {
    getPreapprovalKey,
    confirmPreapproval,
    getDetails,
    getPreapprovalDetails
  };

};
