const Bluebird = require('bluebird');
const app = require('../index');
const expect = require('chai').expect;
const request = require('supertest-as-promised');
const sinon = require('sinon');
const utils = require('./utils')();
const roles = require('../server/constants/roles');

const models = app.set('models');
const Expense = models.Expense;

describe('expenses.routes.test.js: GIVEN an application, group, and host user', () => {
  var application, user, group;

  beforeEach(() => utils.cleanAllDb().tap(a => application = a));

  beforeEach(() => Bluebird.props({
      user: models.User.create(utils.data('user1')),
      group: models.Group.create(utils.data('group1'))
    })
    .then(props => {
      user = props.user;
      group = props.group;

      return group.addUserWithRole(user, roles.HOST);
    }));

  describe('WHEN no expense exists', () => {

    describe('WHEN calling approve route', () => {
      var req;

      beforeEach(done => {
        req = request(app)
          .post('/groups/' + group.id + '/expenses/123/approve')
          .set('Authorization', `Bearer ${user.jwt(application)}`);
        done();
      });

      it('THEN returns 404', () => req.expect(404));
    });
  });

  describe('WHEN calling expense route', () => {
    var expenseReq;

    beforeEach(done => {
      expenseReq = request(app).post(`/groups/${group.id}/expenses`);
      done();
    });

    describe('WHEN not authenticated but providing an expense', () => {
      beforeEach(done => {
        expenseReq = expenseReq.send({expense: utils.data('expense1')});
        done();
      });

      it('THEN returns 200', () => expenseReq.expect(200));
    });

    // authenticate even though not required, so that we can make assertions on the userId
    describe('WHEN authenticated', () => {
      beforeEach(done => {
        expenseReq = expenseReq.set('Authorization', `Bearer ${user.jwt(application)}`);
        done();
      });

      describe('WHEN not providing expense', () =>
        it('THEN returns 400 bad request', () => expenseReq.expect(400)));

      describe('WHEN providing expense', () => {
        beforeEach(() => {
          expenseReq = expenseReq.send({expense: utils.data('expense1')});
        });

        describe('THEN returns 200 and expense', () => {
          var expense;

          beforeEach(() => expenseReq
            .expect(200)
            .toPromise()
            .tap(res => expense = res.body));

          it('THEN expense belongs to the group', () => expect(expense.GroupId).to.be.equal(group.id));

          it('THEN expense belongs to the user', () => expect(expense.UserId).to.be.equal(user.id));

          it('THEN a group.expense.created activity is created', () => {
            models.Activity.findAndCountAll()
              .tap(res => {
                expect(res.count).to.be.equal(1);
                const activity = res.rows[0];

                expect(activity.type).to.be.equal('group.expense.created');
                expect(activity.UserId).to.be.equal(user.id);
                expect(activity.GroupId).to.be.equal(group.id);
                expect(activity.data.user.id).to.be.equal(user.id);
                expect(activity.data.group.id).to.be.equal(group.id);
                expect(activity.data.expense.id).to.be.equal(expense.id);
              });
          });

          describe('WHEN calling approve route', () => {
            var approveReq;

            beforeEach(done => {
              approveReq = request(app).post(`/groups/${group.id}/expenses/${expense.id}/approve`);
              done();
            });

            describe('WHEN not authenticated', () =>
              it('THEN returns 401 unauthorized', () => approveReq.expect(401)));

            describe('WHEN authenticated as host user', () => {

              beforeEach(() => {
                approveReq = approveReq.set('Authorization', `Bearer ${user.jwt(application)}`);
              });

              describe('WHEN sending approved: false', () => {
                beforeEach(() => setExpenseApproval(false));

                it('THEN returns status: REJECTED', () => expectApprovalStatus('REJECTED'));
              });

              describe('WHEN sending approved: true', () => {
                // TODO set up test data

                beforeEach(() => setExpenseApproval(true));

                xit('THEN returns status: APPROVED', () => expectApprovalStatus('APPROVED'));
              });

              const setExpenseApproval = approved => approveReq.send({approved}).expect(200);

              const expectApprovalStatus = approvalStatus =>
                Expense.findAndCountAll()
                  .tap(expenses => {
                    expect(expenses.count).to.be.equal(1);
                    const expense = expenses.rows[0];
                    expect(expense.status).to.be.equal(approvalStatus);
                  });
            });
          });
        });
      });
    });
  });
});
