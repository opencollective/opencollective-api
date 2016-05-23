/**
 * Dependencies.
 */
var _ = require('lodash');
var app = require('../index');
var async = require('async');
var config = require('config');
var expect = require('chai').expect;
var sinon = require('sinon');
var request = require('supertest-as-promised');
var utils = require('../test/utils.js')();

/**
 * Variables.
 */
var userData = utils.data('user1');
var paypalPaymentMethod = utils.data('paymentMethod1');
var stripePaymentMethod = utils.data('paymentMethod2');
var models = app.set('models');

/**
 * Tests.
 */
describe('paymentMethods.routes.test.js', () => {

  var application;
  var user;
  var user2;
  var paymentMethod1;
  var sandbox = sinon.sandbox.create();

  beforeEach(() => utils.cleanAllDb().tap(a => application = a));

  // Create a stub for clearbit
  beforeEach(() => utils.clearbitStubBeforeEach(sandbox));

  // Create users.
  beforeEach(() => models.User.create(utils.data('user1')).tap(u => user = u));

  beforeEach(() => models.User.create(utils.data('user2')).tap(u => user2 = u));

  // Create paymentMethod.
  beforeEach(() => {
    var data = _.extend(paypalPaymentMethod, {UserId: user.id});
    return models.PaymentMethod.create(data).tap(c => paymentMethod1 = c);
  });

  beforeEach(() => {
    var data = _.extend(stripePaymentMethod, { UserId: user.id });
    return models.PaymentMethod.create(data).tap(c => paymentMethod2 = c);
  });

  afterEach(() => utils.clearbitStubAfterEach(sandbox));

  /**
   * Get user's groups.
   */
  describe('#getUserGroups', () => {

    it('fails getting another user\'s paymentMethods', () =>
      request(app)
        .get('/users/' + user.id + '/payment-methods')
        .set('Authorization', 'Bearer ' + user2.jwt(application))
        .expect(403));

    it('successfully get a user\'s paymentMethod', () =>
      request(app)
        .get('/users/' + user.id + '/payment-methods')
        .set('Authorization', 'Bearer ' + user.jwt(application))
        .expect(200)
        .toPromise()
        .tap(res => {
          var body = res.body;
          expect(body).to.have.length(2);
          expect(body[0].id).to.be.equal(paymentMethod1.id);
          expect(body[0].service).to.be.equal(paymentMethod1.service);
          expect(body[0].token).to.be.equal(paymentMethod1.token);
        }));

    it('successfully get a user\'s paymentMethod and filters by service', () =>
      request(app)
        .get('/users/' + user.id + '/payment-methods')
        .query({
          filter: {
            service: 'paypal'
          }
        })
        .set('Authorization', 'Bearer ' + user.jwt(application))
        .expect(200)
        .toPromise()
        .tap(res => {
          var body = res.body;
          expect(body).to.have.length(1);
          expect(body[0].id).to.be.equal(paymentMethod1.id);
          expect(body[0].service).to.be.equal(paymentMethod1.service);
          expect(body[0].token).to.be.equal(paymentMethod1.token);
        }));
  });
});
