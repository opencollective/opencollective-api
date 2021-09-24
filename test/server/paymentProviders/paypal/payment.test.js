import { expect } from 'chai';
import config from 'config';
import nock from 'nock';
import sinon from 'sinon';
import request from 'supertest';
import { v4 as uuid } from 'uuid';

import app from '../../../../server/index';
import models from '../../../../server/models';
import * as paypalPayment from '../../../../server/paymentProviders/paypal/payment';
import * as store from '../../../stores';
import { fakeCollective } from '../../../test-helpers/fake-data';
import * as utils from '../../../utils';

const application = utils.data('application');

describe('server/paymentProviders/paypal/payment', () => {
  let expressApp;

  before(async () => {
    expressApp = await app();
  });

  describe('With PayPal auth', () => {
    /* Another `describe' section is started here to share the stub of
       the PayPal url `/v1/oauth2/token'. Which is pretty much
       everything besides `paypalUrl` and`retrieveOAuthToken`. */

    before(utils.resetTestDB);

    let configStub;
    before(() => {
      /* Stub out the configuration with authentication information
         and environment name. */
      configStub = sinon.stub(config.paypal, 'payment').get(() => ({
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

    describe('#createPayment', () => {
      before(() => {
        nock('https://api.sandbox.paypal.com')
          .matchHeader('Authorization', 'Bearer dat-token')
          .post('/v1/payments/payment')
          .reply(200, { id: 'a very legit payment id' });
      }); /* End of "before()" */

      it('should call payments/payment endpoint of the PayPal API', async () => {
        const output = await request(expressApp)
          .post(`/services/paypal/create-payment?api_key=${application.api_key}`)
          .send({ amount: '50', currency: 'USD', hostId: host.id })
          .expect(200);
        expect(output.body.id).to.equal('a very legit payment id');
      }); /* End of "should call payments/payment endpoint of the PayPal API" */
    }); /* End of "#createPayment" */

    // TODO: Test record* functions
  }); /* End of "With PayPal auth" */
});
