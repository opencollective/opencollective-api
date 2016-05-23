/**
 * Dependencies.
 */
var _ = require('lodash');
var app = require('../index');
var async = require('async');
var config = require('config');
var expect = require('chai').expect;
var request = require('supertest-as-promised');
var chance = require('chance').Chance();
var utils = require('../test/utils.js')();
var roles = require('../server/constants/roles');
var sinon = require('sinon');
var createTransaction = require('../server/controllers/transactions')(app)._create;

/**
 * Variables.
 */
var userData = utils.data('user1');
var publicGroupData = utils.data('group1');
var privateGroupData = utils.data('group2');
var transactionsData = utils.data('transactions1').transactions;
var models = app.set('models');
var stripeMock = require('./mocks/stripe');

/**
 * Tests.
 */
describe('groups.routes.test.js', () => {

  var application;
  var user;
  var sandbox = sinon.sandbox.create();

  beforeEach(() => utils.cleanAllDb().tap(a => application = a));

  // Create a stub for clearbit
  beforeEach(() => utils.clearbitStubBeforeEach(sandbox));

  beforeEach(() => models.User.create(userData).tap(u => user = u));

  // Stripe stub.
  var stub;
  beforeEach(() => {
    var stub = sinon.stub(app.stripe.accounts, 'create');
    stub.yields(null, stripeMock.accounts.create);
  });
  afterEach(() => app.stripe.accounts.create.restore());

  afterEach(() => utils.clearbitStubAfterEach(sandbox));

  /**
   * Create.
   */
  describe('#create', () => {

    it('fails creating a group if not authenticated', () =>
      request(app)
        .post('/groups')
        .send({
          group: privateGroupData
        })
        .expect(401));

    it('fails creating a group without data', () =>
      request(app)
        .post('/groups')
        .set('Authorization', 'Bearer ' + user.jwt(application))
        .expect(400));

    it('fails creating a group without name', () => {
      var group = _.omit(privateGroupData, 'name');

      return request(app)
        .post('/groups')
        .set('Authorization', 'Bearer ' + user.jwt(application))
        .send({
          group: group
        })
        .expect(400)
        .toPromise()
        .tap(res => {
          expect(res.body).to.have.property('error');
          expect(res.body.error).to.have.property('message', 'notNull Violation: name cannot be null');
          expect(res.body.error).to.have.property('type', 'validation_failed');
          expect(res.body.error).to.have.property('fields');
          expect(res.body.error.fields).to.contain('name');
        });
    });

    it('gracefully handles twitterHandle with or without @', () =>
      request(app)
        .post('/groups')
        .set('Authorization', 'Bearer ' + user.jwt(application))
        .send({
          group: _.extend({}, privateGroupData, {twitterHandle: '@asood123'})
        })
        .expect((res) => { res.body = { twitterHandle: res.body.twitterHandle }})
        .expect(200, { twitterHandle: 'asood123' }));

    it('fails if the tier has missing data', () => {
      var g = _.extend({}, privateGroupData);
      g.tiers = [{ // interval missing
        name: 'Silver',
        description: 'Silver',
        range: [100, 200]
      }];

      return request(app)
        .post('/groups')
        .set('Authorization', 'Bearer ' + user.jwt(application))
        .send({
          group: g
        })
        .expect(400, {
          error: {
            code: 400,
            type: 'validation_failed',
            message: 'Validation error: \"title\" is required',
            fields: ['tiers']
          }
        });
    });

    it('successfully create a group without assigning a member', () =>
      request(app)
        .post('/groups')
        .set('Authorization', 'Bearer ' + user.jwt(application))
        .send({
          group: privateGroupData
        })
        .expect(200)
        .then(res => {
          expect(res.body).to.have.property('id');
          expect(res.body).to.have.property('name');
          expect(res.body).to.have.property('mission');
          expect(res.body).to.have.property('description');
          expect(res.body).to.have.property('longDescription');
          expect(res.body).to.have.property('budget', privateGroupData.budget);
          expect(res.body).to.have.property('burnrate');
          expect(res.body).to.have.property('currency', privateGroupData.currency);
          expect(res.body).to.have.property('logo');
          expect(res.body).to.have.property('video');
          expect(res.body).to.have.property('image');
          expect(res.body).to.have.property('backgroundImage');
          expect(res.body).to.have.property('expensePolicy');
          expect(res.body).to.have.property('createdAt');
          expect(res.body).to.have.property('updatedAt');
          expect(res.body).to.have.property('twitterHandle');
          expect(res.body).to.have.property('website');
          expect(res.body).to.have.property('isPublic', false);
          return user.getGroups();
        })
        .tap(groups => expect(groups).to.have.length(0)));

    it('successfully create a group assigning the caller as host', () => {
      var role = roles.HOST;

      return request(app)
        .post('/groups')
        .set('Authorization', 'Bearer ' + user.jwt(application))
        .send({
          group: privateGroupData,
          role: role
        })
        .expect(200)
        .then(res => {
          expect(res.body).to.have.property('id');
          expect(res.body).to.have.property('name');
          expect(res.body).to.have.property('mission');
          expect(res.body).to.have.property('description');
          expect(res.body).to.have.property('longDescription');
          expect(res.body).to.have.property('logo');
          expect(res.body).to.have.property('video');
          expect(res.body).to.have.property('image');
          expect(res.body).to.have.property('backgroundImage');
          expect(res.body).to.have.property('expensePolicy');
          expect(res.body).to.have.property('createdAt');
          expect(res.body).to.have.property('updatedAt');
          expect(res.body).to.have.property('twitterHandle');
          expect(res.body).to.have.property('website');
          return user.getGroups();
        })
        .tap(groups => expect(groups).to.have.length(1));
    });
  });

  /**
   * Create from Github
   */
  describe('#createFromGithub', () => {

    it('fails creating a group if param value is not github', () =>
      request(app)
        .post('/groups?flow=blah')
        .send({
          payload: privateGroupData
        })
        .expect(400));

    it('fails creating a group if no app key', () =>
      request(app)
        .post('/groups?flow=github')
        .send({
          payload: privateGroupData
        })
        .expect(400));


    it('fails creating a group without payload', () =>
      request(app)
        .post('/groups?flow=github')
        .set('Authorization', 'Bearer ' + user.jwt(application))
        .send({
          group: privateGroupData,
          api_key: application.api_key
        })
        .expect(400));

    describe('Successfully create a group and ', () => {

      const ConnectedAccount = models.ConnectedAccount;

      beforeEach(() => {
        const User = models.User;

        // create connected account like the oauth happened
        var preCA;
        var firstUser;
        return ConnectedAccount.create({
          username: 'asood123',
          provider: 'github',
          secret: 'xxxxx'
        })
        .tap(ca => preCA = ca)
        .then(() => User.create({email: 'asood123@yahoo.com'}))
        .tap(user => firstUser = user)
        .then(() => firstUser.addConnectedAccount(preCA));
      });

      it('assigns contributors as users with connectedAccounts', () =>
        request(app)
        .post('/groups?flow=github')
        .set('Authorization', `Bearer ${user.jwt(application, { scope: 'connected-account', username: 'asood123', connectedAccountId: 1})}`)
        .send({
          payload: {
            group: {
              name:'Loot',
              slug:'Loot',
              expensePolicy: 'expense policy',
              mission: 'mission statement'
            },
            users: ['asood123', 'oc'],
            github_username: 'asood123'
          },
          api_key: application.api_key
        })
        .expect(200)
        .then(res => {
          expect(res.body).to.have.property('id');
          expect(res.body).to.have.property('name', 'Loot');
          expect(res.body).to.have.property('slug', 'loot');
          expect(res.body).to.have.property('mission', 'mission statement');
          expect(res.body).to.have.property('description');
          expect(res.body).to.have.property('longDescription');
          expect(res.body).to.have.property('expensePolicy', 'expense policy');
          expect(res.body).to.have.property('isPublic', false);

          return ConnectedAccount.findOne({where: {username: 'asood123'}});
        })
        .tap(ca => expect(ca).to.have.property('provider', 'github'))
        .then(ca => ca.getUser())
        .tap(user => expect(user).to.exist)
        .then(() => ConnectedAccount.findOne({where: {username: 'oc'}}))
        .tap(ca => expect(ca).to.have.property('provider', 'github'))
        .then(ca => ca.getUser())
        .then(user => {
          expect(user).to.exist;
          return user.getGroups();
        })
        .tap(groups => expect(groups).to.have.length(1)));
    });
  });

  /**
   * Get.
   */
  describe('#get', () => {

    var publicGroup;
    var user2;
    var application2;
    var stripeEmail;

    var stubStripe = () => {
      var stub = sinon.stub(app.stripe.accounts, 'create');
      var mock = stripeMock.accounts.create;
      mock.email = chance.email();
      stripeEmail = mock.email;
      stub.yields(null, mock);
    };

    beforeEach(() => {
      app.stripe.accounts.create.restore();
      stubStripe();
    });

    // Create the group with user.
    beforeEach(() =>
      request(app)
        .post('/groups')
        .set('Authorization', 'Bearer ' + user.jwt(application))
        .send({
          group: privateGroupData,
          role: roles.HOST
        })
        .expect(200)
        .then(res => models.Group.find(parseInt(res.body.id)))
        .tap(g => privateGroup = g));

    beforeEach(() => {
      app.stripe.accounts.create.restore();
      stubStripe();
    });

    // Create the public group with user.
    beforeEach(() =>
      request(app)
        .post('/groups')
        .set('Authorization', 'Bearer ' + user.jwt(application))
        .send({
          group: publicGroupData,
          role: roles.HOST
        })
        .expect(200)
        .then(res => models.Group.find(parseInt(res.body.id)))
        .tap(g => publicGroup = g));

    beforeEach(() =>
      models.StripeAccount.create({
        stripePublishableKey: stripeMock.accounts.create.keys.publishable
      })
      .tap(account => user.setStripeAccount(account))
        // TODO why is it set twice?
      .tap(account => user.setStripeAccount(account)));

    // Create another user.
    beforeEach(() => models.User.create(utils.data('user2')).tap(u => user2 = u));

    // Create an application which has only access to `privateGroup`
    beforeEach(() => models.Application.create(utils.data('application2'))
      .tap(a => application2 = a)
      .tap(() => application2.addGroup(privateGroup)));

    // Create an application which doesn't have access to any group
    beforeEach(() => models.Application.create(utils.data('application3')).tap(a => application3 = a));

    it('fails getting a group if not authenticated', () =>
      request(app)
        .get('/groups/' + privateGroup.id)
        .expect(401));

    it('fails getting a group if the user authenticated has no access', () =>
      request(app)
        .get('/groups/' + privateGroup.id)
        .set('Authorization', 'Bearer ' + user2.jwt(application))
        .expect(403));

    it('fails getting an undefined group', () =>
      request(app)
        .get('/groups/undefined')
        .set('Authorization', 'Bearer ' + user2.jwt(application))
        .expect(404));

    it('successfully get a group if authenticated as a user', () =>
      request(app)
        .get('/groups/' + privateGroup.id)
        .set('Authorization', 'Bearer ' + user.jwt(application))
        .expect(200)
        .toPromise()
        .tap(res => {
          expect(res.body).to.have.property('id', privateGroup.id);
          expect(res.body).to.have.property('name', privateGroup.name);
          expect(res.body).to.have.property('description', privateGroup.description);
          expect(res.body).to.have.property('stripeAccount');
          expect(res.body.stripeAccount).to.have.property('stripePublishableKey', stripeMock.accounts.create.keys.publishable);
        }));

    it('successfully get a group if it is public', () => {
      request(app)
        .get('/groups/' + publicGroup.id)
        .expect(200)
        .toPromise()
        .tap(res => {
          expect(res.body).to.have.property('id', publicGroup.id);
          expect(res.body).to.have.property('name', publicGroup.name);
          expect(res.body).to.have.property('isPublic', publicGroup.isPublic);
          expect(res.body).to.have.property('stripeAccount');
          expect(res.body.stripeAccount).to.have.property('stripePublishableKey', stripeMock.accounts.create.keys.publishable);
        });
    });

    it('successfully get a group by its slug (case insensitive)', () =>
      request(app)
        .get('/groups/' + publicGroup.slug.toUpperCase())
        .expect(200)
        .toPromise()
        .tap(res => {
          expect(res.body).to.have.property('id', publicGroup.id);
          expect(res.body).to.have.property('name', publicGroup.name);
          expect(res.body).to.have.property('isPublic', publicGroup.isPublic);
          expect(res.body).to.have.property('stripeAccount');
          expect(res.body.stripeAccount).to.have.property('stripePublishableKey', stripeMock.accounts.create.keys.publishable);
        }));

    it('fails getting a group if the application authenticated has no access', () =>
      request(app)
        .get('/groups/' + privateGroup.id)
        .send({
          api_key: application3.api_key
        })
        .expect(403));

    it('successfully get a group if authenticated as a group', () =>
      request(app)
        .get('/groups/' + privateGroup.id)
        .send({
          api_key: application2.api_key
        })
        .expect(200));

    describe('Transactions/Activities/Budget', () => {

      var group2;
      var transactions = [];
      var totTransactions = 0;
      var totDonations = 0;

      // Create group2.
      beforeEach(() => models.Group.create(_.omit(utils.data('group2'),['slug']))
        .tap(g => group2 = g)
        .then(() => group2.addUserWithRole(user, roles.HOST)));

      // Create transactions for publicGroup.
      beforeEach(() =>
        Promise.all(transactionsData.map(transaction => {
          if (transaction.amount < 0)
            totTransactions += transaction.amount;
          else
            totDonations += transaction.amount;

          return request(app)
            .post('/groups/' + publicGroup.id + '/transactions')
            .set('Authorization', 'Bearer ' + user.jwt(application))
            .send({
              transaction: _.extend({}, transaction, { approved: true })
            })
            .expect(200)
            .toPromise()
            .tap(res => transactions.push(res.body));
        })));

      // Create a subscription for PublicGroup.
      beforeEach(done =>
        createTransaction({
            transaction: transactionsData[7],
            user,
            group: publicGroup,
            subscription: utils.data('subscription1')
          }, done));

      // Create a transaction for group2.
      beforeEach(() =>
        request(app)
          .post('/groups/' + group2.id + '/transactions')
          .set('Authorization', 'Bearer ' + user.jwt(application))
          .send({
            transaction: transactionsData[0]
          })
          .expect(200));

      it('successfully gets a group with remaining budget', () =>
        request(app)
          .get('/groups/' + publicGroup.id)
          .send({
            api_key: application2.api_key
          })
          .expect(200)
          .toPromise()
          .tap(res => {
            var g = res.body;
            expect(g).to.have.property('balance', Math.round((totDonations + totTransactions)*100)/100);
            expect(g).to.have.property('yearlyIncome', (totDonations + transactionsData[7].amount * 12)*100);
            expect(g).to.not.have.property('activities');
          }));

      it('successfully gets a group with activities', () =>
        request(app)
          .get('/groups/' + publicGroup.id)
          .send({
            api_key: application2.api_key,
            activities: true
          })
          .expect(200)
          .toPromise()
          .tap(res => {
            var group = res.body;
            expect(group).to.have.property('activities');
            expect(group.activities).to.have.length(transactionsData.length + 1 + 1 + 1); // + subscription + group.created + group.user.added

            // Check data content.
            group.activities.forEach((a) => {
              if (a.GroupId)
                expect(a.data).to.have.property('group');
              if (a.UserId)
                expect(a.data).to.have.property('user');
              if (a.TransactionId)
                expect(a.data).to.have.property('transaction');
            });
          }));

      it('successfully gets a group\'s users if it is public', () =>
        request(app)
          .get('/groups/' + publicGroup.id + '/users')
          .send({
            api_key: application2.api_key
          })
          .expect(200)
          .toPromise()
          .tap(res => {
            var userData = res.body[0];
            expect(userData.name).to.equal(user.public.name);
            expect(userData.role).to.equal(roles.HOST);
            expect(userData.tier).to.equal('host');
          }));
    });

    describe('Leaderboard', () => {

      it('fails if the app is not authorized', () =>
        request(app)
          .get('/leaderboard')
          .expect(400, {
            error: {
              code: 400,
              type: 'missing_required',
              message: 'Missing required fields',
              fields: { api_key: 'Required field api_key missing' }
            }
          }));

      it('returns the leaderboard', () =>
        request(app)
          .get('/leaderboard')
          .send({
            api_key: application2.api_key
          })
          .expect(200));
    });

  });

  /**
   * Update.
   */
  describe('#update', () => {

    var group;
    var user2;
    var user3;
    var application2;
    var groupNew = {
      name: 'new name',
      mission: 'new mission',
      description: 'new desc',
      longDescription: 'long description',
      whyJoin: 'because you should',
      budget: 1000000,
      burnrate: 10000,
      logo: 'http://opencollective.com/assets/logo.svg',
      video: 'http://opencollective.com/assets/video.mp4',
      image: 'http://opencollective.com/assets/image.jpg',
      backgroundImage: 'http://opencollective.com/assets/backgroundImage.png',
      expensePolicy: 'expense policy',
      isPublic: true,
      settings: { lang: 'fr' },
      otherprop: 'value'
    };

    // Create the group with user.
    beforeEach(() =>
      request(app)
        .post('/groups')
        .set('Authorization', 'Bearer ' + user.jwt(application))
        .send({
          group: publicGroupData,
          role: roles.HOST
        })
        .expect(200)
        .then(res => models.Group.find(parseInt(res.body.id)))
        .tap(g => group = g));

    // Create another user.
    beforeEach(() => models.User.create(utils.data('user2')).tap(u => user2 = u));

    // Create another user that is a backer.
    beforeEach(() =>
      models.User.create(utils.data('user3'))
        .tap(u => user3 = u)
        .then(() => group.addUserWithRole(user3, roles.BACKER)));

    // Create another user that is a member.
    beforeEach(() =>
      models.User.create(utils.data('user4'))
        .tap(u => user4 = u)
        .then(() => group.addUserWithRole(user4, roles.MEMBER)));

    // Create an application which has only access to `group`
    beforeEach(() =>
      models.Application.create(utils.data('application2'))
        .tap(a => application2 = a)
        .then(() => application2.addGroup(group)));

    it('fails updating a group if not authenticated', () =>
      request(app)
        .put('/groups/' + group.id)
        .send({ group: groupNew })
        .expect(401));

    it('fails updating a group if the user authenticated has no access', () =>
      request(app)
        .put('/groups/' + group.id)
        .set('Authorization', 'Bearer ' + user2.jwt(application))
        .send({ group: groupNew })
        .expect(403));

    it('fails updating a group if the user authenticated is a viewer', () =>
      request(app)
        .put('/groups/' + group.id)
        .set('Authorization', 'Bearer ' + user3.jwt(application))
        .send({ group: groupNew })
        .expect(403));

    it('fails updating a group if no data passed', () =>
      request(app)
        .put('/groups/' + group.id)
        .set('Authorization', 'Bearer ' + user.jwt(application))
        .expect(400));

    it('successfully updates a group if authenticated as a MEMBER', () =>
      request(app)
        .put('/groups/' + group.id)
        .set('Authorization', 'Bearer ' + user4.jwt(application))
        .send({ group: groupNew })
        .expect(200));

    it('successfully udpates a group if authenticated as a user', () =>
      request(app)
        .put('/groups/' + group.id)
        .set('Authorization', 'Bearer ' + user.jwt(application))
        .send({ group: groupNew })
        .expect(200)
        .toPromise()
        .tap(res => {
          expect(res.body).to.have.property('id', group.id);
          expect(res.body).to.have.property('name', groupNew.name);
          expect(res.body).to.have.property('mission', groupNew.mission);
          expect(res.body).to.have.property('description', groupNew.description);
          expect(res.body).to.have.property('longDescription', groupNew.longDescription);
          expect(res.body).to.have.property('whyJoin', groupNew.whyJoin);
          expect(res.body.settings).to.have.property('lang', groupNew.settings.lang);
          expect(res.body).to.have.property('budget', groupNew.budget);
          expect(res.body).to.have.property('burnrate', groupNew.burnrate);
          expect(res.body).to.have.property('logo', groupNew.logo);
          expect(res.body).to.have.property('video', groupNew.video);
          expect(res.body).to.have.property('image', groupNew.image);
          expect(res.body).to.have.property('backgroundImage', groupNew.backgroundImage);
          expect(res.body).to.have.property('expensePolicy', groupNew.expensePolicy);
          expect(res.body).to.have.property('isPublic', groupNew.isPublic);
          expect(res.body).to.not.have.property('otherprop');
          expect(new Date(res.body.createdAt).getTime()).to.equal(new Date(group.createdAt).getTime());
          expect(new Date(res.body.updatedAt).getTime()).to.not.equal(new Date(group.updatedAt).getTime());
        }));

    it('successfully updates a group if authenticated as an application', () =>
      request(app)
        .put('/groups/' + group.id)
        .send({
          api_key: application2.api_key,
          group: groupNew
        })
        .expect(200));

    it('successfully create a group with HOST and assign same person to be a MEMBER and a BACKER', () =>
      /* TODO: this works but we'll need to do a lot refactoring.
       * Need to find a way to call this with one line: like group.addUser()
       */
      models.UserGroup.create({
        UserId: user3.id,
        GroupId: group.id,
        role: roles.MEMBER
      })
      .then(() => models.UserGroup.findAll())
      .tap(rows => expect(rows.length).to.equal(4)));
  });
});
