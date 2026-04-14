import { expect } from 'chai';
import config from 'config';
import gql from 'fake-tag';
import { createSandbox } from 'sinon';

import { verifyJwt } from '../../../../../server/lib/auth';
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
      const user = await fakeUser({ confirmedAt: null, emailConfirmationToken: randStr() });
      const response = await callConfirmGuestAccount(user.email, user.emailConfirmationToken);
      response.errors && console.error(response.errors);
      expect(response.errors).to.not.exist;

      const { account, accessToken } = response.data.confirmGuestAccount;
      expect(account.legacyId).to.eq(user.CollectiveId);

      const decodedJwt = verifyJwt(accessToken);
      expect(decodedJwt.sub).to.eq(user.id.toString());
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
