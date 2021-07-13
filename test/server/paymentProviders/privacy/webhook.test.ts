/* eslint-disable camelcase */

import { expect } from 'chai';
import sinon from 'sinon';
import request from 'supertest';

import app from '../../../../server/index';
import * as privacyLib from '../../../../server/lib/privacy';
import privacy from '../../../../server/paymentProviders/privacy';
import { fakeCollective, fakeConnectedAccount, fakeVirtualCard } from '../../../test-helpers/fake-data';
import * as utils from '../../../utils';

describe('server/paymentProviders/privacy/webhook', () => {
  let expressApp, api;
  before(async () => {
    expressApp = await app();
    api = request(expressApp);
  });

  const sandbox = sinon.createSandbox();

  const event = {
    amount: 243,
    card: {
      created: '2020-07-13T10:22:20Z',
      funding: {
        account_name: 'Silicon Valley Bank',
        created: '2016-05-08 21:25:38',
        last_four: '1234',
        nickname: '',
        state: 'ENABLED',
        token: 'dd2c0187-56cf-44ce-b7d9-ee1c07179e10',
        type: 'DEPOSITORY_CHECKING',
      },
      hostname: '',
      last_four: '1234',
      memo: 'Digital Ocean',
      spend_limit: 5000,
      spend_limit_duration: 'MONTHLY' as const,
      state: 'OPEN' as const,
      token: '2904adfe-abce-427a-b731-f6b2c5380fb6',
      type: 'MERCHANT_LOCKED' as const,
    },
    created: '2021-02-01T15:28:11Z',
    events: [],
    funding: [
      {
        amount: 243,
        token: 'dd2c0187-56cf-44ce-b7d9-ee1c07179e10',
        type: 'DEPOSITORY_CHECKING',
      },
    ],
    merchant: {
      acceptor_id: '445283188990',
      city: 'DIGITALOCEAN.',
      country: 'USA',
      descriptor: 'DIGITALOCEAN.COM',
      mcc: '5734',
      state: 'NY',
    },
    result: 'APPROVED' as const,
    settled_amount: 243,
    status: 'SETTLED' as const,
    token: '9c63b54a-897c-49b7-9210-fc4dfa15b8d0',
  };
  let verifyEvent, processTransaction;
  let collective;

  afterEach(sandbox.restore);
  beforeEach(utils.resetTestDB);
  beforeEach(() => {
    verifyEvent = sandbox.stub(privacyLib, 'verifyEvent').callsFake(req => req.body);
    processTransaction = sandbox.stub(privacy, 'processTransaction').resolves();
  });
  beforeEach(async () => {
    const host = await fakeCollective({ isHostAccount: true });
    collective = await fakeCollective({ isHostAccount: false, HostCollectiveId: host.id });
    await fakeVirtualCard({
      CollectiveId: collective.id,
      HostCollectiveId: host.id,
      name: '1234',
      id: event.card.token,
    });
    await fakeConnectedAccount({
      CollectiveId: host.id,
      service: 'privacy',
      token: 'fake-token',
    });
  });

  it('assigns rawBody to request and verifies the event signature', async () => {
    await api.post('/webhooks/privacy').send(event).expect(200);

    sinon.assert.calledOnce(verifyEvent);
    const { args } = verifyEvent.getCall(0);
    expect(args[0]).to.have.property('rawBody');
  });

  it('should complete processing transactions if transfer was sent', async () => {
    await api.post('/webhooks/privacy').send(event).expect(200);

    sinon.assert.calledOnce(processTransaction);
  });

  it('should ignore if card does not exist', async () => {
    await api
      .post('/webhooks/privacy')
      .send({ ...event, card: { token: 'a-token-that-does-not-exist' } })
      .expect(200);

    sinon.assert.notCalled(processTransaction);
  });

  it('should ignore if event.result is not APPROVED', async () => {
    await api
      .post('/webhooks/privacy')
      .send({ ...event, result: 'WHAT_EVER' })
      .expect(200);

    sinon.assert.notCalled(processTransaction);
  });

  it('should ignore if event.status is not SETTLED', async () => {
    await api
      .post('/webhooks/privacy')
      .send({ ...event, status: 'PENDING' })
      .expect(200);

    sinon.assert.notCalled(processTransaction);
  });
});
