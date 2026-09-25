import { expect } from 'chai';
import nock from 'nock';
import { assert, createSandbox } from 'sinon';

import * as transferwise from '../../../server/lib/transferwise';
import { wiseInt64 } from '../../../server/lib/wise-id';
import { TransferStateChangeEvent } from '../../../server/types/transferwise';
import { fakeConnectedAccount } from '../../test-helpers/fake-data';

const sandbox = createSandbox();

describe('server/lib/transferwise', () => {
  after(sandbox.restore);

  describe('formatAccountDetails', () => {
    const accountData = {
      type: 'sort_code',
      accountHolderName: 'John Malkovich',
      currency: 'GBP',
      details: {
        IBAN: 'DE893219828398123',
        sortCode: '40-30-20',
        legalType: 'PRIVATE',
        accountNumber: '12345678',
        address: {
          country: 'US',
          state: 'NY',
          city: 'New York',
          zip: '10001',
        },
      },
      isManualBankTransfer: true,
    };

    it('should format account details', () => {
      const f = transferwise.formatAccountDetails(accountData);

      expect(f).to.include('Account Holder Name: John Malkovich');
      expect(f).to.include('IBAN: DE893219828398123');
      expect(f).to.include('Sort Code: 40-30-20');
      expect(f).to.include('Legal Type: PRIVATE');
      expect(f).to.include('Account Number: 12345678');
      expect(f).to.include('Country: US');
      expect(f).to.include('State: NY');
      expect(f).to.include('City: New York');
      expect(f).to.include('Zip: 10001');
    });

    it('should format using custom labels', () => {
      const f = transferwise.formatAccountDetails({
        type: 'aba',
        details: {
          abartn: '026049293',
          address: { city: 'Tirana', country: 'AL', postCode: 'Tirana 1000', firstLine: 'Sheshi Skënderbej 1' },
          legalType: 'PRIVATE',
          accountType: 'CHECKING',
          accountNumber: '12345678',
        },
        currency: 'USD',
        accountHolderName: 'Nicolas Cage',
        isManualBankTransfer: true,
      });

      expect(f).to.include('Routing Number: 026049293');
    });

    it('should omit irrelevant information', () => {
      const f = transferwise.formatAccountDetails(accountData);

      expect(f).to.not.include('Is Manual Bank Transfer');
      expect(f).to.not.include('Type: sort_code');
      expect(f).to.not.include('Currency: GBP');
    });
  });

  describe('requestDataAndThrowParsedError', () => {
    let stub;

    beforeEach(() => {
      stub = sandbox.stub().resolves({ data: true });
    });

    it('should request using passing parameters', async () => {
      await transferwise.requestDataAndThrowParsedError(stub, 'fake-url', {
        headers: { Authorization: 'Bearer fake-tokinzes' },
      });
      assert.calledWith(stub, 'fake-url', { headers: { Authorization: 'Bearer fake-tokinzes' } });
    });

    it('should inject post data, if passed', async () => {
      await transferwise.requestDataAndThrowParsedError(stub, 'fake-url', {
        data: { hasBody: true },
        headers: { Authorization: 'Bearer fake-tokinzes' },
      });
      assert.calledWith(stub, 'fake-url', '{"hasBody":true}', {
        headers: { Authorization: 'Bearer fake-tokinzes', 'Content-Type': 'application/json' },
      });
    });

    it('should extract data from the response', async () => {
      stub.resolves({ data: { fake: true } });
      const response = await transferwise.requestDataAndThrowParsedError(stub, 'fake-url', {
        headers: { Authorization: 'Bearer fake-tokinzes' },
      });
      expect(response).to.deep.equal({ fake: true });
    });

    it('should implement strong user authorization if requested', async () => {
      stub.onFirstCall().rejects({
        response: {
          headers: {
            'x-2fa-approval-result': 'REJECTED',
            'x-2fa-approval': 'fake-token',
          },
        },
      });
      stub.onSecondCall().resolves({ data: true });

      await transferwise.requestDataAndThrowParsedError(stub, 'fake-url', {
        data: { cool: 'beans' },
        headers: { Authorization: 'Bearer fake-tokinzes' },
      });

      const [url, data, options] = stub.secondCall.args;
      expect(url).to.equal('fake-url');
      expect(data).to.equal('{"cool":"beans"}');
      expect(options).to.have.property('headers');
      expect(options.headers).to.have.property('Authorization').equal('Bearer fake-tokinzes');
      expect(options.headers).to.have.property('x-2fa-approval').equal('fake-token');
      expect(options.headers).to.have.property('X-Signature');
    });

    describe('with options.connectedAccount', () => {
      let connectedAccount;
      beforeEach(async () => {
        connectedAccount = await fakeConnectedAccount({
          token: 'cool',
          refreshToken: 'refresh-cool',
          // eslint-disable-next-line camelcase
          data: { created_at: new Date(), expires_in: 10000 },
        });

        nock('https://api.wise-sandbox.com', { encodedQueryParams: true })
          .persist()
          .post('/oauth/token')
          .reply(200, { access_token: 'fresh-token', created_at: new Date(), expires_in: 10000 }); // eslint-disable-line camelcase
      });

      it('works with connectedAccount option', async () => {
        stub.resolves({ data: { fake: true } });
        await transferwise.requestDataAndThrowParsedError(stub, 'fake-url', {
          connectedAccount,
        });

        const [, options] = stub.firstCall.args;
        expect(options.headers).to.have.property('Authorization').equal('Bearer cool');
      });

      it('automatically renew and retries if token is invalid', async () => {
        stub.onCall(0).rejects({ response: { status: 401, data: { error: 'invalid_token' } } });
        stub.onCall(1).resolves({ data: { fake: true } });

        await transferwise.requestDataAndThrowParsedError(stub, 'fake-url', {
          connectedAccount,
        });

        expect(stub.firstCall.lastArg.headers).to.have.property('Authorization').equal('Bearer cool');
        expect(stub.secondCall.lastArg.headers).to.have.property('Authorization').equal('Bearer fresh-token');
      });

      it('gives up after 5 retries', async () => {
        stub.rejects({ response: { status: 401, data: { error: 'invalid_token' } } });

        const p = transferwise.requestDataAndThrowParsedError(stub, 'fake-url', {
          connectedAccount,
        });

        await expect(p).to.eventually.rejectedWith(Error, 'Wise: invalid_token');

        expect(stub.callCount).to.equal(5);
        expect(stub.firstCall.lastArg.headers).to.have.property('Authorization').equal('Bearer cool');
        expect(stub.secondCall.lastArg.headers).to.have.property('Authorization').equal('Bearer fresh-token');
      });
    });
  });

  describe('getToken', () => {
    beforeEach(() => nock.cleanAll());
    afterEach(() => nock.cleanAll());

    it('should disconnect the account when the OAuth refresh fails with invalid_grant', async () => {
      // Mirrors Sentry issue OC-API-13D (connectedAccountId 147044): Wise's OAuth token
      // endpoint answers 400 with an OAuth-style error payload that has no `errorCode`.
      const connectedAccount = await fakeConnectedAccount({
        service: 'transferwise',
        token: 'stale-access-token',
        refreshToken: '23e25d6964...', // matches the refresh_token prefix reported by Wise
        // eslint-disable-next-line camelcase
        data: { created_at: new Date(Date.now() - 60 * 60 * 1000), expires_in: 100 }, // expired -> triggers refresh
      });

      nock('https://api.wise-sandbox.com').post('/oauth/token').reply(400, {
        error: 'invalid_grant',
        // eslint-disable-next-line camelcase
        error_description: 'Invalid refresh token (refreshAccessToken - not found refresh_token): 23e25d6964',
      });

      const destroySpy = sandbox.spy(connectedAccount, 'destroy');

      let error;
      try {
        await transferwise.getToken(connectedAccount);
      } catch (e) {
        error = e;
      }

      // The refresh failed, so getToken must reject.
      expect(error).to.exist;

      // The Wise OAuth error must be surfaced with its code so the account can be disabled.
      // BUG: parseError() only maps `errorCode`/422 responses, so this is
      // 'transferwise.error.default' and the disconnect logic in refreshAndUpdateToken() never runs.
      expect(error.extensions.code).to.equal('invalid_grant');

      // The stale token should be disabled by destroying the connected account.
      // BUG: never happens - the account keeps failing on every request (OC-API-13D).
      expect(destroySpy.called).to.be.true;
    });
  });

  describe('Int64 identifiers', () => {
    const sandbox = createSandbox();
    const MAX_INT64 = '9223372036854775807';

    afterEach(() => {
      sandbox.restore();
      nock.cleanAll();
    });

    it('parses a verified webhook raw body losslessly and normalizes resource IDs', () => {
      const rawBody = `{
        "data": {
          "resource": {
            "id": 9223372036854775807,
            "profile_id": 9007199254740993,
            "account_id": 9007199254740992,
            "type": "transfer"
          },
          "current_state": "outgoing_payment_sent",
          "previous_state": "processing",
          "occurred_at": "2020-03-02T13:37:54Z"
        },
        "subscription_id": "00000000-0000-0000-0000-000000000000",
        "event_type": "transfers#state-change",
        "schema_version": "2.0.0",
        "sent_at": "2020-03-02T13:37:54Z"
      }`;

      const event = transferwise.parseWebhookEvent(rawBody) as TransferStateChangeEvent;
      expect(event.data.resource.id).to.equal(MAX_INT64);
      expect(event.data.resource.profile_id).to.equal('9007199254740993');
      expect(event.data.resource.account_id).to.equal('9007199254740992');
      // Adjacent unsafe values must remain distinct
      expect(event.data.resource.profile_id).to.not.equal(event.data.resource.account_id);
    });

    it('serializes Wise int64 identifiers as exact unquoted integers', async () => {
      const stub = sandbox.stub().resolves({ data: true });

      await transferwise.requestDataAndThrowParsedError(stub, 'fake-url', {
        data: { targetAccount: wiseInt64(MAX_INT64), quoteUuid: 'quote-uuid' },
      });

      const [, body, options] = stub.firstCall.args;
      expect(body).to.equal(`{"targetAccount":${MAX_INT64},"quoteUuid":"quote-uuid"}`);
      expect(options.headers).to.have.property('Content-Type', 'application/json');
    });

    it('parses Wise HTTP responses without rounding adjacent unsafe identifiers', async () => {
      const connectedAccount = await fakeConnectedAccount({
        service: 'transferwise',
        token: 'cool-token',
        // eslint-disable-next-line camelcase
        data: { created_at: new Date(), expires_in: 10000 },
      });
      const rawBody =
        '{"id":9007199254740993,"user":9007199254740992,"targetAccount":9007199254740992,"quote":9007199254740993,"sourceValue":123.45,"status":"processing"}';
      nock('https://api.wise-sandbox.com')
        .get('/v1/transfers/9007199254740993')
        .reply(200, rawBody, { 'Content-Type': 'application/json' });

      const transfer = await transferwise.getTransfer(connectedAccount, '9007199254740993');

      expect(transfer.id).to.equal('9007199254740993');
      expect(transfer.user).to.equal('9007199254740992');
      expect(transfer.id).to.not.equal(transfer.user);
      expect(transfer.targetAccount).to.equal('9007199254740992');
      // Non-identifier numeric values must stay numeric
      expect(transfer).to.have.property('sourceValue', 123.45);
    });

    it('normalizes simulated transfer responses to canonical string IDs', async () => {
      const connectedAccount = await fakeConnectedAccount({
        service: 'transferwise',
        token: 'cool-token',
        // eslint-disable-next-line camelcase
        data: { created_at: new Date(), expires_in: 10000 },
      });
      const rawBody =
        '{"id":2148014123,"user":9007199254740993,"targetAccount":2148014124,"sourceValue":123.45,"status":"outgoing_payment_sent"}';
      nock('https://api.wise-sandbox.com')
        .get('/v1/simulation/transfers/2148014123/processing')
        .reply(200, rawBody, { 'Content-Type': 'application/json' })
        .get('/v1/simulation/transfers/2148014123/funds_converted')
        .reply(200, rawBody, { 'Content-Type': 'application/json' })
        .get('/v1/simulation/transfers/2148014123/outgoing_payment_sent')
        .reply(200, rawBody, { 'Content-Type': 'application/json' });

      const transfer = await transferwise.simulateTransferSuccess(connectedAccount, '2148014123');

      expect(transfer.id).to.equal('2148014123');
      expect(transfer.user).to.equal('9007199254740993');
      expect(transfer.targetAccount).to.equal('2148014124');
      // Non-identifier numeric values must stay numeric
      expect(transfer).to.have.property('sourceValue', 123.45);
    });

    it('sends the exact int64 targetAccount in the raw request body', async () => {
      const connectedAccount = await fakeConnectedAccount({
        service: 'transferwise',
        token: 'cool-token',
        // eslint-disable-next-line camelcase
        data: { created_at: new Date(), expires_in: 10000 },
      });
      const expectedBody = `{"targetAccount":${MAX_INT64},"quoteUuid":"quote-uuid","customerTransactionId":"customer-tx"}`;
      const scope = nock('https://api.wise-sandbox.com').post('/v1/transfers', expectedBody).reply(200, '{"id":1}');

      await transferwise.createTransfer(connectedAccount, {
        accountId: MAX_INT64,
        quoteUuid: 'quote-uuid',
        customerTransactionId: 'customer-tx',
      });

      expect(scope.isDone()).to.be.true;
    });

    it('keeps the batch group version numeric while normalizing its transfer ids', async () => {
      // `version` is an operational counter, not a Wise identifier: it must stay a number. Only the
      // `transferIds` are identifiers and get canonicalized to decimal strings.
      const connectedAccount = await fakeConnectedAccount({
        service: 'transferwise',
        token: 'cool-token',
        // eslint-disable-next-line camelcase
        data: { id: '220192', created_at: new Date(), expires_in: 10000 },
      });
      const rawBody = '{"id":"batch-1","version":2,"transferIds":[9007199254740993,800],"status":"NEW"}';
      nock('https://api.wise-sandbox.com')
        .get('/v3/profiles/220192/batch-groups/batch-1')
        .reply(200, rawBody, { 'Content-Type': 'application/json' });

      const batchGroup = await transferwise.getBatchGroup(connectedAccount, 'batch-1');

      expect(batchGroup).to.have.property('version', 2);
      expect(batchGroup.version).to.be.a('number');
      expect(batchGroup.transferIds).to.deep.equal(['9007199254740993', '800']);
    });
  });
});
