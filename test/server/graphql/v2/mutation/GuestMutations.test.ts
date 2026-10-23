import { expect } from 'chai';
import config from 'config';
import gql from 'fake-tag';
import type { JwtPayload } from 'jsonwebtoken';
import { createSandbox } from 'sinon';
import request from 'supertest';

import ActivityTypes from '../../../../../server/constants/activities';
import app from '../../../../../server/index';
import { TOKEN_EXPIRATION_SESSION, verifyJwt } from '../../../../../server/lib/auth';
import emailLib from '../../../../../server/lib/email';
import { Activity } from '../../../../../server/models';
import { randEmail } from '../../../../stores';
import { fakeUser, randStr } from '../../../../test-helpers/fake-data';
import { graphqlQueryV2, resetTestDB } from '../../../../utils';

const confirmGuestAccountMutation = gql`
  mutation ConfirmGuestAccount($email: EmailAddress!, $emailConfirmationToken: String!) {
    confirmGuestAccount(email: $email, emailConfirmationToken: $emailConfirmationToken) {
      accessToken
      account {
        id
        legacyId
        slug
      }
    }
  }
`;

const callConfirmGuestAccount = (email, emailConfirmationToken, remoteUser = null) => {
  return graphqlQueryV2(confirmGuestAccountMutation, { email, emailConfirmationToken }, remoteUser);
};

describe('server/graphql/v2/mutation/GuestMutations', () => {
  let sandbox;

  before(async () => {
    await resetTestDB();
    sandbox = createSandbox();
    sandbox.stub(config, 'limits').value({
      sendGuestConfirmPerMinutePerIp: 1000000,
      sendGuestConfirmPerMinutePerEmail: 1000000,
      confirmGuestAccountPerMinutePerIp: 1000000,
    });
  });

  after(() => {
    sandbox.restore();
  });

  describe('confirmGuestAccount', () => {
    it('fails if account is already confirmed', async () => {
      const user = await fakeUser({ confirmedAt: new Date(), emailConfirmationToken: randStr() });
      const response = await callConfirmGuestAccount(user.email, user.emailConfirmationToken);
      expect(response.errors).to.exist;
      expect(response.errors[0].message).to.include('This account has already been verified');
    });

    it('fails if email is invalid', async () => {
      const user = await fakeUser({ confirmedAt: null, emailConfirmationToken: randStr() });
      const response = await callConfirmGuestAccount(randEmail(), user.emailConfirmationToken);
      expect(response.errors).to.exist;
      expect(response.errors[0].message).to.include('No account found for');
    });

    it('fails if confirmation token is invalid', async () => {
      const user = await fakeUser({ confirmedAt: null, emailConfirmationToken: randStr() });
      const response = await callConfirmGuestAccount(user.email, 'INVALID TOKEN');
      expect(response.errors).to.exist;
      expect(response.errors[0].message).to.include('Invalid email confirmation token');
    });

    it('returns a valid login token', async () => {
      const lastLoginAt = new Date('2020-01-01T00:00:00Z');
      const user = await fakeUser({ confirmedAt: null, emailConfirmationToken: randStr(), lastLoginAt });
      const response = await callConfirmGuestAccount(user.email, user.emailConfirmationToken);
      response.errors && console.error(response.errors);
      expect(response.errors).to.not.exist;

      const { account, accessToken } = response.data.confirmGuestAccount;
      expect(account.legacyId).to.eq(user.CollectiveId);

      const decodedJwt = verifyJwt(accessToken) as JwtPayload;
      expect(decodedJwt.sub).to.eq(user.id.toString());
      expect(decodedJwt.scope).to.eq('session');
      expect(decodedJwt.sessionId).to.be.a('string').with.length.greaterThan(0);
      expect(decodedJwt.exp - decodedJwt.iat).to.eq(TOKEN_EXPIRATION_SESSION);

      const expressApp = await app();
      const status = await request(expressApp).get('/status').set('Authorization', `Bearer ${accessToken}`).expect(200);
      expect(status.body.authenticated).to.be.true;

      const refresh = await request(expressApp)
        .post('/users/refresh-token')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
      const refreshedJwt = verifyJwt(refresh.body.token) as JwtPayload;
      expect(refreshedJwt.sub).to.eq(decodedJwt.sub);
      expect(refreshedJwt.scope).to.eq('session');
      expect(refreshedJwt.sessionId).to.eq(decodedJwt.sessionId);
      expect(refreshedJwt.exp - refreshedJwt.iat).to.eq(TOKEN_EXPIRATION_SESSION);

      const otherGuest = await fakeUser({ confirmedAt: null, emailConfirmationToken: randStr() });
      const otherResponse = await callConfirmGuestAccount(otherGuest.email, otherGuest.emailConfirmationToken);
      expect(otherResponse.errors).to.not.exist;
      const otherJwt = verifyJwt(otherResponse.data.confirmGuestAccount.accessToken) as JwtPayload;
      expect(otherJwt.sessionId).to.be.a('string').with.length.greaterThan(0);
      expect(otherJwt.sessionId).to.not.eq(decodedJwt.sessionId);

      await user.reload();
      expect(user.lastLoginAt.getTime()).to.eq(lastLoginAt.getTime());
    });

    it('does not touch lastLoginAt, which would invalidate pending magic links', async () => {
      const lastLoginAt = new Date('2020-01-01T00:00:00Z');
      const user = await fakeUser({ confirmedAt: null, emailConfirmationToken: randStr(), lastLoginAt });
      const response = await callConfirmGuestAccount(user.email, user.emailConfirmationToken);
      expect(response.errors).to.not.exist;

      await user.reload();
      expect(user.lastLoginAt.getTime()).to.eq(lastLoginAt.getTime());
    });

    it('persists a sign-in activity without sending email, even with a prior device record', async () => {
      const lastLoginAt = new Date('2020-01-01T00:00:00Z');
      const lastSignInRequest = { ip: '192.0.2.1', userAgent: 'Previous device' };
      const user = await fakeUser({
        confirmedAt: null,
        emailConfirmationToken: randStr(),
        lastLoginAt,
        data: { lastSignInRequest },
      });
      await Activity.create({
        type: ActivityTypes.USER_SIGNIN,
        UserId: user.id,
        CollectiveId: user.CollectiveId,
        FromCollectiveId: user.CollectiveId,
        data: { notify: false },
      });
      await Activity.waitAllDispatch();
      const emailSpy = sandbox.spy(emailLib, 'sendMessage');
      try {
        const response = await callConfirmGuestAccount(user.email, user.emailConfirmationToken);
        expect(response.errors).to.not.exist;
        await Activity.waitAllDispatch();

        const signIns = await Activity.findAll({
          where: { type: ActivityTypes.USER_SIGNIN, UserId: user.id },
          order: [['id', 'ASC']],
        });
        expect(signIns).to.have.length(2);
        expect(signIns[1].data.notify).to.be.false;
        expect(signIns[1].CollectiveId).to.eq(user.CollectiveId);
        expect(signIns[1].FromCollectiveId).to.eq(user.CollectiveId);
        expect(emailSpy).to.not.have.been.called;

        await user.reload();
        expect(user.lastLoginAt.getTime()).to.eq(lastLoginAt.getTime());
        expect(user.data.lastSignInRequest).to.deep.eq(lastSignInRequest);
      } finally {
        emailSpy.restore();
      }
    });

    it('confirmGuestAccount rate limited on IP', async () => {
      sandbox.stub(config, 'limits').value({ confirmGuestAccountPerMinutePerIp: 0 });
      const user = await fakeUser({ confirmedAt: null, emailConfirmationToken: randStr() });
      const response = await callConfirmGuestAccount(user.email, user.emailConfirmationToken);
      expect(response.errors).to.exist;
      expect(response.errors[0].message).to.include('Rate limit exceeded');
    });
  });
});
