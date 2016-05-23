/**
 * Dependencies.
 */
var _ = require('lodash');
var app = require('../index');
var async = require('async');
var config = require('config');
var expect = require('chai').expect;
var request = require('supertest-as-promised');
var utils = require('../test/utils.js')();
var sinon = require('sinon');
var nock = require('nock');

/**
 * Variables.
 */
var models = app.set('models');
var paypalMock = require('./mocks/paypal');

/**
 * Tests.
 */
describe('paypal.preapproval.routes.test.js', () => {

  var application;
  var user;
  var user2;

  beforeEach(() => sinon
    .stub(app.paypalAdaptive, 'preapproval')
    .yields(null, paypalMock.adaptive.preapproval));

  beforeEach(() => utils.cleanAllDb().tap(a => application = a));

  beforeEach(() => models.User.create(utils.data('user1')).tap(u => user = u));

  beforeEach(() => models.User.create(utils.data('user2')).tap(u => user2 = u));

  afterEach(() => app.paypalAdaptive.preapproval.restore());

  /**
   * Get the preapproval Key.
   */
  describe('#getPreapprovalKey', () => {

    it('should fail if not the logged-in user', () =>
      request(app)
        .get('/users/' + user.id + '/paypal/preapproval')
        .set('Authorization', 'Bearer ' + user2.jwt(application))
        .expect(403));

    it('should get a preapproval key', () =>
      request(app)
        .get('/users/' + user.id + '/paypal/preapproval')
        .set('Authorization', 'Bearer ' + user.jwt(application))
        .expect(200)
        .then(res => {
          expect(res.body).to.have.property('preapprovalKey', paypalMock.adaptive.preapproval.preapprovalKey);
          return models.PaymentMethod.findAndCountAll({});
        })
        .tap(res => {
          expect(res.count).to.equal(1);
          var paykey = res.rows[0];
          expect(paykey).to.have.property('service', 'paypal');
          expect(paykey).to.have.property('UserId', user.id);
          expect(paykey).to.have.property('token', paypalMock.adaptive.preapproval.preapprovalKey);
        }));

    describe('Check existing paymentMethods', () => {

      afterEach(() => app.paypalAdaptive.preapprovalDetails.restore());

      var beforePastDate = () => {
        var date = new Date();
        date.setDate(date.getDate() - 1); // yesterday

        var completed = paypalMock.adaptive.preapprovalDetails.completed;
        var mock = _.extend(completed, {
          endingDate: date.toString()
        });

        sinon
          .stub(app.paypalAdaptive, 'preapprovalDetails')
          .yields(null, mock);
      };

      it('should delete if the date is past', () => {
        beforePastDate();

        var token = 'abc';
        var paymentMethod = {
          service: 'paypal',
          UserId: user.id,
          token: token
        };

        return models.PaymentMethod.create(paymentMethod)
          .tap(res => expect(res.token).to.equal(token))
          .then(() => request(app)
            .get('/users/' + user.id + '/paypal/preapproval')
            .set('Authorization', 'Bearer ' + user.jwt(application))
            .expect(200))
          .then(() => models.PaymentMethod.findAndCountAll({where: {token} }))
          .tap(res => expect(res.count).to.equal(0));
      });

      var beforeNotApproved = () => {
        var mock = paypalMock.adaptive.preapprovalDetails.created;
        expect(mock.approved).to.be.equal('false');

        sinon
          .stub(app.paypalAdaptive, 'preapprovalDetails')
          .yields(null, paypalMock.adaptive.preapprovalDetails.created);
      };

      it('should delete if not approved yet', () => {
        beforeNotApproved();

        var token = 'def';
        var paymentMethod = {
          service: 'paypal',
          UserId: user.id,
          token: token
        };

        models.PaymentMethod.create(paymentMethod)
        .tap(res => expect(res.token).to.equal(token))
        .then(() => request(app)
          .get('/users/' + user.id + '/paypal/preapproval')
          .set('Authorization', 'Bearer ' + user.jwt(application))
          .expect(200))
        .then(() => models.PaymentMethod.findAndCountAll({where: {token: token} }))
        .tap(res => expect(res.count).to.equal(0));
      });
    });
  });

  /**
   * Confirm a preapproval.
   */
  describe('#confirmPreapproval', () => {

    var preapprovalkey = paypalMock.adaptive.preapproval.preapprovalKey;

    beforeEach(() =>
      request(app)
        .get('/users/' + user.id + '/paypal/preapproval')
        .set('Authorization', 'Bearer ' + user.jwt(application))
        .expect(200));

    describe('Details from Paypal COMPLETED', () => {

      beforeEach(() => sinon
        .stub(app.paypalAdaptive, 'preapprovalDetails')
        .yields(null, paypalMock.adaptive.preapprovalDetails.completed));

      afterEach(() => app.paypalAdaptive.preapprovalDetails.restore());

      it('should fail if not the logged-in user', () =>
        request(app)
          .post('/users/' + user.id + '/paypal/preapproval/' + preapprovalkey)
          .set('Authorization', 'Bearer ' + user2.jwt(application))
          .expect(403));

      it('should fail with an unknown preapproval key', () =>
        request(app)
          .post('/users/' + user.id + '/paypal/preapproval/' + 'abc')
          .set('Authorization', 'Bearer ' + user.jwt(application))
          .expect(404));

      // TODO this sometimes yields an error, to be debugged
      it('should confirm the payment of a transaction', () => {
        console.log("starting test should confirm the payment of a tx");
        var mock = paypalMock.adaptive.preapprovalDetails;
        return request(app)
          .post('/users/' + user.id + '/paypal/preapproval/' + preapprovalkey)
          .set('Authorization', 'Bearer ' + user.jwt(application))
          .expect(200)
          .toPromise()
          .tap(res => expect(res.body.token).to.equal(preapprovalkey))
          .then(() => models.PaymentMethod.findAndCountAll({where: {token: preapprovalkey} }))
          .tap(res => {
            expect(res.count).to.equal(1);
            expect(res.rows[0].confirmedAt).not.to.be.null;
            expect(res.rows[0].service).to.equal('paypal');
            expect(res.rows[0].number).to.equal(mock.completed.senderEmail);
            expect(res.rows[0].UserId).to.equal(user.id);
          })
          .then(() => models.Activity.findAndCountAll({where: {type: 'user.paymentMethod.created'} }))
          .tap(res => expect(res.count).to.equal(1));
      });
    });

    describe('Details from Paypal CREATED', () => {

      beforeEach(() => sinon
        .stub(app.paypalAdaptive, 'preapprovalDetails')
        .yields(null, paypalMock.adaptive.preapprovalDetails.created));

      afterEach(() => app.paypalAdaptive.preapprovalDetails.restore());

      it('should return an error if the preapproval is not completed', () =>
        request(app)
          .post('/users/' + user.id + '/paypal/preapproval/' + preapprovalkey)
          .set('Authorization', 'Bearer ' + user.jwt(application))
          .expect(400));
    });

    describe('Details from Paypal ERROR', () => {

      beforeEach(() => {
        var mock = paypalMock.adaptive.preapprovalDetails.error;
        sinon
          .stub(app.paypalAdaptive, 'preapprovalDetails')
          .yields(mock.error, mock);
      });

      afterEach(() => app.paypalAdaptive.preapprovalDetails.restore());

      it('should return an error if paypal returns one', () =>
        request(app)
          .post('/users/' + user.id + '/paypal/preapproval/' + preapprovalkey)
          .set('Authorization', 'Bearer ' + user.jwt(application))
          .expect(500));
    });

    describe('Preapproval details', () => {
      beforeEach(() => {
        var mock = paypalMock.adaptive.preapprovalDetails.created;
        sinon
          .stub(app.paypalAdaptive, 'preapprovalDetails')
          .yields(mock.error, mock);
      });

      afterEach(() => app.paypalAdaptive.preapprovalDetails.restore());

      it('should return the preapproval details', () =>
        request(app)
          .get('/users/' + user.id + '/paypal/preapproval/' + preapprovalkey)
          .set('Authorization', 'Bearer ' + user.jwt(application))
          .expect(200));

      it('should not be able to check another user preapproval details', () =>
        request(app)
          .get('/users/' + user2.id + '/paypal/preapproval/' + preapprovalkey)
          .set('Authorization', 'Bearer ' + user.jwt(application))
          .expect(403));
    });

    describe('PaymentMethods clean up', () => {
      it('should delete all other paymentMethods entries in the database to clean up', () =>
        request(app)
          .post('/users/' + user.id + '/paypal/preapproval/' + preapprovalkey)
          .set('Authorization', 'Bearer ' + user.jwt(application))
          .expect(200)
          .then(res => models.PaymentMethod.findAndCountAll({where: {token: preapprovalkey} }))
          .tap(res => {
            expect(res.count).to.equal(1);
            expect(res.rows[0].confirmedAt).not.to.be.null;
            expect(res.rows[0].service).to.equal('paypal');
            expect(res.rows[0].UserId).to.equal(user.id);
          }));
    });

  });

});
