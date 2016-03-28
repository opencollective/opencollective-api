/**
 * Dependencies.
 */

const Bluebird = require('bluebird');
const _ = require('lodash');
const app = require('../index');
const expect = require('chai').expect;
const request = require('supertest');
const utils = require('../test/utils.js')();
const roles = require('../app/constants/roles');

const cleanAllDb = utils.cleanAllDb;

const models = app.set('models');
const Expense = models.Expense;

/**
 * Tests.
 */
describe('expenses.routes.test.js', function() {
  var application;
  var user;
  var group;
  var expense;

  beforeEach((done) => {
    cleanAllDb((e, app) => {
      application = app;
      done();
    });
  });

  beforeEach((done) => {
    Bluebird.props({
      user: models.User.create(utils.data('user1')),
      group: models.Group.create(utils.data('group1')),
    })
    .then(props => {
      user = props.user;
      group = props.group;

      return group.addUserWithRole(user, roles.HOST);
    })
    .then(() => done())
    .catch(done);
  });

  describe('#create', () => {
    var expense;

    beforeEach((done) => {
      request(app)
        .post(`/groups/${group.id}/expenses`)
        .set('Authorization', `Bearer ${user.jwt(application)}`)
        .send({
          expense: utils.data('expense1')
        })
        .end((err, res) => {
          expect(err).to.not.exist;
          expense = res.body;
          done();
        });
    });

    it('belongs to the group', () => {
      expect(expense.GroupId).to.be.equal(group.id);
    });

    it('belongs to the user', () => {
      expect(expense.UserId).to.be.equal(user.id);
    });

    it('creates an activity', (done) => {
      models.Activity.findAndCountAll()
        .then(res => {
          expect(res.count).to.be.equal(1);
          const activity = res.rows[0];

          expect(activity.UserId).to.be.equal(user.id);
          expect(activity.GroupId).to.be.equal(group.id);
          expect(activity.ExpenseId).to.be.equal(expense.id);
          expect(activity.data.user.id).to.be.equal(user.id);
          expect(activity.data.group.id).to.be.equal(group.id);
          expect(activity.data.expense.id).to.be.equal(expense.id);
          done();
        })
        .catch(done);
    });

  });

  describe('#approve', () => {

    describe('reject an expense', () => {
      var expense;

      beforeEach((done) => {
        request(app)
          .post(`/groups/${group.id}/expenses`)
          .set('Authorization', `Bearer ${user.jwt(application)}`)
          .send({
            expense: utils.data('expense1')
          })
          .end((err, res) => {
            expect(err).to.not.exist;
            console.log('lalallalalalalala', res.body.id);
            expense = res.body;
            done();
          });
      });

      beforeEach((done) => {
        request(app)
          .post(`/groups/${group.id}/expenses/${expense.id}`)
          .set('Authorization', `Bearer ${user.jwt(application)}`)
          .send({ approved: false })
          .end((err, res) => {
            expect(err).to.not.exist;
            // console.log('lalal', res.body)
            done();
          });
      });

      it.only('sets the status to REJECTED', (done) => {
        Expense.findAndCountAll()
          .then(res => {
            expect(res.count).to.be.equal(1);
            const expense = res.rows[0];

            console.log('expense', expense);

            done();
          })
          .catch(done);
      });
    });

  });

});
