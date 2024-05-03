import bcrypt from 'bcrypt';
import { expect } from 'chai';
import config from 'config';
import crypto from 'crypto-js';
import gql from 'fake-tag';
import jwt from 'jsonwebtoken';
import { createSandbox } from 'sinon';
import speakeasy from 'speakeasy';
import request from 'supertest';

import { idEncode } from '../../../../../server/graphql/v2/identifiers';
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

const SECRET_KEY = config.dbEncryption.secretKey;
const CIPHER = config.dbEncryption.cipher;

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
      const secret = speakeasy.generateSecret({ length: 64 });
      const encryptedToken = crypto[CIPHER].encrypt(secret.base32, SECRET_KEY).toString();
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

    describe('using OAuth tokens', () => {
      it('must have the account scope', async () => {
        const application = await fakeApplication({ type: 'oAuth' });
        const user = await fakeUser({ passwordHash: null });
        const userToken = await fakeUserToken({
          type: 'OAUTH',
          ApplicationId: application.id,
          UserId: user.id,
          scope: ['expenses'],
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
        expect(result.errors[0].message).to.equal('The User Token is not allowed for operations in scope "account".');
      });

      it('should change not password but not generate a session token', async () => {
        const application = await fakeApplication({ type: 'oAuth' });
        const user = await fakeUser({ passwordHash: null });
        const userToken = await fakeUserToken({
          type: 'OAUTH',
          ApplicationId: application.id,
          UserId: user.id,
          scope: ['account'],
        });

        const result = await graphqlQueryV2(
          setPasswordMutation,
          { password: 'newpassword' },
          user,
          null,
          null,
          userToken,
        );

        expect(result.errors).to.not.exist;
        expect(result.data.setPassword.token).to.not.exist;

        await user.reload();
        expect(user.passwordHash).to.not.be.empty;
        expect(user.passwordUpdatedAt).to.exist;
        expect(await bcrypt.compare('newpassword', user.passwordHash)).to.be.true;
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
      expect(resultOauth.errors[0].message).to.equal('OAuth and Personal Tokens are not allowed for this route');

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
        'OAuth and Personal Tokens are not allowed for this route',
      );
    });

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
});
