import { expect } from 'chai';
import _ from 'lodash';
import { createSandbox } from 'sinon';
import request from 'supertest';

import app from '../../../server/index';
import stripe from '../../../server/lib/stripe';
import originalStripeMock from '../../mocks/stripe';

describe('server/routes/webhooks.stripe', () => {
  let sandbox, expressApp;

  before(async () => {
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

    it('returns an error if the event does not exist', done => {
      const stripeMock = _.cloneDeep(originalStripeMock);

      // eslint-disable-next-line camelcase
      stripeMock.event_payment_succeeded = {
        error: {
          type: 'invalid_request_error',
          message: 'No such event',
          param: 'id',
          requestId: 'req_7Y8TeQytYKcs1k',
        },
      };

      sandbox.stub(stripe.events, 'retrieve').callsFake(() => Promise.resolve(stripeMock.event_payment_succeeded));

      request(expressApp)
        .post('/webhooks/stripe')
        .send({
          id: 123,
        })
        .expect(400, {
          error: {
            code: 400,
            type: 'bad_request',
            message: 'Event not found',
          },
        })
        .end(done);
    });

    it('error out on `source.chargeable`', done => {
      const stripeMock = _.cloneDeep(originalStripeMock);

      sandbox.stub(stripe.events, 'retrieve').callsFake(() => Promise.resolve(stripeMock.event_source_chargeable));
      request(expressApp).post('/webhooks/stripe').send(stripeMock.webhook_source_chargeable).expect(400).end(done);
    });

    it('returns an error if the event is `source.chargeable`', done => {
      const stripeMock = _.cloneDeep(originalStripeMock);
      stripeMock.event_source_chargeable.type = 'application_fee.created';

      sandbox.stub(stripe.events, 'retrieve').callsFake(() => Promise.resolve(stripeMock.event_source_chargeable));

      request(expressApp)
        .post('/webhooks/stripe')
        .send(stripeMock.webhook_payment_succeeded)
        .expect(400, {
          error: {
            code: 400,
            type: 'bad_request',
            message: 'Wrong event type received : application_fee.created',
          },
        })
        .end(done);
    });
  });
});
