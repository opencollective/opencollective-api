import { expect } from 'chai';
import express from 'express';
import request from 'supertest';

import roles from '../../../server/constants/roles';
import setupExpress from '../../../server/lib/express';
import models from '../../../server/models';
import routes from '../../../server/routes';
import * as utils from '../../utils';

const application = utils.data('application');

describe('server/routes/stripe', () => {
  let host, user, collective, expressApp;

  before(async () => {
    expressApp = express();
    setupExpress(expressApp);
    await routes(expressApp);
  });

  beforeEach(() => utils.resetTestDB());

  beforeEach('create a host', async () => {
    host = await models.User.createUserWithCollective(utils.data('host1'));
  });
  beforeEach('create a user', async () => {
    user = await models.User.createUserWithCollective(utils.data('user1'));
  });
  beforeEach('create a collective', async () => {
    collective = await models.Collective.create(utils.data('collective1'));
  });
  beforeEach('add host', () => collective.addHost(host.collective, host));
  beforeEach('add backer', () => collective.addUserWithRole(user, roles.BACKER));

  describe('authorize', () => {
    it('should return an error if the user is not logged in', done => {
      request(expressApp)
        .get(`/connected-accounts/stripe/oauthUrl?api_key=${application.api_key}`)
        .expect(400)
        .end(done);
    });

    it('should return an error if not CollectiveId provided', done => {
      models.ConnectedAccount.create({
        service: 'stripe',
        CollectiveId: collective.id,
        username: 'stripeAccount',
      }).then(() =>
        request(expressApp)
          .get(`/connected-accounts/stripe/oauthUrl?api_key=${application.api_key}`)
          .set('Authorization', `Bearer ${host.jwt()}`)
          .then(response => {
            const error = response.body.error;
            expect(error.code).to.equal(400);
            expect(error.type).to.equal('validation_failed');
            expect(error.message).to.equal('Please provide a CollectiveId');
            done();
          }),
      );
    });

    it('should fail if not logged in as an admin of the collective', done => {
      models.ConnectedAccount.create({
        service: 'stripe',
        CollectiveId: collective.id,
        username: 'stripeAccount',
      }).then(() =>
        request(expressApp)
          .get(`/connected-accounts/stripe/oauthUrl?api_key=${application.api_key}&CollectiveId=${collective.id}`)
          .set('Authorization', `Bearer ${user.jwt()}`)
          .then(response => {
            const error = response.body.error;
            expect(error.code).to.equal(401);
            expect(error.type).to.equal('unauthorized');
            expect(error.message).to.equal('Please login as an admin of this collective to add a connected account');
            done();
          }),
      );
    });

    it('should redirect to stripe', done => {
      request(expressApp)
        .get(`/connected-accounts/stripe/oauthUrl?api_key=${application.api_key}&CollectiveId=${collective.id}`)
        .set('Authorization', `Bearer ${host.jwt()}`)
        .expect(200)
        .end((e, res) => {
          expect(e).to.not.exist;
          expect(res.body.redirectUrl).to.contain('https://connect.stripe.com/oauth/authorize');
          expect(res.body.redirectUrl).to.contain('&state=');
          done();
        });
    });
  });

  // The legacy REST callback (/connected-accounts/stripe/callback) has been migrated to the
  // `connectStripeAccount` GraphQL mutation. See test/server/graphql/v2/mutation/StripeMutations.test.ts.
  describe('callback (deprecated)', () => {
    it('returns 401 since the OAuth callback is now handled by the GraphQL mutation', done => {
      request(expressApp)
        .get(`/connected-accounts/stripe/callback?api_key=${application.api_key}&state=any&code=any`)
        .expect(401)
        .end(done);
    });
  });
});
