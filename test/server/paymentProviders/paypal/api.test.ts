/* eslint-disable camelcase */
import { expect } from 'chai';
import config from 'config';
import nock from 'nock';
import { stub } from 'sinon';

import models from '../../../../server/models';
import {
  exchangeAuthCodeForToken,
  paypalConnectAuthorizeUrl,
  paypalRequest,
  paypalUrl,
  refreshPaypalUserToken,
  retrieveOAuthToken,
  retrievePaypalUserInfo,
} from '../../../../server/paymentProviders/paypal/api';
import { fakeCollective } from '../../../test-helpers/fake-data';
import * as utils from '../../../utils';

describe('server/paymentProviders/paypal/api', () => {
  describe('#paypalUrl', () => {
    let configStub;

    afterEach(() => {
      // The stub is created in each test and reset here.
      configStub.restore();
    }); /* End of `afterEach()' */

    it('should use Sandbox API when config says so', () => {
      configStub = stub(config.paypal.payment, 'environment').get(() => 'sandbox');
      const url = paypalUrl('foo');
      expect(url).to.equal('https://api.sandbox.paypal.com/v1/foo');
    }); /* End of `should use Sandbox API when config says so' */

    it('should use Production API when config says so', () => {
      configStub = stub(config.paypal.payment, 'environment').get(() => 'production');
      const url = paypalUrl('foo');
      expect(url).to.equal('https://api.paypal.com/v1/foo');
    }); /* End of `should use Production API when config says so' */
  }); /* End of `#paypalUrl' */

  describe('With PayPal auth', () => {
    /* Another `describe' section is started here to share the stub of
       the PayPal url `/v1/oauth2/token'. Which is pretty much
       everything besides `paypalUrl` and`retrieveOAuthToken`. */

    before(async () => {
      await utils.resetTestDB({ groupedTruncate: false });
    });

    let configStub;
    before(() => {
      /* Stub out the configuration with authentication information
         and environment name. */
      configStub = stub(config.paypal, 'payment').get(() => ({
        environment: 'sandbox',
      }));
      /* Catch the retrieval of auth tokens */
      nock('https://api.sandbox.paypal.com')
        .persist()
        .post('/v1/oauth2/token')
        .basicAuth({ user: 'my-client-id', pass: 'my-client-secret' })
        .reply(200, { access_token: 'dat-token' });
    }); /* End of "before()" */

    const secrets = {
      clientId: 'my-client-id',
      clientSecret: 'my-client-secret',
    };
    let host;
    beforeEach(async () => {
      const paypal = await models.ConnectedAccount.create({
        service: 'paypal',
        clientId: secrets.clientId,
        token: secrets.clientSecret,
      });
      host = await fakeCollective({});
      await host.addConnectedAccount(paypal);
    });

    after(() => {
      configStub.restore();
      nock.cleanAll();
    }); /* End of "after()" */

    describe('#retrieveOAuthToken', () => {
      it('should retrieve the oauth token from PayPal API', async () => {
        const token = await retrieveOAuthToken(secrets);
        expect(token).to.equal('dat-token');
      }); /* End of "should retrieve the oauth token from PayPal API" */
    }); /* End of "#retrieveOAuthToken" */

    describe('#paypalRequest', () => {
      before(() => {
        nock('https://api.sandbox.paypal.com')
          .matchHeader('Authorization', 'Bearer dat-token')
          .post('/v1/path/we/are/testing')
          .reply(200, { success: 1 });
      }); /* End of "before()" */

      it('should request PayPal API endpoints', async () => {
        const output = await paypalRequest('path/we/are/testing', {}, host);
        expect(output).to.deep.equal({ success: 1 });
      }); /* End of "#paypalRequest" */
    }); /* End of "#paypalRequest" */
  }); /* End of "With PayPal auth" */

  describe('PayPal Connect OAuth Identity', () => {
    const connectConfig = {
      clientId: 'connect-client-id',
      clientSecret: 'connect-secret',
      redirectUri: 'https://example.com/services/paypal/oauth/callback',
    };

    const paypalConfig = {
      payment: { environment: 'sandbox' },
      connect: connectConfig,
    };

    let configPaypalStub;

    before(() => {
      nock.disableNetConnect();
      configPaypalStub = stub(config, 'paypal').get(() => paypalConfig);
    });

    after(() => {
      configPaypalStub.restore();
      nock.enableNetConnect();
      nock.cleanAll();
    });

    describe('#paypalConnectAuthorizeUrl', () => {
      it('returns sandbox URL when environment is sandbox', () => {
        paypalConfig.payment.environment = 'sandbox';
        const url = paypalConnectAuthorizeUrl();
        expect(url).to.equal('https://www.sandbox.paypal.com/connect/');
      });

      it('returns production URL when environment is production', () => {
        paypalConfig.payment.environment = 'production';
        const url = paypalConnectAuthorizeUrl();
        expect(url).to.equal('https://www.paypal.com/connect/');
      });
    });

    describe('#exchangeAuthCodeForToken', () => {
      it('returns access_token and refresh_token on success', async () => {
        const tokenResponse = {
          access_token: 'user-access-token',
          refresh_token: 'user-refresh-token',
          token_type: 'Bearer',
          expires_in: 28800,
          scope: 'openid email',
          nonce: 'nonce123',
          state: 'state123',
        };
        ['https://api.sandbox.paypal.com', 'https://api.paypal.com'].forEach(baseUrl =>
          nock(baseUrl).post('/v1/oauth2/token').reply(200, tokenResponse),
        );

        const result = await exchangeAuthCodeForToken('auth_code_123');
        expect(result).to.deep.equal(tokenResponse);
        expect(result.access_token).to.equal('user-access-token');
        expect(result.refresh_token).to.equal('user-refresh-token');
      });

      it('throws when PayPal returns non-2xx with error_description', async () => {
        ['https://api.sandbox.paypal.com', 'https://api.paypal.com'].forEach(baseUrl =>
          nock(baseUrl)
            .post('/v1/oauth2/token')
            .reply(400, { error: 'invalid_grant', error_description: 'Authorization code has expired' }),
        );

        await expect(exchangeAuthCodeForToken('expired_code')).to.be.rejectedWith(
          Error,
          /PayPal token exchange failed \(400\): Authorization code has expired/,
        );
      });
    });

    describe('#retrievePaypalUserInfo', () => {
      it('returns PaypalUserInfo on success', async () => {
        const userInfo = {
          user_id: 'PAYER123',
          sub: 'sub-123',
          name: 'John Doe',
          payer_id: 'PAYER123',
          address: {
            street_address: '123 Main St',
            locality: 'San Jose',
            region: 'CA',
            postal_code: '95131',
            country: 'US',
          },
          verified_account: 'true',
          emails: [{ value: 'john@example.com', primary: true, confirmed: true }],
        };
        ['https://api.sandbox.paypal.com', 'https://api.paypal.com'].forEach(baseUrl =>
          nock(baseUrl).get('/v1/identity/oauth2/userinfo').query({ schema: 'paypalv1.1' }).reply(200, userInfo),
        );

        const result = await retrievePaypalUserInfo('user-access-token');
        expect(result).to.deep.equal(userInfo);
        expect(result.user_id).to.equal('PAYER123');
        expect(result.verified_account).to.equal('true');
        expect(result.emails).to.have.lengthOf(1);
        expect(result.emails[0].value).to.equal('john@example.com');
        expect(result.emails[0].confirmed).to.be.true;
      });

      it('throws when PayPal returns non-2xx', async () => {
        ['https://api.sandbox.paypal.com', 'https://api.paypal.com'].forEach(baseUrl =>
          nock(baseUrl).get('/v1/identity/oauth2/userinfo').query(true).reply(401, { message: 'Invalid access token' }),
        );

        await expect(retrievePaypalUserInfo('invalid-token')).to.be.rejectedWith(
          Error,
          /PayPal userinfo request failed \(401\): Invalid access token/,
        );
      });
    });

    describe('#refreshPaypalUserToken', () => {
      it('returns new access_token and refresh_token on success', async () => {
        const tokenResponse = {
          access_token: 'new-access-token',
          refresh_token: 'new-refresh-token',
          expires_in: 28800,
        };
        ['https://api.sandbox.paypal.com', 'https://api.paypal.com'].forEach(baseUrl =>
          nock(baseUrl).post('/v1/oauth2/token').reply(200, tokenResponse),
        );

        const result = await refreshPaypalUserToken('old-refresh-token');
        expect(result).to.deep.equal(tokenResponse);
        expect(result.access_token).to.equal('new-access-token');
        expect(result.refresh_token).to.equal('new-refresh-token');
      });

      it('throws when PayPal returns non-2xx', async () => {
        ['https://api.sandbox.paypal.com', 'https://api.paypal.com'].forEach(baseUrl =>
          nock(baseUrl)
            .post('/v1/oauth2/token')
            .reply(400, { error: 'invalid_grant', error_description: 'Refresh token has expired' }),
        );

        await expect(refreshPaypalUserToken('expired-refresh-token')).to.be.rejectedWith(
          Error,
          /PayPal token refresh failed \(400\): Refresh token has expired/,
        );
      });
    });
  });
});
