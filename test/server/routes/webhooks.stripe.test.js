import { expect } from 'chai';
import _ from 'lodash';
import { assert, createSandbox, stub } from 'sinon';
import request from 'supertest';

import { Service } from '../../../server/constants/connected_account';
import app from '../../../server/index';
import * as stripeLib from '../../../server/lib/stripe';
import originalStripeMock from '../../mocks/stripe';
import { fakeConnectedAccount } from '../../test-helpers/fake-data';
import { resetTestDB } from '../../utils';

describe('server/routes/webhooks.stripe', () => {
  let sandbox, expressApp;

  before(async () => {
    await resetTestDB();
    await fakeConnectedAccount({
      service: Service.STRIPE,
      username: 'acc_mock',
      data: {
        webhookSigningSecret: 'whsec_mock',
      },
    });
    expressApp = await app();
  });

  it('returns 200 if the event is not livemode in production', done => {
    const stripeMock = _.cloneDeep(originalStripeMock);
    const webhookEvent = stripeMock.webhook_source_chargeable;

    const event = _.extend({}, webhookEvent, {
      livemode: false,
    });

    const env = process.env.OC_ENV;
    process.env.OC_ENV = 'production';

    request(expressApp)
      .post('/webhooks/stripe')
      .send(event)
      .expect(200)
      .end(err => {
        expect(err).to.not.exist;
        process.env.OC_ENV = env;
        done();
      });
  });

  describe('Webhook events: ', () => {
    beforeEach(() => {
      sandbox = createSandbox();
    });

    afterEach(() => {
      sandbox.restore();
    });

    it('should return HTTP 200 if event is not supported', async () => {
      const event = {
        type: 'application_fee.created',
        account: 'acc_mock',
      };

      sandbox.stub(stripeLib, 'StripeCustomToken').returns({
        webhooks: {
          constructEvent: stub().returns(event),
        },
      });

      await request(expressApp).post('/webhooks/stripe').send(event).expect(200);
    });

    it('should return HTTP 500 if event is not signed', async () => {
      const event = {
        type: 'issuing_card.updated',
        account: 'acc_mock',
      };

      sandbox.stub(stripeLib, 'StripeCustomToken').returns({
        webhooks: {
          constructEvent: stub().throws(new Error('bad signature')),
        },
      });

      await request(expressApp).post('/webhooks/stripe').send(event).expect(500);
    });

    it('should return HTTP 500 if account is not recognized', async () => {
      const event = {
        type: 'issuing_card.updated',
        account: 'acc_mock_test',
      };

      const constructEventMock = stub();
      sandbox.stub(stripeLib, 'StripeCustomToken').returns({
        webhooks: {
          constructEvent: constructEventMock,
        },
      });

      await request(expressApp).post('/webhooks/stripe').send(event).expect(500);

      assert.notCalled(constructEventMock);
    });
  });
});
