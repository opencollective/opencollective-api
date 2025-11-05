import { expect } from 'chai';
import httpMocks from 'node-mocks-http';
import sinon from 'sinon';

import ActivityTypes from '../../../server/constants/activities';
import { signup, verifyEmail } from '../../../server/controllers/users';
import { generateLoaders } from '../../../server/graphql/loaders';
import { sessionCache } from '../../../server/lib/cache';
import emailLib from '../../../server/lib/email';
import models from '../../../server/models';
import { fakeUser, randEmail, randIp } from '../../test-helpers/fake-data';

describe('server/controllers/users', () => {
  let sandbox;

  before(async () => {
    sandbox = sinon.createSandbox();
  });

  afterEach(() => {
    sandbox.restore();
    sessionCache.clear();
  });

  const makeOtpRequest = async (email: string, ip: string, password?: string) => {
    const request = httpMocks.createRequest({
      method: 'POST',
      url: `/users/signup`,
      body: {
        email,
        password,
      },
      ip,
    });
    request.loaders = generateLoaders({});
    const response = httpMocks.createResponse();

    await signup(request, response, undefined);
    return response;
  };

  const makeVerifyOtpRequest = async (email: string, otp: string, ip: string) => {
    const request = httpMocks.createRequest({
      method: 'POST',
      url: `/users/verify-email`,
      body: {
        email,
        otp,
      },
      ip,
    });
    request.loaders = generateLoaders({});
    const response = httpMocks.createResponse();

    await verifyEmail(request, response, undefined);
    return response;
  };

  describe('signup', () => {
    it('should create a new user, create a session information about the OTP and send OTP through email', async () => {
      sandbox.stub(emailLib, 'send').resolves();
      const email = randEmail();

      const response = await makeOtpRequest(email, randIp());
      expect(response._getStatusCode()).to.eql(200);

      const otpSessionKey = `otp_signup_${email}`;
      const otpSession = await sessionCache.get(otpSessionKey);
      expect(otpSession).to.exist;
      expect(otpSession.secret).to.be.a('string');
      expect(otpSession.userId).to.be.a('number');
      expect(otpSession.tries).to.equal(0);

      const user = await models.User.findByPk(otpSession.userId);
      expect(user.confirmedAt).to.be.null;

      expect(emailLib.send).to.have.been.calledOnce;
      expect(emailLib.send).to.have.been.calledWithMatch(ActivityTypes.USER_OTP_REQUESTED, user.email);
    });

    it('should create a new user with password', async () => {
      sandbox.stub(emailLib, 'send').resolves();
      const email = randEmail();
      const password = 'password123';

      const response = await makeOtpRequest(email, randIp(), password);
      expect(response._getStatusCode()).to.eql(200);

      const otpSessionKey = `otp_signup_${email}`;
      const otpSession = await sessionCache.get(otpSessionKey);
      expect(otpSession).to.exist;
      expect(otpSession.secret).to.be.a('string');
      expect(otpSession.userId).to.be.a('number');
      expect(otpSession.tries).to.equal(0);

      const user = await models.User.findByPk(otpSession.userId);
      expect(user.confirmedAt).to.be.null;
      expect(user.passwordHash).to.be.a('string');
    });

    it('should reuse an existing unconfirmed user as an alternative to the magic-link ', async () => {
      sandbox.stub(emailLib, 'send').resolves();
      const user = await fakeUser({ confirmedAt: null });
      const response = await makeOtpRequest(user.email, randIp());
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

      const response = await makeOtpRequest(user.email, randIp());
      expect(response._getStatusCode()).to.eql(403);
      expect(response._getData()).to.eql({ error: { message: 'User already exists' } });
    });

    it('should fail if an ongoing OTP request exists', async () => {
      const email = randEmail();

      await makeOtpRequest(email, randIp());
      const response = await makeOtpRequest(email, randIp());
      expect(response._getStatusCode()).to.eql(401);
      expect(response._getData()).to.eql({ error: { message: 'OTP request already exists' } });
    });

    it('should be rate-limited on the request IP', async () => {
      const ip = randIp();

      await makeOtpRequest(randEmail(), ip);
      await makeOtpRequest(randEmail(), ip);
      await makeOtpRequest(randEmail(), ip);
      const response = await makeOtpRequest(randEmail(), ip);
      expect(response._getStatusCode()).to.eql(403);
    });

    it('should be rate-limited on the email', async () => {
      const email = randEmail();

      await makeOtpRequest(email, randIp());
      await makeOtpRequest(email, randIp());
      await makeOtpRequest(email, randIp());
      const response = await makeOtpRequest(email, randIp());
      expect(response._getStatusCode()).to.eql(403);
    });
  });

  describe('verifyEmail', () => {
    it('should verify OTP and confirm user email', async () => {
      sandbox.stub(emailLib, 'send').resolves();
      const email = randEmail();

      const otpResponse = await makeOtpRequest(email, randIp());
      expect(otpResponse._getStatusCode()).to.eql(200);

      const otpSessionKey = `otp_signup_${email}`;
      let otpSession = await sessionCache.get(otpSessionKey);
      expect(otpSession).to.exist;
      const user = await models.User.findByPk(otpSession.userId);

      const sendEmailCall = (emailLib.send as sinon.SinonStub).getCall(0);
      const otp = sendEmailCall.args[2].otp;
      const verifyResponse = await makeVerifyOtpRequest(email, otp, randIp());
      expect(verifyResponse._getStatusCode()).to.eql(200);

      // Should add confirmedAt to user
      await user.reload();
      expect(user.confirmedAt).to.be.instanceOf(Date);

      // Should clear OTP session
      otpSession = await sessionCache.get(otpSessionKey);
      expect(otpSession).to.be.undefined;
    });

    it('should fail with an invalid OTP', async () => {
      sandbox.stub(emailLib, 'send').resolves();
      const email = randEmail();

      const otpResponse = await makeOtpRequest(email, randIp());
      expect(otpResponse._getStatusCode()).to.eql(200);

      const otpSessionKey = `otp_signup_${email}`;
      let otpSession = await sessionCache.get(otpSessionKey);
      expect(otpSession).to.exist;

      const verifyResponse = await makeVerifyOtpRequest(email, '023456', randIp());
      expect(verifyResponse._getStatusCode()).to.eql(403);

      otpSession = await sessionCache.get(otpSessionKey);
      expect(otpSession).to.exist;
      expect(otpSession.tries).to.equal(1);
    });

    it('should fail with an expired OTP', async () => {
      sandbox.stub(emailLib, 'send').resolves();
      const email = randEmail();

      const otpResponse = await makeOtpRequest(email, randIp());
      expect(otpResponse._getStatusCode()).to.eql(200);

      const otpSessionKey = `otp_signup_${email}`;
      const otpSession = await sessionCache.get(otpSessionKey);
      expect(otpSession).to.exist;

      // Simulate expiry
      await sessionCache.delete(otpSessionKey);

      const sendEmailCall = (emailLib.send as sinon.SinonStub).getCall(0);
      const otp = sendEmailCall.args[2].otp;
      const verifyResponse = await makeVerifyOtpRequest(email, otp, randIp());
      expect(verifyResponse._getStatusCode()).to.eql(403);
    });

    it('should clear the OTP session and User record after too many failed attempts', async () => {
      sandbox.stub(emailLib, 'send').resolves();
      const email = randEmail();

      const otpResponse = await makeOtpRequest(email, randIp());
      expect(otpResponse._getStatusCode()).to.eql(200);

      const otpSessionKey = `otp_signup_${email}`;
      let otpSession = await sessionCache.get(otpSessionKey);
      expect(otpSession).to.exist;

      let verifyResponse = await makeVerifyOtpRequest(email, '023456', randIp());
      expect(verifyResponse._getStatusCode()).to.eql(403);
      verifyResponse = await makeVerifyOtpRequest(email, '023456', randIp());
      expect(verifyResponse._getStatusCode()).to.eql(403);

      otpSession = await sessionCache.get(otpSessionKey);
      expect(otpSession).to.exist;
      expect(otpSession.tries).to.equal(2);

      verifyResponse = await makeVerifyOtpRequest(email, '023456', randIp());
      expect(verifyResponse._getStatusCode()).to.eql(403);
      otpSession = await sessionCache.get(otpSessionKey);
      expect(otpSession).to.be.undefined;
      const user = await models.User.findOne({ where: { email } });
      expect(user).to.be.null;
    });
  });
});
