/**
 * Dependencies.
 */

var app = require('../index');
var expect = require('chai').expect;
var request = require('supertest-as-promised');
var utils = require('../test/utils.js')();

/**
 * Variables.
 */

var userData = utils.data('user1');
var models = app.set('models');

describe('images.routes.test.js', () => {
  var application;
  var user;

  beforeEach(() => utils.cleanAllDb().tap(a => application = a));

  /**
   * Create user
   */

  beforeEach(() => models.User.create(userData).tap(u => user = u));

  it('should upload an image to S3', () =>
    request(app)
    .post('/images/')
    .attach('file', 'test/mocks/images/camera.png')
    .set('Authorization', 'Bearer ' + user.jwt(application))
    .expect(200)
    .toPromise()
    .tap(res => expect(res.body.url).to.contain('.png')));

  it('should throw an error if no file field is sent', () =>
    request(app)
    .post('/images/')
    .set('Authorization', 'Bearer ' + user.jwt(application))
    .expect(400));

  it('should upload if the user is not logged in', () =>
    request(app)
    .post('/images/')
    .attach('file', 'test/mocks/images/camera.png')
    .expect(200));
});
