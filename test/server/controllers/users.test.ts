import bcrypt from 'bcrypt';
import { expect } from 'chai';
import config from 'config';
import { omit } from 'lodash';
import httpMocks from 'node-mocks-http';
import sinon from 'sinon';

import ActivityTypes from '../../../server/constants/activities';
import { resendEmailVerificationOTP, signin, signup, verifyEmail } from '../../../server/controllers/users';
import { generateLoaders } from '../../../server/graphql/loaders';
import { OTP_RATE_LIMIT_MAX_ATTEMPTS, OTP_SESSION_MAX_AGE } from '../../../server/lib/auth';
import { sessionCache } from '../../../server/lib/cache';
import emailLib from '../../../server/lib/email';
import logger from '../../../server/lib/logger';
import models from '../../../server/models';
import { fakeUser, randEmail, randIPV4 } from '../../test-helpers/fake-data';

describe('server/controllers/users', () => {
  let sandbox;

  before(async () => {
    sandbox = sinon.createSandbox();
  });
  beforeEach(() => {
    sessionCache.clear();
  });

  afterEach(() => {
    sandbox.restore();
    sessionCache.clear();
  });

  const makeSignupRequest = async (email: string, ip: string) => {
    const request = httpMocks.createRequest({
      method: 'POST',
      url: `/users/signup`,
      body: {
        email,
      },
      ip,
    });
    request.loaders = generateLoaders({});
    const response = httpMocks.createResponse();

    await signup(request, response);
    return response;
  };

  const makeResendOtpRequest = async (email: string, sessionId: string, ip: string) => {
    const request = httpMocks.createRequest({
      method: 'POST',
      url: `/users/resend-otp`,
      body: {
        email,
        sessionId,
      },
      ip,
    });
    request.loaders = generateLoaders({});
    const response = httpMocks.createResponse();

    await resendEmailVerificationOTP(request, response);
    return response;
  };

  const makeVerifyOtpRequest = async (email: string, otp: string, sessionId: string, ip: string) => {
    const request = httpMocks.createRequest({
      method: 'POST',
      url: `/users/verify-email`,
      body: {
        email,
        otp,
        sessionId,
      },
      ip,
    });
    request.loaders = generateLoaders({});
    const response = httpMocks.createResponse();

    await verifyEmail(request, response);
    return response;
  };

  const makeSignInRequest = async (email: string, ip: string) => {
    const request = httpMocks.createRequest({
      method: 'POST',
      url: `/users/signin`,
      body: {
        user: {
          email,
        },
      },
      ip,
    });
    request.loaders = generateLoaders({});
    const response = httpMocks.createResponse();

    await signin(request, response, () => {});
    return response;
  };

  describe('signin', () => {
    it('does not honor privilege flags in the user payload (security regression)', async () => {
      sandbox.stub(emailLib, 'send').resolves();
      const email = randEmail();
      const request = httpMocks.createRequest({
        method: 'POST',
        url: `/users/signin`,
        body: {
          user: {
            email,
            hasMoneyManagement: true,
            hasHosting: true,
            data: { isRoot: true },
            settings: { disableGrants: true },
          },
        },
        ip: randIPV4(),
      });
      request.loaders = generateLoaders({});
      const response = httpMocks.createResponse();

      await signin(request, response, () => {});
      expect(response._getStatusCode()).to.eql(200);

      const user = await models.User.findOne({
        where: { email },
        include: [{ model: models.Collective, as: 'collective' }],
      });
      expect(user).to.exist;
      expect(user.collective.hasMoneyManagement).to.equal(false);
      expect(user.collective.hasHosting).to.equal(false);
      expect(user.collective.data).to.not.have.property('isRoot');
      expect(user.collective.settings || {}).to.not.have.property('disableGrants');
    });
  });

  describe('signup', () => {
    it('should create a new user, create a session information about the OTP and send OTP through email', async () => {
      sandbox.stub(emailLib, 'send').resolves();
      const email = randEmail();

      const response = await makeSignupRequest(email, randIPV4());
      expect(response._getStatusCode()).to.eql(200);
      expect(response._getData().sessionId).to.be.a('string');

      const otpSessionKey = `otp_signup_${email}`;
      const otpSession = await sessionCache.get(otpSessionKey);
      expect(otpSession).to.exist;
      expect(otpSession.secret).to.be.a('string');
      expect(otpSession.userId).to.be.a('number');
      expect(otpSession.tries).to.equal(0);

      const user = await models.User.findByPk(otpSession.userId, {
        include: [{ model: models.Collective, as: 'collective' }],
      });
      expect(user.confirmedAt).to.be.null;
      expect(user.data.requiresVerification).to.be.true;
      expect(user.collective.data.isSuspended).to.be.true;

      expect(emailLib.send).to.have.been.calledWithMatch(ActivityTypes.USER_OTP_REQUESTED, user.email);
    });

    it('should stamp the OTP session with the absolute lifetime start (createdAt)', async () => {
      sandbox.stub(emailLib, 'send').resolves();
      const email = randEmail();
      const before = Date.now();

      const response = await makeSignupRequest(email, randIPV4());
      expect(response._getStatusCode()).to.eql(200);

      const otpSessionKey = `otp_signup_${email}`;
      const otpSession = await sessionCache.get(otpSessionKey);
      expect(otpSession).to.exist;
      expect(otpSession.createdAt).to.be.a('number');
      // createdAt must anchor the absolute TTL, so it has to be "now" - not the session's expiry
      expect(otpSession.createdAt).to.be.at.least(before);
      expect(otpSession.createdAt).to.be.at.most(Date.now());
      expect(OTP_SESSION_MAX_AGE).to.be.greaterThan(0);
    });

    it('should reuse an existing unconfirmed user as an alternative to the magic-link ', async () => {
      sandbox.stub(emailLib, 'send').resolves();
      const user = await fakeUser({ confirmedAt: null });
      const response = await makeSignupRequest(user.email, randIPV4());
      expect(response._getStatusCode()).to.eql(200);

      const otpSessionKey = `otp_signup_${user.email}`;
      const otpSession = await sessionCache.get(otpSessionKey);
      expect(otpSession).to.exist;
      expect(otpSession.secret).to.be.a('string');
      expect(otpSession.userId).to.be.a('number');
      expect(otpSession.tries).to.equal(0);

      expect(emailLib.send).to.have.been.calledWithMatch(ActivityTypes.USER_OTP_REQUESTED, user.email);
    });

    it('should fail if a verified user already exists', async () => {
      const user = await fakeUser({ confirmedAt: new Date() });

      const response = await makeSignupRequest(user.email, randIPV4());
      expect(response._getStatusCode()).to.eql(403);
      expect(response._getData()).to.eql({ error: { message: 'User already exists', type: 'USER_ALREADY_EXISTS' } });
    });

    it('should fail if an ongoing OTP request exists', async () => {
      const email = randEmail();

      await makeSignupRequest(email, randIPV4());
      const response = await makeSignupRequest(email, randIPV4());
      expect(response._getStatusCode()).to.eql(401);
      expect(response._getData()).to.eql({
        error: { message: 'OTP request already exists', type: 'OTP_REQUEST_EXISTS' },
      });
    });

    it('should be rate-limited on the request IP', async () => {
      const ip = randIPV4();

      for (let i = 0; i < OTP_RATE_LIMIT_MAX_ATTEMPTS + 2; i++) {
        await makeSignupRequest(randEmail(), ip);
      }
      const response = await makeSignupRequest(randEmail(), ip);
      expect(response._getStatusCode()).to.eql(403);
    });

    it('should be rate-limited on the email', async () => {
      const email = randEmail();

      for (let i = 0; i < OTP_RATE_LIMIT_MAX_ATTEMPTS; i++) {
        await makeSignupRequest(email, randIPV4());
      }

      const response = await makeSignupRequest(email, randIPV4());
      expect(response._getStatusCode()).to.eql(403);
    });

    it('should share one per-email budget between signup and resend-otp (no alternation bypass)', async () => {
      sandbox.stub(emailLib, 'send').resolves();
      const email = randEmail();

      // Every call comes from a fresh IP, so only the per-email budget can stop the alternation
      const response = await makeSignupRequest(email, randIPV4());
      expect(response._getStatusCode()).to.eql(200);
      const sessionId = response._getData().sessionId;

      await makeResendOtpRequest(email, sessionId, randIPV4()); // 2
      await makeSignupRequest(email, randIPV4()); // 3 - 401 OTP_REQUEST_EXISTS, but it still costs
      await makeResendOtpRequest(email, sessionId, randIPV4()); // 4
      await makeSignupRequest(email, randIPV4()); // 5 - budget now exhausted

      // Alternating the two routes must not unlock calls that neither route would get alone
      const resendResponse = await makeResendOtpRequest(email, sessionId, randIPV4());
      expect(resendResponse._getStatusCode()).to.eql(403);
      expect(resendResponse._getData()).to.eql({
        error: { message: 'Rate limit exceeded', type: 'RATE_LIMIT_EXCEEDED' },
      });

      const signupResponse = await makeSignupRequest(email, randIPV4());
      expect(signupResponse._getStatusCode()).to.eql(403);
      expect(signupResponse._getData()).to.eql({
        error: { message: 'Rate limit exceeded', type: 'RATE_LIMIT_EXCEEDED' },
      });

      // verify-email keeps its own budget and stays reachable - it sends no mail
      const verifyResponse = await makeVerifyOtpRequest(email, '023456', sessionId, randIPV4());
      expect(verifyResponse._getData()).to.eql({
        error: { message: 'Invalid or expired OTP code', type: 'INVALID_OTP' },
      });
    });

    it('should be impossible to use a pending verification email to sign-in', async () => {
      sandbox.stub(emailLib, 'send').resolves();
      const email = randEmail();

      let response = await makeSignupRequest(email, randIPV4());
      expect(response._getStatusCode()).to.eql(200);

      response = await makeSignInRequest(email, randIPV4());
      expect(response._getStatusCode()).to.eql(403);
      expect(response._getData()).to.eql({
        message: 'Email awaiting verification',
        errorCode: 'EMAIL_AWAITING_VERIFICATION',
      });
    });
  });

  describe('resendEmailVerificationOTP', () => {
    it('shoud fail if we are not waiting for an OTP for provided email', async () => {
      sandbox.stub(emailLib, 'send').resolves();
      const email = randEmail();

      const response = await makeSignupRequest(email, randIPV4());
      expect(response._getStatusCode()).to.eql(200);
      const responseData = response._getData();
      expect(responseData.sessionId).to.be.a('string');

      const otpSessionKey = `otp_signup_${email}`;
      const otpSession = await sessionCache.get(otpSessionKey);
      expect(otpSession).to.exist;

      const user = await models.User.findByPk(otpSession.userId);
      expect(user.confirmedAt).to.be.null;
      expect(user.data.requiresVerification).to.be.true;

      expect(emailLib.send).to.have.been.calledWithMatch(ActivityTypes.USER_OTP_REQUESTED, user.email);

      const otherEmail = randEmail();
      const resendResponse = await makeResendOtpRequest(otherEmail, responseData.sessionId, randIPV4());
      expect(resendResponse._getStatusCode()).to.eql(401);
      expect(emailLib.send).to.have.not.been.calledWithMatch(ActivityTypes.USER_OTP_REQUESTED, otherEmail);
    });

    it('shoud generate a new OTP and send it to the same email', async () => {
      sandbox.stub(emailLib, 'send').resolves();
      const email = randEmail();

      const response = await makeSignupRequest(email, randIPV4());
      expect(response._getStatusCode()).to.eql(200);
      const responseData = response._getData();
      expect(responseData.sessionId).to.be.a('string');

      const otpSessionKey = `otp_signup_${email}`;
      let otpSession = await sessionCache.get(otpSessionKey);
      expect(otpSession).to.exist;
      expect(otpSession.secret).to.be.a('string');
      expect(otpSession.userId).to.be.a('number');
      expect(otpSession.tries).to.equal(0);
      const firstSecret = otpSession.secret;

      const user = await models.User.findByPk(otpSession.userId);
      expect(user.data.requiresVerification).to.be.true;
      expect(user.confirmedAt).to.be.null;

      expect(emailLib.send).to.have.been.calledWithMatch(ActivityTypes.USER_OTP_REQUESTED, user.email);
      const firstOtp = (emailLib.send as sinon.SinonStub).getCall(0).args[2]['otp'];

      const resendResponse = await makeResendOtpRequest(email, responseData.sessionId, randIPV4());
      expect(resendResponse._getStatusCode()).to.eql(200);
      const secondOtp = (emailLib.send as sinon.SinonStub).getCall(1).args[2]['otp'];
      expect(secondOtp).to.not.equal(firstOtp);

      otpSession = await sessionCache.get(otpSessionKey);
      expect(otpSession).to.exist;
      expect(otpSession.secret).to.be.a('string');
      expect(otpSession.secret).to.not.equal(firstSecret);
    });

    it('should preserve the original createdAt when rebuilding the session (resend must not extend the absolute lifetime)', async () => {
      sandbox.stub(emailLib, 'send').resolves();
      const email = randEmail();

      const response = await makeSignupRequest(email, randIPV4());
      expect(response._getStatusCode()).to.eql(200);
      const responseData = response._getData();

      const otpSessionKey = `otp_signup_${email}`;
      const initialSession = await sessionCache.get(otpSessionKey);
      expect(initialSession.createdAt).to.be.a('number');

      const resendResponse = await makeResendOtpRequest(email, responseData.sessionId, randIPV4());
      expect(resendResponse._getStatusCode()).to.eql(200);

      const rebuiltSession = await sessionCache.get(otpSessionKey);
      expect(rebuiltSession).to.exist;
      expect(rebuiltSession.createdAt).to.equal(initialSession.createdAt);
    });

    it('should reject and clear a session that outlived OTP_SESSION_MAX_AGE', async () => {
      sandbox.stub(emailLib, 'send').resolves();
      const email = randEmail();

      const otpResponse = await makeSignupRequest(email, randIPV4());
      expect(otpResponse._getStatusCode()).to.eql(200);
      const responseData = otpResponse._getData();

      const otpSessionKey = `otp_signup_${email}`;
      const otpSession = await sessionCache.get(otpSessionKey);
      await sessionCache.set(
        otpSessionKey,
        { ...otpSession, createdAt: Date.now() - (OTP_SESSION_MAX_AGE + 60) * 1000 },
        OTP_SESSION_MAX_AGE,
      );

      const sendCountBefore = (emailLib.send as sinon.SinonStub).callCount;
      const resendResponse = await makeResendOtpRequest(email, responseData.sessionId, randIPV4());
      expect(resendResponse._getStatusCode()).to.eql(401);
      // No new OTP may be emailed for an expired challenge
      expect((emailLib.send as sinon.SinonStub).callCount).to.equal(sendCountBefore);

      const remaining = await sessionCache.get(otpSessionKey);
      expect(remaining).to.be.undefined;
    });

    it('should fail closed on a session that predates the createdAt field', async () => {
      sandbox.stub(emailLib, 'send').resolves();
      const email = randEmail();

      const otpResponse = await makeSignupRequest(email, randIPV4());
      const responseData = otpResponse._getData();

      const otpSessionKey = `otp_signup_${email}`;
      const otpSession = await sessionCache.get(otpSessionKey);
      await sessionCache.set(otpSessionKey, omit(otpSession, ['createdAt']), OTP_SESSION_MAX_AGE);

      const sendCountBefore = (emailLib.send as sinon.SinonStub).callCount;
      const resendResponse = await makeResendOtpRequest(email, responseData.sessionId, randIPV4());
      expect(resendResponse._getStatusCode()).to.eql(401);
      expect((emailLib.send as sinon.SinonStub).callCount).to.equal(sendCountBefore);

      const remaining = await sessionCache.get(otpSessionKey);
      expect(remaining).to.be.undefined;
    });

    it('should refuse and clear the session when the user has already confirmed their email', async () => {
      sandbox.stub(emailLib, 'send').resolves();
      const email = randEmail();

      const otpResponse = await makeSignupRequest(email, randIPV4());
      expect(otpResponse._getStatusCode()).to.eql(200);
      const responseData = otpResponse._getData();

      const otpSessionKey = `otp_signup_${email}`;
      const otpSession = await sessionCache.get(otpSessionKey);

      // Confirming out-of-band never clears `data.requiresVerification`, so the existing gate alone
      // would keep re-sending OTPs and refreshing the session past the confirmation.
      await models.User.update({ confirmedAt: new Date() }, { where: { id: otpSession.userId } });

      const sendCountBefore = (emailLib.send as sinon.SinonStub).callCount;
      const resendResponse = await makeResendOtpRequest(email, responseData.sessionId, randIPV4());
      expect(resendResponse._getStatusCode()).to.eql(401);
      expect((emailLib.send as sinon.SinonStub).callCount).to.equal(sendCountBefore);

      const remaining = await sessionCache.get(otpSessionKey);
      expect(remaining).to.be.undefined;
    });
  });

  describe('verifyEmail', () => {
    it('should verify OTP and confirm user email', async () => {
      sandbox.stub(emailLib, 'send').resolves();
      const email = randEmail();

      const otpResponse = await makeSignupRequest(email, randIPV4());
      expect(otpResponse._getStatusCode()).to.eql(200);
      const responseData = otpResponse._getData();
      expect(responseData.sessionId).to.be.a('string');

      const otpSessionKey = `otp_signup_${email}`;
      let otpSession = await sessionCache.get(otpSessionKey);
      expect(otpSession).to.exist;
      const user = await models.User.findByPk(otpSession.userId);
      expect(user.data.requiresVerification).to.be.true;

      const sendEmailCall = (emailLib.send as sinon.SinonStub).getCall(0);
      const otp = sendEmailCall.args[2].otp;
      const verifyResponse = await makeVerifyOtpRequest(email, otp, responseData.sessionId, randIPV4());
      expect(verifyResponse._getStatusCode()).to.eql(200);

      // Should add confirmedAt to user
      await user.reload({ include: [{ model: models.Collective, as: 'collective' }] });
      expect(user.confirmedAt).to.be.instanceOf(Date);
      expect(user.data.requiresVerification).to.be.undefined;
      expect(user.collective.data.isSuspended).to.be.undefined;

      // Should clear OTP session
      otpSession = await sessionCache.get(otpSessionKey);
      expect(otpSession).to.be.undefined;
    });

    it('should fail with an invalid OTP', async () => {
      sandbox.stub(emailLib, 'send').resolves();
      const email = randEmail();

      const otpResponse = await makeSignupRequest(email, randIPV4());
      expect(otpResponse._getStatusCode()).to.eql(200);
      const responseData = otpResponse._getData();
      expect(responseData.sessionId).to.be.a('string');

      const otpSessionKey = `otp_signup_${email}`;
      let otpSession = await sessionCache.get(otpSessionKey);
      expect(otpSession).to.exist;

      const verifyResponse = await makeVerifyOtpRequest(email, '023456', responseData.sessionId, randIPV4());
      expect(verifyResponse._getStatusCode()).to.eql(403);

      otpSession = await sessionCache.get(otpSessionKey);
      expect(otpSession).to.exist;
      expect(otpSession.tries).to.equal(1);
    });

    it('should fail with an expired OTP', async () => {
      sandbox.stub(emailLib, 'send').resolves();
      const email = randEmail();

      const otpResponse = await makeSignupRequest(email, randIPV4());
      expect(otpResponse._getStatusCode()).to.eql(200);
      const responseData = otpResponse._getData();
      expect(responseData.sessionId).to.be.a('string');

      const otpSessionKey = `otp_signup_${email}`;
      const otpSession = await sessionCache.get(otpSessionKey);
      expect(otpSession).to.exist;

      // Simulate expiry
      await sessionCache.delete(otpSessionKey);

      const sendEmailCall = (emailLib.send as sinon.SinonStub).getCall(0);
      const otp = sendEmailCall.args[2].otp;
      const verifyResponse = await makeVerifyOtpRequest(email, otp, responseData.sessionId, randIPV4());
      expect(verifyResponse._getStatusCode()).to.eql(403);
    });

    it('should clear the OTP session but keep the User and Collective rows after too many failed attempts', async () => {
      sandbox.stub(emailLib, 'send').resolves();
      const email = randEmail();

      const otpResponse = await makeSignupRequest(email, randIPV4());
      expect(otpResponse._getStatusCode()).to.eql(200);
      const responseData = otpResponse._getData();
      expect(responseData.sessionId).to.be.a('string');

      const otpSessionKey = `otp_signup_${email}`;
      let otpSession = await sessionCache.get(otpSessionKey);
      expect(otpSession).to.exist;
      const userId = otpSession.userId;

      let verifyResponse = await makeVerifyOtpRequest(email, '023456', responseData.sessionId, randIPV4());
      expect(verifyResponse._getStatusCode()).to.eql(403);
      verifyResponse = await makeVerifyOtpRequest(email, '023456', responseData.sessionId, randIPV4());
      expect(verifyResponse._getStatusCode()).to.eql(403);

      otpSession = await sessionCache.get(otpSessionKey);
      expect(otpSession).to.exist;
      expect(otpSession.tries).to.equal(2);

      for (let i = 0; i < OTP_RATE_LIMIT_MAX_ATTEMPTS - 2; i++) {
        verifyResponse = await makeVerifyOtpRequest(email, '023456', responseData.sessionId, randIPV4());
      }
      expect(verifyResponse._getStatusCode()).to.eql(403);

      // Three wrong codes invalidate the OTP session and do nothing else: a failed unauthenticated
      // proof must never authorize a persistent destructive change on an account the caller may not own.
      otpSession = await sessionCache.get(otpSessionKey);
      expect(otpSession).to.be.undefined;

      const user = await models.User.findByPk(userId, {
        include: [{ model: models.Collective, as: 'collective', paranoid: false }],
        paranoid: false,
      });
      expect(user.deletedAt).to.be.null;
      expect(user.collective.deletedAt).to.be.null;
      expect(user.email).to.equal(email.toLowerCase().trim());
      expect(user.confirmedAt).to.be.null;
    });

    it('should clear the session and reject when the user has already confirmed their email', async () => {
      sandbox.stub(emailLib, 'send').resolves();
      const email = randEmail();

      const otpResponse = await makeSignupRequest(email, randIPV4());
      expect(otpResponse._getStatusCode()).to.eql(200);
      const responseData = otpResponse._getData();
      const otp = (emailLib.send as sinon.SinonStub).getCall(0).args[2]['otp'];

      const otpSessionKey = `otp_signup_${email}`;
      const otpSession = await sessionCache.get(otpSessionKey);
      const userId = otpSession.userId;

      // The victim confirms out-of-band (e.g. through the magic link) while the session is still live
      await models.User.update({ confirmedAt: new Date() }, { where: { id: userId } });

      const verifyResponse = await makeVerifyOtpRequest(email, otp, responseData.sessionId, randIPV4());
      expect(verifyResponse._getStatusCode()).to.eql(403);
      // Even the correct OTP must not mint a session for an already-confirmed account
      expect(verifyResponse._getData()).to.not.have.property('token');

      const user = await models.User.findByPk(userId, { paranoid: false });
      expect(user.deletedAt).to.be.null;

      const remaining = await sessionCache.get(otpSessionKey);
      expect(remaining).to.be.undefined;
    });

    it('should still compare the OTP before rejecting an already-confirmed user (no timing oracle)', async () => {
      sandbox.stub(emailLib, 'send').resolves();
      const email = randEmail();

      const otpResponse = await makeSignupRequest(email, randIPV4());
      const responseData = otpResponse._getData();

      const otpSessionKey = `otp_signup_${email}`;
      const otpSession = await sessionCache.get(otpSessionKey);
      await models.User.update({ confirmedAt: new Date() }, { where: { id: otpSession.userId } });

      // Rejecting early, before this comparison, would make confirmed accounts measurably faster to
      // answer than unconfirmed ones and leak account state through latency.
      const bcryptCompare = sandbox.spy(bcrypt, 'compare');
      await makeVerifyOtpRequest(email, '023456', responseData.sessionId, randIPV4());
      expect(bcryptCompare.called).to.be.true;
    });

    it('should reject and clear a session that outlived OTP_SESSION_MAX_AGE', async () => {
      sandbox.stub(emailLib, 'send').resolves();
      const email = randEmail();

      const otpResponse = await makeSignupRequest(email, randIPV4());
      expect(otpResponse._getStatusCode()).to.eql(200);
      const responseData = otpResponse._getData();
      const otp = (emailLib.send as sinon.SinonStub).getCall(0).args[2]['otp'];

      const otpSessionKey = `otp_signup_${email}`;
      const otpSession = await sessionCache.get(otpSessionKey);
      const userId = otpSession.userId;

      // Simulate a session kept alive past its absolute lifetime (resend refreshes the idle TTL)
      await sessionCache.set(
        otpSessionKey,
        { ...otpSession, createdAt: Date.now() - (OTP_SESSION_MAX_AGE + 60) * 1000 },
        OTP_SESSION_MAX_AGE,
      );

      // Even the correct OTP must not verify past the absolute lifetime
      const verifyResponse = await makeVerifyOtpRequest(email, otp, responseData.sessionId, randIPV4());
      expect(verifyResponse._getStatusCode()).to.eql(403);
      expect(verifyResponse._getData()).to.not.have.property('token');

      const remaining = await sessionCache.get(otpSessionKey);
      expect(remaining).to.be.undefined;

      const user = await models.User.findByPk(userId, { paranoid: false });
      expect(user.deletedAt).to.be.null;
      expect(user.confirmedAt).to.be.null;
    });

    it('should fail closed on a session that predates the createdAt field', async () => {
      sandbox.stub(emailLib, 'send').resolves();
      const email = randEmail();

      const otpResponse = await makeSignupRequest(email, randIPV4());
      const responseData = otpResponse._getData();
      const otp = (emailLib.send as sinon.SinonStub).getCall(0).args[2]['otp'];

      const otpSessionKey = `otp_signup_${email}`;
      const otpSession = await sessionCache.get(otpSessionKey);
      await sessionCache.set(otpSessionKey, omit(otpSession, ['createdAt']), OTP_SESSION_MAX_AGE);

      const verifyResponse = await makeVerifyOtpRequest(email, otp, responseData.sessionId, randIPV4());
      expect(verifyResponse._getStatusCode()).to.eql(403);
      expect(verifyResponse._getData()).to.not.have.property('token');

      const remaining = await sessionCache.get(otpSessionKey);
      expect(remaining).to.be.undefined;
    });

    it('should not extend the session absolute lifetime when incrementing tries', async () => {
      sandbox.stub(emailLib, 'send').resolves();
      const email = randEmail();

      const otpResponse = await makeSignupRequest(email, randIPV4());
      const responseData = otpResponse._getData();

      const otpSessionKey = `otp_signup_${email}`;
      const otpSession = await sessionCache.get(otpSessionKey);

      // Park the session 2 minutes away from its absolute expiry
      const createdAt = Date.now() - (OTP_SESSION_MAX_AGE - 120) * 1000;
      await sessionCache.set(otpSessionKey, { ...otpSession, createdAt }, OTP_SESSION_MAX_AGE);

      const sessionCacheSet = sandbox.spy(sessionCache, 'set');
      await makeVerifyOtpRequest(email, '023456', responseData.sessionId, randIPV4());

      // A wrong guess must not hand the session a fresh TTL - that is a second keep-alive vector,
      // next to `resend-otp`, and must stay bounded by the absolute lifetime.
      const sessionWrite = sessionCacheSet.getCalls().find(call => call.args[0] === otpSessionKey);
      expect(sessionWrite, 'the session must be rewritten to count the try').to.exist;
      const ttlSeconds = sessionWrite.args[2] as number;
      expect(ttlSeconds).to.be.greaterThan(0);
      expect(ttlSeconds).to.be.at.most(120);

      const after = await sessionCache.get(otpSessionKey);
      expect(after.createdAt).to.equal(createdAt);
      expect(after.tries).to.equal(1);
    });

    it('should update guest flags when a guest user verifies their email', async () => {
      sandbox.stub(emailLib, 'send').resolves();

      // Create a guest user with pending verification
      const user = await fakeUser(
        { confirmedAt: null, data: { requiresVerification: true } },
        { data: { isGuest: true } },
      );
      const email = user.email;

      const otpResponse = await makeSignupRequest(email, randIPV4());
      expect(otpResponse._getStatusCode()).to.eql(200);
      const responseData = otpResponse._getData();
      expect(responseData.sessionId).to.be.a('string');

      const otpSessionKey = `otp_signup_${email}`;
      const otpSession = await sessionCache.get(otpSessionKey);
      expect(otpSession).to.exist;
      expect(otpSession.userId).to.equal(user.id);

      // Verify the guest flags before verification
      await user.reload({ include: [{ model: models.Collective, as: 'collective' }] });
      expect(user.collective.data.isGuest).to.be.true;

      const sendEmailCall = (emailLib.send as sinon.SinonStub).getCall(0);
      const otp = sendEmailCall.args[2].otp;
      const verifyResponse = await makeVerifyOtpRequest(email, otp, responseData.sessionId, randIPV4());
      expect(verifyResponse._getStatusCode()).to.eql(200);

      // Should update guest flags after verification
      await user.reload({ include: [{ model: models.Collective, as: 'collective' }] });
      expect(user.confirmedAt).to.be.instanceOf(Date);
      expect(user.data.requiresVerification).to.be.undefined;
      expect(user.collective.data.isGuest).to.be.false;
      expect(user.collective.data.wasGuest).to.be.true;
      expect(user.collective.data.requiresProfileCompletion).to.be.true;
      expect(user.collective.data.isSuspended).to.be.undefined;
    });
  });

  describe('OTP error contract', () => {
    // `INVALID_OTP` means "the code was wrong, the challenge is still live - retry".
    // `NOT_FOUND` means "this challenge is over - start again". The client routes on the difference.
    it('returns INVALID_OTP when the code is wrong but the session is still live', async () => {
      sandbox.stub(emailLib, 'send').resolves();
      const email = randEmail();
      const otpResponse = await makeSignupRequest(email, randIPV4());
      const sessionId = otpResponse._getData().sessionId;

      const verifyResponse = await makeVerifyOtpRequest(email, '023456', sessionId, randIPV4());
      expect(verifyResponse._getStatusCode()).to.eql(403);
      expect(verifyResponse._getData()).to.eql({
        error: { message: 'Invalid or expired OTP code', type: 'INVALID_OTP' },
      });
      // The caller is expected to retry against the same session
      expect(await sessionCache.get(`otp_signup_${email}`)).to.exist;
    });

    it('returns NOT_FOUND on the third wrong code, once the session has been invalidated', async () => {
      sandbox.stub(emailLib, 'send').resolves();
      const email = randEmail();
      const otpResponse = await makeSignupRequest(email, randIPV4());
      const sessionId = otpResponse._getData().sessionId;

      let verifyResponse;
      for (let i = 0; i < 3; i++) {
        verifyResponse = await makeVerifyOtpRequest(email, '023456', sessionId, randIPV4());
      }
      expect(verifyResponse._getStatusCode()).to.eql(403);
      expect(verifyResponse._getData()).to.eql({ error: { message: 'Not found', type: 'NOT_FOUND' } });
      expect(await sessionCache.get(`otp_signup_${email}`)).to.be.undefined;
    });

    it('returns NOT_FOUND when no OTP session exists for the email', async () => {
      sandbox.stub(emailLib, 'send').resolves();
      const email = randEmail();

      const verifyResponse = await makeVerifyOtpRequest(email, '023456', 'some-session-id', randIPV4());
      expect(verifyResponse._getStatusCode()).to.eql(403);
      expect(verifyResponse._getData()).to.eql({ error: { message: 'Not found', type: 'NOT_FOUND' } });
    });

    it('returns NOT_FOUND when the caller presents a foreign session id', async () => {
      sandbox.stub(emailLib, 'send').resolves();
      const email = randEmail();
      await makeSignupRequest(email, randIPV4());

      const verifyResponse = await makeVerifyOtpRequest(email, '023456', 'not-my-session', randIPV4());
      expect(verifyResponse._getData()).to.eql({ error: { message: 'Not found', type: 'NOT_FOUND' } });
    });

    it('returns NOT_FOUND from resend-otp when the session is gone', async () => {
      sandbox.stub(emailLib, 'send').resolves();
      const email = randEmail();
      const otpResponse = await makeSignupRequest(email, randIPV4());
      const sessionId = otpResponse._getData().sessionId;
      await sessionCache.delete(`otp_signup_${email}`);

      const resendResponse = await makeResendOtpRequest(email, sessionId, randIPV4());
      expect(resendResponse._getStatusCode()).to.eql(401);
      expect(resendResponse._getData()).to.eql({ error: { message: 'Not found', type: 'NOT_FOUND' } });
    });

    it('returns NOT_FOUND from resend-otp for a session past its absolute lifetime', async () => {
      sandbox.stub(emailLib, 'send').resolves();
      const email = randEmail();
      const otpResponse = await makeSignupRequest(email, randIPV4());
      const sessionId = otpResponse._getData().sessionId;

      const otpSessionKey = `otp_signup_${email}`;
      const otpSession = await sessionCache.get(otpSessionKey);
      await sessionCache.set(
        otpSessionKey,
        { ...otpSession, createdAt: Date.now() - (OTP_SESSION_MAX_AGE + 60) * 1000 },
        OTP_SESSION_MAX_AGE,
      );

      const resendResponse = await makeResendOtpRequest(email, sessionId, randIPV4());
      expect(resendResponse._getData()).to.eql({ error: { message: 'Not found', type: 'NOT_FOUND' } });
    });
  });

  describe('OTP debug logging', () => {
    it('should never log the OTP outside local development, even with E2E_TEST set', async () => {
      sandbox.stub(emailLib, 'send').resolves();
      sandbox.stub(config, 'env').value('staging');
      const previousE2e = process.env.E2E_TEST;
      // The resend path used to key off this, which is not env-scoped
      process.env.E2E_TEST = 'true';
      const loggerInfo = sandbox.spy(logger, 'info');

      try {
        const email = randEmail();
        const signupResponse = await makeSignupRequest(email, randIPV4());
        expect(signupResponse._getStatusCode()).to.eql(200);
        const firstOtp = (emailLib.send as sinon.SinonStub).getCall(0).args[2]['otp'];

        const resendResponse = await makeResendOtpRequest(email, signupResponse._getData().sessionId, randIPV4());
        expect(resendResponse._getStatusCode()).to.eql(200);
        const secondOtp = (emailLib.send as sinon.SinonStub).getCall(1).args[2]['otp'];

        const logged = loggerInfo
          .getCalls()
          .map(call => call.args.map(String).join(' '))
          .join('\n');
        expect(logged).to.not.contain(firstOtp);
        expect(logged).to.not.contain(secondOtp);
      } finally {
        if (previousE2e === undefined) {
          delete process.env.E2E_TEST;
        } else {
          process.env.E2E_TEST = previousE2e;
        }
      }
    });

    it('should mask the recipient address in the OTP debug log', async () => {
      sandbox.stub(emailLib, 'send').resolves();
      sandbox.stub(config, 'env').value('development');
      const loggerInfo = sandbox.spy(logger, 'info');

      const email = randEmail();
      await makeSignupRequest(email, randIPV4());
      const otp = (emailLib.send as sinon.SinonStub).getCall(0).args[2]['otp'];

      const logged = loggerInfo
        .getCalls()
        .map(call => call.args.map(String).join(' '))
        .join('\n');
      // The debug aid still works locally, but the log never carries a full email address
      expect(logged).to.contain(otp);
      expect(logged).to.not.contain(email);
      expect(logged).to.contain('@');
    });
  });
});
