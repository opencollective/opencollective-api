import { expect } from 'chai';
import config from 'config';
import gql from 'fake-tag';
import { createSandbox } from 'sinon';

import { verifyJwt } from '../../../../../server/lib/auth';
import emailLib from '../../../../../server/lib/email';
import { randEmail } from '../../../../stores';
import { fakeUser, randStr } from '../../../../test-helpers/fake-data';
import { graphqlQueryV2, resetTestDB, waitForCondition } from '../../../../utils';

const sendConfirmationMutation = gql`
  mutation SendGuestConfirmation($email: EmailAddress!) {
    sendGuestConfirmationEmail(email: $email)
  }
`;

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

const callSendConfirmation = (email, remoteUser = null) => {
  return graphqlQueryV2(sendConfirmationMutation, { email }, remoteUser);
};

const callConfirmGuestAccount = (email, emailConfirmationToken, remoteUser = null) => {
  return graphqlQueryV2(confirmGuestAccountMutation, { email, emailConfirmationToken }, remoteUser);
};

describe('server/graphql/v2/mutation/GuestMutations', () => {
  let sandbox, emailSendMessageSpy;

  before(async () => {
    await resetTestDB();
    sandbox = createSandbox();
    emailSendMessageSpy = sandbox.spy(emailLib, 'sendMessage');
    sandbox.stub(config, 'limits').value({
      sendGuestConfirmPerMinutePerIp: 1000000,
      sendGuestConfirmPerMinutePerEmail: 1000000,
      confirmGuestAccountPerMinutePerIp: 1000000,
    });
  });

  after(() => {
    sandbox.restore();
  });

  describe('sendGuestConfirmationEmail', () => {
    it('rejects if the user is signed in', async () => {
      const user = await fakeUser();
      const result = await callSendConfirmation(randEmail(), user);
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.include("You're signed in");
    });

    it('rejects if the user is already verified', async () => {
      const user = await fakeUser();
      const result = await callSendConfirmation(user.email);
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.include('This account has already been confirmed');
    });

    it('rejects if the user does not exist', async () => {
      const result = await callSendConfirmation(randEmail());
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.include('No user found for this email address');
    });

    it('sends the confirmation email', async () => {
      const user = await fakeUser({ confirmedAt: null, emailConfirmationToken: randStr() });
      const result = await callSendConfirmation(user.email);
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.sendGuestConfirmationEmail).to.be.true;

      await waitForCondition(() => emailSendMessageSpy.callCount === 1);
      expect(emailSendMessageSpy.callCount).to.equal(1);

      const [recipient, subject, body] = emailSendMessageSpy.args[0];
      expect(recipient).to.eq(user.email);
      expect(subject).to.eq('Open Collective: Verify your email');
      expect(body).to.include(`/confirm/guest/${user.emailConfirmationToken}?email=${encodeURIComponent(user.email)}`);
    });
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
      const user = await fakeUser({ confirmedAt: null, emailConfirmationToken: randStr() });
      const response = await callConfirmGuestAccount(user.email, user.emailConfirmationToken);
      response.errors && console.error(response.errors);
      expect(response.errors).to.not.exist;

      const { account, accessToken } = response.data.confirmGuestAccount;
      expect(account.legacyId).to.eq(user.CollectiveId);

      const decodedJwt = verifyJwt(accessToken);
      expect(decodedJwt.sub).to.eq(user.id.toString());
    });
  });

  describe('rate limiting', () => {
    afterEach(() => {
      sandbox.restore();
    });

    it('sendGuestConfirmationEmail is rate limited on IP', async () => {
      sandbox.stub(config, 'limits').value({
        sendGuestConfirmPerMinutePerIp: 0,
        sendGuestConfirmPerMinutePerEmail: 1000000,
      });

      const user = await fakeUser({ confirmedAt: null });
      const result = await callSendConfirmation(user.email);
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.include(
        'An email has already been sent recently. Please try again in a few minutes.',
      );
    });

    it('sendGuestConfirmationEmailis rate limited on email', async () => {
      sandbox.stub(config, 'limits').value({
        sendGuestConfirmPerMinutePerIp: 1000000,
        sendGuestConfirmPerMinutePerEmail: 0,
      });

      const user = await fakeUser({ confirmedAt: null });
      const result = await callSendConfirmation(user.email);
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.include(
        'An email has already been sent for this address recently. Please check your SPAM folder, or try again in a few minutes.',
      );
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
