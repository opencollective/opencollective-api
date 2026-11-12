import bcrypt from 'bcrypt';
import { expect } from 'chai';
import config from 'config';
import gql from 'fake-tag';
import jwt from 'jsonwebtoken';
import { generateSecret } from 'otplib';
import { createSandbox } from 'sinon';
import request from 'supertest';

import OAuthScopes from '../../../../../server/constants/oauth-scopes';
import roles from '../../../../../server/constants/roles';
import { idDecode, idEncode, IDENTIFIER_TYPES } from '../../../../../server/graphql/v2/identifiers';
import emailLib from '../../../../../server/lib/email';
import { crypto } from '../../../../../server/lib/encryption';
import models from '../../../../../server/models';
import {
  fakeApplication,
  fakePersonalToken,
  fakeUser,
  fakeUserToken,
  randEmail,
  randStr,
} from '../../../../test-helpers/fake-data';
import { startTestServer, stopTestServer } from '../../../../test-helpers/server';
import { graphqlQueryV2 } from '../../../../utils';

describe('server/graphql/v2/mutation/IndividualMutations', () => {
  describe('setPassword', () => {
    let sandbox, expressApp;

    before(async () => {
      sandbox = createSandbox();
      expressApp = await startTestServer();
    });

    beforeEach(() => {
      sandbox.stub(config, 'limits').value({ setPasswordPerUserPerHour: 1000000 }); // Set a permissive rate limit by default
    });

    after(async () => {
      sandbox.restore();
      await stopTestServer();
    });

    const setPasswordMutation = gql`
      mutation SetPassword($password: String!, $currentPassword: String) {
        setPassword(password: $password, currentPassword: $currentPassword) {
          token
          individual {
            id
            slug
          }
        }
      }
    `;

    it('should throw if not authenticated', async () => {
      const result = await graphqlQueryV2(setPasswordMutation, { password: 'newpassword' });
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('You need to be logged in to manage account.');
    });

    it('rejects login tokens before setting a password or issuing a session', async () => {
      const user = await fakeUser({ passwordHash: null });
      const result = await graphqlQueryV2(setPasswordMutation, { password: 'newpassword' }, user, { scope: 'login' });

      expect(result.errors).to.exist;
      expect(result.errors[0].extensions.code).to.equal('Forbidden');
      expect(result.errors[0].message).to.equal('A session or reset-password token is required to set passwords.');
      await user.reload();
      expect(user.passwordHash).to.be.null;
    });

    it('should set password directly if there is none yet', async () => {
      const user = await fakeUser({ passwordHash: null });
      const newPassword = 'newpassword';
      const result = await graphqlQueryV2(setPasswordMutation, { password: newPassword }, user);
      expect(result.errors).to.not.exist;
      expect(result.data.setPassword.token).to.exist;
      expect(result.data.setPassword.individual.slug).to.equal(user.collective.slug);

      // Check that the password was set
      await user.reload();
      expect(user.passwordHash).to.not.be.empty;
      expect(user.passwordUpdatedAt).to.exist;
      expect(await bcrypt.compare(newPassword, user.passwordHash)).to.be.true;
    });

    it('enforces a minimal length on the password', async () => {
      const user = await fakeUser({ passwordHash: null });

      let result = await graphqlQueryV2(setPasswordMutation, { password: '' }, user);
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('Password must be at least 6 characters long.');

      result = await graphqlQueryV2(setPasswordMutation, { password: 'aaa' }, user);
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('Password must be at least 6 characters long.');
    });

    it('should enforce 2FA if enabled on the account', async () => {
      const secret = generateSecret({ length: 64 });
      const encryptedToken = crypto.encrypt(secret);
      const user = await fakeUser({ twoFactorAuthToken: encryptedToken, passwordHash: null });
      const result = await graphqlQueryV2(setPasswordMutation, { password: 'newPassword' }, user);
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('Two-factor authentication required');
    });

    it('should throw an error if rate limit is exceeded', async () => {
      sandbox.stub(config, 'limits').value({ setPasswordPerUserPerHour: 0 });
      const user = await fakeUser({ passwordHash: null });
      const result = await graphqlQueryV2(setPasswordMutation, { password: 'xxxxxxxx' }, user);
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('Rate limit exceeded');
    });

    describe('when a password is already set', () => {
      it('should set password if the current password provided is correct', async () => {
        const user = await fakeUser({ passwordHash: null });
        const params = { password: 'newpassword', currentPassword: 'oldpassword' };
        await user.setPassword(params.currentPassword);
        const result = await graphqlQueryV2(setPasswordMutation, params, user);
        result.errors && console.error(result.errors);
        expect(result.errors).to.not.exist;
        expect(result.data.setPassword.token).to.exist;
        expect(result.data.setPassword.individual.slug).to.equal(user.collective.slug);

        // Check that the password was set
        await user.reload();
        expect(user.passwordHash).to.not.be.empty;
        expect(user.passwordUpdatedAt).to.exist;
        expect(await bcrypt.compare(params.currentPassword, user.passwordHash)).to.be.false;
        expect(await bcrypt.compare(params.password, user.passwordHash)).to.be.true;
      });

      it('should throw an error if the current password is not provided', async () => {
        const user = await fakeUser({ passwordHash: null });
        await user.setPassword('oldpassword');
        const result = await graphqlQueryV2(setPasswordMutation, { password: 'newpassword' }, user);
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.equal('Submit current password to change password.');
      });

      it('should throw an error if the provided current password is incorrect', async () => {
        const user = await fakeUser({ passwordHash: null });
        await user.setPassword('oldpassword');
        const result = await graphqlQueryV2(
          setPasswordMutation,
          { password: 'newpassword', currentPassword: 'wrongpassword' },
          user,
        );
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.equal('Invalid current password while attempting to change password.');
      });
    });

    describe('using a reset token', () => {
      // Using a different mutation since `reset-token` tokens are strictly limited.
      // Do not change the fields or attributes without looking at `server/middleware/authentication.js` > `checkJwtScope`.
      const resetPasswordMutation = gql`
        mutation ResetPassword($password: String!) {
          setPassword(password: $password) {
            individual {
              id
              __typename
            }
            token
            __typename
          }
        }
      `;

      it('should reset the password without having to provide the current password', async () => {
        const user = await fakeUser({ passwordHash: null });
        await user.setPassword('oldpassword');
        const resetUrl = await user.generateResetPasswordLink();
        const token = resetUrl.split('/').pop();

        // Unfortunately, the `graphqlQueryV2` helper bypasses some of the logic around tokens. To be as close as possible
        // to the real behavior, we send a real HTTP request to the server.
        const res = await request(expressApp)
          .post('/graphql')
          .send({ query: resetPasswordMutation, variables: { password: 'newpassword' } })
          .set('Authorization', `Bearer ${token}`)
          .expect(200);

        const result = res.body.data.setPassword;
        expect(result.token).to.exist;
        expect(result.individual.id).to.equal(idEncode(user.CollectiveId, 'account'));

        // Check that the password was set
        await user.reload();
        expect(user.passwordHash).to.not.be.empty;
        expect(user.passwordUpdatedAt).to.exist;
        expect(await bcrypt.compare('oldpassword', user.passwordHash)).to.be.false;
        expect(await bcrypt.compare('newpassword', user.passwordHash)).to.be.true;
      });

      it('should throw an error if the email does not match', async () => {
        const user = await fakeUser({ passwordHash: null });
        await user.setPassword('oldpassword');
        const resetUrl = await user.generateResetPasswordLink();
        const token = resetUrl.split('/').pop();

        // Change email
        await user.update({ email: randEmail() });

        // Unfortunately, the `graphqlQueryV2` helper bypasses some of the logic around tokens. To be as close as possible
        // to the real behavior, we send a real HTTP request to the server.
        const res = await request(expressApp)
          .post('/graphql')
          .send({ query: resetPasswordMutation, variables: { password: 'newpassword' } })
          .set('Authorization', `Bearer ${token}`)
          .expect(401);

        expect(res.body.error.code).to.equal(401);
        expect(res.body.error.message).to.equal('This token has expired');
      });
    });

    describe('using OAuth or Personal Tokens', () => {
      it('is not allowed with an OAuth token, even with the account scope', async () => {
        const application = await fakeApplication({ type: 'oAuth' });
        const user = await fakeUser({ passwordHash: null });
        const userToken = await fakeUserToken({
          type: 'OAUTH',
          ApplicationId: application.id,
          UserId: user.id,
          scope: [OAuthScopes.account],
        });

        const result = await graphqlQueryV2(
          setPasswordMutation,
          { password: 'newpassword' },
          user,
          null,
          null,
          userToken,
        );

        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.equal('OAuth and Personal Tokens are not allowed to set passwords.');

        await user.reload();
        expect(user.passwordHash).to.be.null;
      });

      it('is not allowed with a personal token, even with the account scope', async () => {
        const user = await fakeUser({ passwordHash: null });
        const personalToken = await fakePersonalToken({ user, scope: [OAuthScopes.account] });

        const result = await graphqlQueryV2(
          setPasswordMutation,
          { password: 'newpassword' },
          user,
          null,
          null,
          null,
          personalToken,
        );

        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.equal('OAuth and Personal Tokens are not allowed to set passwords.');

        await user.reload();
        expect(user.passwordHash).to.be.null;
      });
    });
  });

  describe('confirmEmail', () => {
    const confirmEmailMutation = gql`
      mutation ConfirmEmail($token: NonEmptyString!) {
        confirmEmail(token: $token) {
          sessionToken
          individual {
            id
            slug
          }
        }
      }
    `;

    it('should error if the token is invalid', async () => {
      const result = await graphqlQueryV2(confirmEmailMutation, { token: 'invalidtoken' });
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('Invalid email confirmation token');
    });

    it('cannot be used with a OAuth or personal token', async () => {
      const user = await fakeUser({ emailWaitingForValidation: randEmail(), emailConfirmationToken: randStr() });

      const userToken = await fakeUserToken({ type: 'OAUTH', UserId: user.id });
      const resultOauth = await graphqlQueryV2(
        confirmEmailMutation,
        { token: user.emailConfirmationToken },
        user,
        null,
        null,
        userToken,
      );
      expect(resultOauth.errors).to.exist;
      expect(resultOauth.errors[0].message).to.equal('A session token is required to confirm email while signed in.');

      const personalToken = await fakePersonalToken({ UserId: user.id });
      const resultPersonalToken = await graphqlQueryV2(
        confirmEmailMutation,
        { token: user.emailConfirmationToken },
        user,
        null,
        null,
        null,
        personalToken,
      );
      expect(resultPersonalToken.errors).to.exist;
      expect(resultPersonalToken.errors[0].message).to.equal(
        'A session token is required to confirm email while signed in.',
      );
    });

    for (const scope of ['login', 'reset-password']) {
      it(`cannot exchange a ${scope} token for a session by confirming email`, async () => {
        const user = await fakeUser({ emailWaitingForValidation: randEmail(), emailConfirmationToken: randStr() });
        const result = await graphqlQueryV2(confirmEmailMutation, { token: user.emailConfirmationToken }, user, {
          scope,
        });

        expect(result.errors).to.exist;
        expect(result.errors[0].extensions.code).to.equal('Forbidden');
        expect(result.errors[0].message).to.equal('A session token is required to confirm email while signed in.');
        await user.reload();
        expect(user.emailWaitingForValidation).to.exist;
      });
    }

    it('should confirm the new email', async () => {
      const newEmail = randEmail();
      const user = await fakeUser({ emailWaitingForValidation: newEmail, emailConfirmationToken: randStr() });
      const result = await graphqlQueryV2(confirmEmailMutation, { token: user.emailConfirmationToken }); // Unauthenticated
      expect(result.errors).to.not.exist;
      expect(result.data.confirmEmail.sessionToken).to.not.exist; // Do not log in if not authenticated already
      expect(result.data.confirmEmail.individual.slug).to.equal(user.collective.slug);

      await user.reload();
      expect(user.email).to.equal(newEmail);
      expect(user.emailWaitingForValidation).to.be.null;
      expect(user.emailConfirmationToken).to.be.null;
    });

    it('should confirm the new email and return a session token if logged in', async () => {
      const newEmail = randEmail();
      const user = await fakeUser({ emailWaitingForValidation: newEmail, emailConfirmationToken: randStr() });
      const result = await graphqlQueryV2(confirmEmailMutation, { token: user.emailConfirmationToken }, user); // Authenticated
      expect(result.errors).to.not.exist;
      expect(result.data.confirmEmail.sessionToken).to.exist;
      expect(result.data.confirmEmail.individual.slug).to.equal(user.collective.slug);

      await user.reload();
      expect(user.email).to.equal(newEmail);
      expect(user.emailWaitingForValidation).to.be.null;
      expect(user.emailConfirmationToken).to.be.null;

      const decodedToken = jwt.decode(result.data.confirmEmail.sessionToken, { complete: true });
      expect(decodedToken).to.containSubset({
        header: { alg: 'HS256', typ: 'JWT', kid: 'HS256-2019-09-02' },
        payload: {
          scope: 'session',
          email: newEmail,
          sub: user.id.toString(),
        },
      });
    });
  });

  describe('requestEmailChange', () => {
    let sandbox, sendEmailStub;

    before(() => {
      sandbox = createSandbox();
    });

    beforeEach(() => {
      sendEmailStub = sandbox.stub(emailLib, 'send').resolves();
    });

    afterEach(() => {
      sandbox.restore();
    });

    const requestEmailChangeMutation = gql`
      mutation RequestEmailChange($email: EmailAddress!) {
        requestEmailChange(email: $email) {
          id
          slug
          email
          emailWaitingForValidation
        }
      }
    `;

    const confirmEmailMutation = gql`
      mutation ConfirmEmail($token: NonEmptyString!) {
        confirmEmail(token: $token) {
          individual {
            id
          }
        }
      }
    `;

    it('should throw if not authenticated', async () => {
      const result = await graphqlQueryV2(requestEmailChangeMutation, { email: randEmail() });
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('You need to be logged in to manage account.');
    });

    it('stores the new email as pending, sends the confirmation and lets confirmEmail apply it', async () => {
      const user = await fakeUser({ confirmedAt: new Date() });
      const previousEmail = user.email;
      const newEmail = randEmail();

      const result = await graphqlQueryV2(requestEmailChangeMutation, { email: newEmail.toUpperCase() }, user);
      expect(result.errors).to.not.exist;
      expect(result.data.requestEmailChange.slug).to.equal(user.collective.slug);
      expect(result.data.requestEmailChange.email).to.equal(previousEmail);
      expect(result.data.requestEmailChange.emailWaitingForValidation).to.equal(newEmail);

      await user.reload();
      expect(user.email).to.equal(previousEmail);
      expect(user.emailWaitingForValidation).to.equal(newEmail);
      expect(user.emailConfirmationToken).to.exist;

      expect(sendEmailStub.calledOnce).to.be.true;
      expect(sendEmailStub.firstCall.args[0]).to.equal('user.changeEmail');
      expect(sendEmailStub.firstCall.args[1]).to.equal(newEmail);
      expect(sendEmailStub.firstCall.args[2].user.emailConfirmationToken).to.equal(user.emailConfirmationToken);

      const activity = await models.Activity.findOne({ where: { UserId: user.id, type: 'user.changeEmail' } });
      expect(activity).to.exist;

      const confirmResult = await graphqlQueryV2(confirmEmailMutation, { token: user.emailConfirmationToken });
      expect(confirmResult.errors).to.not.exist;
      await user.reload();
      expect(user.email).to.equal(newEmail);
      expect(user.emailWaitingForValidation).to.be.null;
    });

    it('re-sends the confirmation with the same token when the same email is requested again', async () => {
      const user = await fakeUser({ confirmedAt: new Date() });
      const newEmail = randEmail();

      await graphqlQueryV2(requestEmailChangeMutation, { email: newEmail }, user);
      await user.reload();
      const token = user.emailConfirmationToken;

      const result = await graphqlQueryV2(requestEmailChangeMutation, { email: newEmail }, user);
      expect(result.errors).to.not.exist;
      await user.reload();
      expect(user.emailConfirmationToken).to.equal(token);
      expect(sendEmailStub.calledTwice).to.be.true;
    });

    it('cancels the pending change when the current email is sent', async () => {
      const user = await fakeUser({
        confirmedAt: new Date(),
        emailWaitingForValidation: randEmail(),
        emailConfirmationToken: randStr(),
      });

      const result = await graphqlQueryV2(requestEmailChangeMutation, { email: user.email }, user);
      expect(result.errors).to.not.exist;
      expect(result.data.requestEmailChange.emailWaitingForValidation).to.be.null;
      await user.reload();
      expect(user.emailWaitingForValidation).to.be.null;
      expect(user.emailConfirmationToken).to.be.null;
      expect(sendEmailStub.called).to.be.false;
    });

    it('rejects an email already used by another user, whatever its case', async () => {
      const user = await fakeUser({ confirmedAt: new Date() });
      const otherUser = await fakeUser();

      const result = await graphqlQueryV2(requestEmailChangeMutation, { email: otherUser.email.toUpperCase() }, user);
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('A user with that email already exists');
      await user.reload();
      expect(user.emailWaitingForValidation).to.be.null;
      expect(sendEmailStub.called).to.be.false;
    });

    it('rejects an email waiting for validation on another account', async () => {
      const user = await fakeUser({ confirmedAt: new Date() });
      const pendingEmail = randEmail();
      await fakeUser({ emailWaitingForValidation: pendingEmail, emailConfirmationToken: randStr() });

      const result = await graphqlQueryV2(requestEmailChangeMutation, { email: pendingEmail }, user);
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('A user with that email already exists');
      await user.reload();
      expect(user.emailWaitingForValidation).to.be.null;
      expect(sendEmailStub.called).to.be.false;
    });

    it('counts rejected attempts toward the rate limit', async () => {
      sandbox.stub(config, 'limits').value({ ...config.limits, changeEmailPerHour: { update: 1 } });
      const user = await fakeUser({ confirmedAt: new Date() });
      const otherUser = await fakeUser();

      const first = await graphqlQueryV2(requestEmailChangeMutation, { email: otherUser.email }, user);
      expect(first.errors[0].message).to.equal('A user with that email already exists');

      const second = await graphqlQueryV2(requestEmailChangeMutation, { email: randEmail() }, user);
      expect(second.errors[0].message).to.equal('Rate limit exceeded');
    });

    it('applies the rate limit to concurrent requests', async () => {
      sandbox.stub(config, 'limits').value({ ...config.limits, changeEmailPerHour: { update: 1 } });
      const user = await fakeUser({ confirmedAt: new Date() });

      const results = await Promise.all(
        [randEmail(), randEmail(), randEmail()].map(email =>
          graphqlQueryV2(requestEmailChangeMutation, { email }, user),
        ),
      );
      expect(results.filter(r => !r.errors)).to.have.length(1);
      expect(results.filter(r => r.errors?.[0].message === 'Rate limit exceeded')).to.have.length(2);
    });

    it('gives the attempt back when the verification email fails to send', async () => {
      sandbox.stub(config, 'limits').value({ ...config.limits, changeEmailPerHour: { update: 1 } });
      sendEmailStub.onFirstCall().rejects(new Error('SMTP down'));
      const user = await fakeUser({ confirmedAt: new Date() });

      const first = await graphqlQueryV2(requestEmailChangeMutation, { email: randEmail() }, user);
      expect(first.errors[0].message).to.equal('Error while sending the verification email, please try again later');

      const second = await graphqlQueryV2(requestEmailChangeMutation, { email: randEmail() }, user);
      expect(second.errors).to.not.exist;
    });

    it('rejects an invalid email address', async () => {
      const user = await fakeUser({ confirmedAt: new Date() });
      const result = await graphqlQueryV2(requestEmailChangeMutation, { email: 'not-an-email' }, user);
      expect(result.errors).to.exist;
      expect(sendEmailStub.called).to.be.false;
    });

    it('requires a confirmed account', async () => {
      const user = await fakeUser({ confirmedAt: null });
      const result = await graphqlQueryV2(requestEmailChangeMutation, { email: randEmail() }, user);
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('You need to verify your account before changing your email address');
    });

    it('should enforce 2FA if enabled on the account', async () => {
      const secret = generateSecret({ length: 64 });
      const user = await fakeUser({ confirmedAt: new Date(), twoFactorAuthToken: crypto.encrypt(secret) });
      const result = await graphqlQueryV2(requestEmailChangeMutation, { email: randEmail() }, user);
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('Two-factor authentication required');
      await user.reload();
      expect(user.emailWaitingForValidation).to.be.null;
      expect(sendEmailStub.called).to.be.false;
    });

    it('should throw an error if rate limit is exceeded', async () => {
      sandbox.stub(config, 'limits').value({ ...config.limits, changeEmailPerHour: { update: 0 } });
      const user = await fakeUser({ confirmedAt: new Date() });
      const result = await graphqlQueryV2(requestEmailChangeMutation, { email: randEmail() }, user);
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('Rate limit exceeded');
    });

    it('rejects login tokens', async () => {
      const user = await fakeUser({ confirmedAt: new Date() });
      const result = await graphqlQueryV2(requestEmailChangeMutation, { email: randEmail() }, user, {
        scope: 'login',
      });
      expect(result.errors).to.exist;
      expect(result.errors[0].extensions.code).to.equal('Forbidden');
      await user.reload();
      expect(user.emailWaitingForValidation).to.be.null;
    });

    it('is not allowed with an OAuth token, even with the account scope', async () => {
      const application = await fakeApplication({ type: 'oAuth' });
      const user = await fakeUser({ confirmedAt: new Date() });
      const userToken = await fakeUserToken({
        type: 'OAUTH',
        ApplicationId: application.id,
        UserId: user.id,
        scope: [OAuthScopes.account, OAuthScopes.email],
      });

      const result = await graphqlQueryV2(
        requestEmailChangeMutation,
        { email: randEmail() },
        user,
        null,
        null,
        userToken,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal(
        'OAuth and Personal Tokens are not allowed to change the email address.',
      );
      await user.reload();
      expect(user.emailWaitingForValidation).to.be.null;
    });

    it('is not allowed with a personal token, even with the account scope', async () => {
      const user = await fakeUser({ confirmedAt: new Date() });
      const personalToken = await fakePersonalToken({ user, scope: [OAuthScopes.account, OAuthScopes.email] });

      const result = await graphqlQueryV2(
        requestEmailChangeMutation,
        { email: randEmail() },
        user,
        null,
        null,
        null,
        personalToken,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal(
        'OAuth and Personal Tokens are not allowed to change the email address.',
      );
      await user.reload();
      expect(user.emailWaitingForValidation).to.be.null;
    });
  });

  describe('createIncognitoProfile', () => {
    const createIncognitoProfileMutation = gql`
      mutation CreateIncognitoProfile {
        createIncognitoProfile {
          id
          name
          slug
          type
          isIncognito
        }
      }
    `;

    before(async () => {
      await startTestServer();
    });

    after(async () => {
      await stopTestServer();
    });

    it('fails if not authenticated', async () => {
      const result = await graphqlQueryV2(createIncognitoProfileMutation, {});
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('You need to be logged in to manage account.');
    });

    it('creates an incognito profile with the correct fields', async () => {
      const user = await fakeUser();
      const result = await graphqlQueryV2(createIncognitoProfileMutation, {}, user);
      expect(result.errors).to.not.exist;

      const profile = result.data.createIncognitoProfile;
      expect(profile.name).to.equal('Incognito');
      expect(profile.isIncognito).to.be.true;
      expect(profile.slug).to.match(/^incognito-[a-f0-9]+$/);
    });

    it('is idempotent — returns the same profile on repeated calls', async () => {
      const user = await fakeUser();

      const result1 = await graphqlQueryV2(createIncognitoProfileMutation, {}, user);
      expect(result1.errors).to.not.exist;

      const result2 = await graphqlQueryV2(createIncognitoProfileMutation, {}, user);
      expect(result2.errors).to.not.exist;

      expect(result1.data.createIncognitoProfile.id).to.equal(result2.data.createIncognitoProfile.id);
      expect(result1.data.createIncognitoProfile.slug).to.equal(result2.data.createIncognitoProfile.slug);
    });

    it('adds the creator as ADMIN of the incognito collective', async () => {
      const user = await fakeUser();
      const result = await graphqlQueryV2(createIncognitoProfileMutation, {}, user);
      expect(result.errors).to.not.exist;

      const profile = result.data.createIncognitoProfile;
      const incognitoCollectiveId = idDecode(profile.id, IDENTIFIER_TYPES.ACCOUNT);

      const members = await models.Member.findAll({ where: { CollectiveId: incognitoCollectiveId } });
      expect(members).to.have.length(1);
      expect(members[0].role).to.equal(roles.ADMIN);
      expect(members[0].MemberCollectiveId).to.equal(user.CollectiveId);
    });
  });
});
