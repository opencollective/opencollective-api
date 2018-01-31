import _ from 'lodash';
import request from 'supertest';
import sinon from 'sinon';

import app from '../server/index';
import originalStripeMock from './mocks/stripe';
import { appStripe } from '../server/paymentProviders/stripe/gateway';

describe('webhooks.stripe.creditcard.test.js', () => {
  let sandbox;

  beforeEach(() => {
    const stripeMock = _.cloneDeep(originalStripeMock);
    sandbox = sinon.sandbox.create();
    sandbox.stub(appStripe.events, "retrieve", () => Promise.resolve(stripeMock.webhook_payment_succeeded));
  });

  afterEach(() => sandbox.restore());

  it('Should just return 200 and dont really do anything', async () => {
    await request(app)
      .post('/webhooks/stripe')
      .send({ data: 'webhookPayload' })
      .expect(200);
  });
});
