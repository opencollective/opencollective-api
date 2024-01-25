import { expect } from 'chai';
import config from 'config';
import nock from 'nock';
import { stub } from 'sinon';

import models from '../../../../server/models';
import { paypalRequest, paypalUrl, retrieveOAuthToken } from '../../../../server/paymentProviders/paypal/api';
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
      await utils.resetTestDB();
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
        .reply(200, { access_token: 'dat-token' }); // eslint-disable-line camelcase
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
});
