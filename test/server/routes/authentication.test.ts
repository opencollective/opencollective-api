import { expect } from 'chai';
import config from 'config';
import type { Express } from 'express';
import { createSandbox } from 'sinon';
import request from 'supertest';

import OAuthScopes from '../../../server/constants/oauth-scopes';
import { idDecode, idEncode, IDENTIFIER_TYPES } from '../../../server/graphql/v2/identifiers';
import app from '../../../server/index';
import { sessionCache } from '../../../server/lib/cache';
import { Activity, User } from '../../../server/models';
import stripe from '../../../server/paymentProviders/stripe';
import transferwise from '../../../server/paymentProviders/transferwise';
import { fakeActiveHost, fakePersonalToken, fakeUser, fakeUserToken } from '../../test-helpers/fake-data';
import { resetTestDB } from '../../utils';

const initiationAliases = ['/connected-accounts/github', '/connected-accounts/github/oauthUrl'];
const rejectionMessage = 'OAuth and personal tokens cannot be used on this endpoint';
const testIps = ['198.51.100.120', '198.51.100.121'];
const limiterKey = (ip: string) => `connected-accounts-authenticate-${ip}`;

describe('REST session authentication and connected-account rate limiting', () => {
  const sandbox = createSandbox();
  let expressApp: Express;
  let user: User;

  before(async () => {
    expressApp = await app();
  });

  beforeEach(async () => {
    await Activity.waitAllDispatch();
    await resetTestDB();
    await sessionCache.delete(testIps.map(limiterKey));
    user = await fakeUser();
  });

  afterEach(async () => {
    await Activity.waitAllDispatch();
    sandbox.restore();
    await sessionCache.delete(testIps.map(limiterKey));
  });

  const getScopedHeaders = async (tokenType: 'OAuth' | 'PAT') => {
    const scope = [OAuthScopes.account, OAuthScopes.connectedAccounts, OAuthScopes.expenses];
    if (tokenType === 'PAT') {
      const token = await fakePersonalToken({ user, scope });
      return { 'Personal-Token': token.token };
    }
    const token = await fakeUserToken({ user, scope });
    // eslint-disable-next-line camelcase -- Match the OAuth JWT payload field.
    return { Authorization: `Bearer ${user.jwt({ scope: 'oauth', access_token: token.accessToken })}` };
  };

  for (const alias of initiationAliases) {
    describe(alias, () => {
      for (const tokenType of ['OAuth', 'PAT'] as const) {
        it(`rejects ${tokenType} with connected-account scope before creating provider state`, async () => {
          const headers = await getScopedHeaders(tokenType);
          const cacheSpy = sandbox.spy(sessionCache, 'set');
          const response = await request(expressApp)
            .get(alias)
            .set('X-Forwarded-For', testIps[0])
            .set(headers)
            .expect(401);

          expect(response.body.error.message).to.include(rejectionMessage);
          expect(cacheSpy.args.some(([key]) => key.startsWith('oauth-github-state:'))).to.be.false;
        });
      }

      it('accepts a session and stores provider state bound to the user', async () => {
        const token = await user.generateSessionToken({ createActivity: false });
        const response = await request(expressApp)
          .get(alias)
          .set('X-Forwarded-For', testIps[0])
          .set('Authorization', `Bearer ${token}`)
          .expect(200);

        const redirectUrl = new URL(response.body.redirectUrl);
        expect(redirectUrl.hostname).to.eq('github.com');
        expect(redirectUrl.searchParams.get('client_id')).to.eq(config.github.clientID);
        const state = await sessionCache.get(`oauth-github-state:${redirectUrl.searchParams.get('state')}`);
        expect(state.userId).to.eq(user.id);
      });

      it('preserves the requirement to sign in before initiating GitHub OAuth', async () => {
        const response = await request(expressApp).get(alias).set('X-Forwarded-For', testIps[0]).expect(401);
        expect(response.body.error.message).to.eq('You must be logged in to connect a GitHub account');
      });
    });
  }

  describe('Wise batch payments', () => {
    let hostId: string;
    let payBatchSpy;

    beforeEach(async () => {
      const host = await fakeActiveHost({
        admin: user.collective,
        settings: { transferwise: { ott: true } },
      });
      hostId = idEncode(host.id, IDENTIFIER_TYPES.ACCOUNT);
      payBatchSpy = sandbox.stub(transferwise, 'payExpensesBatchGroup').resolves({
        id: 'test-batch',
        status: 'COMPLETED',
        transferIds: [],
      });
    });

    for (const tokenType of ['OAuth', 'PAT'] as const) {
      it(`rejects a host admin's ${tokenType} even with expenses scope`, async () => {
        const response = await request(expressApp)
          .post('/services/transferwise/pay-batch')
          .set(await getScopedHeaders(tokenType))
          .send({ hostId, expenseIds: [] })
          .expect(401);

        expect(response.body.error.message).to.include(rejectionMessage);
        expect(payBatchSpy).to.not.have.been.called;
      });
    }

    it('accepts a host admin session and reaches the payment provider', async () => {
      const token = await user.generateSessionToken({ createActivity: false });
      await request(expressApp)
        .post('/services/transferwise/pay-batch')
        .set('Authorization', `Bearer ${token}`)
        .send({ hostId, expenseIds: [] })
        .expect(200);

      expect(payBatchSpy).to.have.been.calledOnce;
      expect(payBatchSpy.firstCall.args[0].host.id).to.eq(idDecode(hostId, IDENTIFIER_TYPES.ACCOUNT));
    });
  });

  it('shares the real 60-request limit across aliases, before authorization and provider handling, per IP', async () => {
    const cacheSpy = sandbox.spy(sessionCache, 'set');
    const providerSpy = sandbox.spy(stripe.oauth, 'redirectUrl');

    // Unsupported services still consume the limit before the provider allowlist runs.
    for (let i = 0; i < 60; i++) {
      const path = i % 2 === 0 ? '/connected-accounts/unsupported' : '/connected-accounts/unsupported/oauthUrl';
      await request(expressApp).get(path).set('X-Forwarded-For', testIps[0]).expect(404);
    }
    expect(await sessionCache.get(limiterKey(testIps[0]))).to.eq(60);
    expect(cacheSpy).to.have.been.calledWith(limiterKey(testIps[0]), 60, 10);

    for (const alias of initiationAliases) {
      await request(expressApp)
        .get(alias)
        .set('X-Forwarded-For', testIps[0])
        .set(await getScopedHeaders('OAuth'))
        .expect(429);
    }
    const token = await user.generateSessionToken({ createActivity: false });
    await request(expressApp)
      .get('/connected-accounts/stripe/oauthUrl')
      .query({ CollectiveId: user.CollectiveId })
      .set('X-Forwarded-For', testIps[0])
      .set('Authorization', `Bearer ${token}`)
      .expect(429);
    expect(providerSpy).to.not.have.been.called;

    await request(expressApp)
      .get(initiationAliases[1])
      .set('X-Forwarded-For', testIps[1])
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(await sessionCache.get(limiterKey(testIps[1]))).to.eq(1);
    expect(await sessionCache.get(limiterKey(testIps[0]))).to.eq(60);
  });
});
