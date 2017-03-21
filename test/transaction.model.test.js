import {expect} from 'chai';
import sinon from 'sinon';
import * as utils from '../test/utils';
import roles from '../server/constants/roles';
import models from '../server/models';
import expenseStatus from '../server/constants/expense_status';

const { Transaction, Donation, Expense} = models;

const userData = utils.data('user1');
const groupData = utils.data('group1');
const transactionsData = utils.data('transactions1').transactions;

describe('transaction model', () => {

  let user, group, sandbox;

  before(() => {
    sandbox = sinon.sandbox.create();
  });

  after(() => sandbox.restore());
  
  // Create a stub for clearbit
  beforeEach(() => utils.clearbitStubBeforeEach(sandbox));

  beforeEach(() => utils.resetTestDB());

  beforeEach('create user', () => models.User.create(userData).tap(u => user = u));

  beforeEach('create group2 and add user as host', () =>
    models.Group.create(groupData)
      .tap(g => group = g)
      .then(() => group.addUserWithRole(user, roles.HOST)));

  afterEach(() => utils.clearbitStubAfterEach(sandbox));

  it('automatically generates uuid', done => {
    Transaction.create({
      amount: -1000
    })
    .then(transaction => {
      expect(transaction.info.uuid).to.match(/^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/i);
      done();
    })
    .catch(done);
  });

  it('get the host', (done) => {
    Transaction.create({
      GroupId: group.id,
      amount: 10000
    })
    .then(transaction => transaction.getHost())
    .then(host => {
      expect(host.id).to.equal(user.id);
      done();
    })
  });

  it('createFromPayload creates a new Transaction', done => {
    Transaction.createFromPayload({
      transaction: transactionsData[7],
      user,
      group
    })
    .then(() => {
      Transaction.findAll()
      .then(transactions => {
        expect(transactions.length).to.equal(1);
        done();
      })
    })
    .catch(done);
  });

  it('fetches all the expense-related fields', done => {
      const date = new Date();
      const title = 'test expense';
      Expense.create({
        amount: 100,
        currency: 'USD',
        title,
        status: expenseStatus.PAID,
        category: 'Travel',
        incurredAt: date,
        payoutMethod: 'paypal',
        UserId: user.id,
        GroupId: group.id,
        lastEditedById: user.id
      })
      .then(expense => Transaction.create({
        amount: 100,
        currency: 'USD',
        ExpenseId: expense.id
      }))
      .then(transaction => Transaction.findAll({
        where: {
          id: transaction.id
        },
        include: [{ model: Expense }]
      }))
      .then(transactions => {
        expect(transactions[0].info.expenseCategory).to.equal('Travel');
        expect(transactions[0].info.expenseIncurredAt.getTime()).to.equal(date.getTime());
        expect(transactions[0].info.expensePayoutMethod).to.equal('paypal');
        expect(transactions[0].info.title).to.equal(title);
        done();
      })
      .catch(done);
  });

  it('fetches donation-related field: title', done => {
      const title = 'test donation';
      Donation.create({
        amount: 100,
        currency: 'USD',
        title,
        UserId: user.id,
        GroupId: group.id
      })
      .then(donation => Transaction.create({
        amount: 100,
        currency: 'USD',
        DonationId: donation.id
      }))
      .then(transaction => Transaction.findAll({
        where: {
          id: transaction.id
        },
        include: [{ model: Donation }]
      }))
      .then(transactions => {
        expect(transactions[0].info.title).to.equal(title);
        done();
      })
      .catch(done);
  });

  it('gets the description as title when neither Donation or Expense present', done => {
    Transaction.create({
      amount: 100,
      currency: 'USD',
      description: 'test description'
    })
    .then(transaction => {
      expect(transaction.title).to.equal('test description');
      done();
    })
    .catch(done);
  });

  let createActivitySpy;

  before(() => {
    createActivitySpy = sinon.spy(Transaction, 'createActivity');
  });

  beforeEach(() => createActivitySpy.reset());

  after(() => createActivitySpy.restore());

  it('createFromPayload() generates a new activity', (done) => {

    Transaction.createFromPayload({
      transaction: transactionsData[7],
      user,
      group
    })
    .then(transaction => {
      expect(transaction.GroupId).to.equal(group.id);
      expect(createActivitySpy.lastCall.args[0]).to.equal(transaction);
      done();
    })
    .catch(done);
  });
});
