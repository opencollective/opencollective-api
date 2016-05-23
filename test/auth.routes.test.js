/**
 * Dependencies.
 */
var _ = require('lodash');
var app = require('../index');
var async = require('async');
var config = require('config');
var expect = require('chai').expect;
var jwt = require('jsonwebtoken');
var request = require('supertest-as-promised');
var utils = require('../test/utils.js')();

/**
 * Variables.
 */
var userData = utils.data('user1');
var models = app.set('models');

/**
 * Tests.
 */
describe('auth.routes.test.js', () => {

  var application;

  beforeEach(() => utils.cleanAllDb().tap(a => application = a));

  beforeEach(() => models.User.create(userData));

  describe('#authenticate', () => {

    it('fails authenticate if no password', () =>
      request(app)
        .post('/authenticate')
        .send({
          api_key: application.api_key,
          username: userData.username
        })
        .expect(400));

    it('fails authenticate if bad application', () =>
      request(app)
        .post('/authenticate')
        .send({
          api_key: 'bla',
          username: userData.username,
          password: userData.password
        })
        .expect(401));

    it('fails authenticate if bad password', () =>
      request(app)
        .post('/authenticate')
        .send({
          api_key: application.api_key,
          username: userData.username,
          password: 'bad'
        })
        .expect(400));

    it('successfully authenticates with username', () =>
      request(app)
        .post('/authenticate')
        .send({
          api_key: application.api_key,
          username: userData.username,
          password: userData.password
        })
        .expect(200)
        .toPromise()
        .tap(res => {
          expect(res.body).to.have.property('access_token');
          expect(res.body).to.have.property('refresh_token');
          var data = jwt.decode(res.body.access_token);
          expect(data).to.have.property('iat');
          expect(data).to.have.property('exp');
          expect(data).to.have.property('aud');
          expect(data).to.have.property('iss');
          expect(data).to.have.property('sub');
        }));

    it('successfully authenticate with email (case insensitive)', () =>
      request(app)
        .post('/authenticate')
        .send({
          api_key: application.api_key,
          email: userData.email.toUpperCase(),
          password: userData.password
        })
        .expect(200)
        .toPromise()
        .tap(res => {
          expect(res.body).to.have.property('access_token');
          expect(res.body).to.have.property('refresh_token');
        }));
  });
});
