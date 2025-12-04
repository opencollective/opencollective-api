import { expect } from 'chai';
import httpMocks from 'node-mocks-http';
import sinon from 'sinon';

import ActivityTypes from '../../../server/constants/activities';
import { resendEmailVerificationOTP, signin, signup, verifyEmail } from '../../../server/controllers/users';
import { generateLoaders } from '../../../server/graphql/loaders';
import { OTP_RATE_LIMIT_MAX_ATTEMPTS } from '../../../server/lib/auth';
import { sessionCache } from '../../../server/lib/cache';
import emailLib from '../../../server/lib/email';
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

      expect(emailLib.send).to.have.been.calledOnce;
      expect(emailLib.send).to.have.been.calledWithMatch(ActivityTypes.USER_OTP_REQUESTED, user.email);
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

      expect(emailLib.send).to.have.been.calledOnce;
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

      expect(emailLib.send).to.have.been.calledOnce;
      expect(emailLib.send).to.have.been.calledWithMatch(ActivityTypes.USER_OTP_REQUESTED, user.email);

      const resendResponse = await makeResendOtpRequest(randEmail(), responseData.sessionId, randIPV4());
      expect(resendResponse._getStatusCode()).to.eql(401);
      expect(emailLib.send).to.have.been.calledOnce;
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

      expect(emailLib.send).to.have.been.calledOnce;
      expect(emailLib.send).to.have.been.calledWithMatch(ActivityTypes.USER_OTP_REQUESTED, user.email);
      const firstOtp = (emailLib.send as sinon.SinonStub).getCall(0).args[2]['otp'];

      const resendResponse = await makeResendOtpRequest(email, responseData.sessionId, randIPV4());
      expect(resendResponse._getStatusCode()).to.eql(200);
      expect(emailLib.send).to.have.been.calledTwice;
      const secondOtp = (emailLib.send as sinon.SinonStub).getCall(1).args[2]['otp'];
      expect(secondOtp).to.not.equal(firstOtp);

      otpSession = await sessionCache.get(otpSessionKey);
      expect(otpSession).to.exist;
      expect(otpSession.secret).to.be.a('string');
      expect(otpSession.secret).to.not.equal(firstSecret);
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

    it('should clear the OTP session and User record after too many failed attempts', async () => {
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
      otpSession = await sessionCache.get(otpSessionKey);
      expect(otpSession).to.be.undefined;
      const user = await models.User.findByPk(userId, {
        include: [{ model: models.Collective, as: 'collective', paranoid: false }],
        paranoid: false,
      });
      expect(user.deletedAt).not.to.be.null;
      expect(user.collective.deletedAt).not.to.be.null;
    });
  });
});
