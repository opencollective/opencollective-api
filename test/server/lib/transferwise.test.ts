import { expect } from 'chai';
import nock from 'nock';
import { assert, createSandbox } from 'sinon';

import * as transferwise from '../../../server/lib/transferwise.js';
import { fakeConnectedAccount } from '../../test-helpers/fake-data.js';

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
      assert.calledWith(stub, 'fake-url', { hasBody: true }, { headers: { Authorization: 'Bearer fake-tokinzes' } });
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
      expect(data).to.deep.equal({ cool: 'beans' });
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

        nock('https://api.sandbox.transferwise.tech', { encodedQueryParams: true })
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
});
