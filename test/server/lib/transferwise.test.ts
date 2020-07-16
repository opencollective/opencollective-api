import { expect } from 'chai';
import sinon from 'sinon';

import { formatAccountDetails, requestDataAndThrowParsedError } from '../../../server/lib/transferwise';

const sandbox = sinon.createSandbox();

describe('server/lib/transferwise', () => {
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
      const f = formatAccountDetails(accountData);

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
      const f = formatAccountDetails({
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
      const f = formatAccountDetails(accountData);

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
      await requestDataAndThrowParsedError(stub, 'fake-url', { headers: { Authentication: 'Bearer fake-tokinzes' } });
      sinon.assert.calledWith(stub, 'fake-url', { headers: { Authentication: 'Bearer fake-tokinzes' } });
    });

    it('should inject post data, if passed', async () => {
      await requestDataAndThrowParsedError(stub, 'fake-url', {
        data: { hasBody: true },
        headers: { Authentication: 'Bearer fake-tokinzes' },
      });
      sinon.assert.calledWith(
        stub,
        'fake-url',
        { hasBody: true },
        { headers: { Authentication: 'Bearer fake-tokinzes' } },
      );
    });

    it('should extract data from the response', async () => {
      stub.resolves({ data: { fake: true } });
      const response = await requestDataAndThrowParsedError(stub, 'fake-url', {
        headers: { Authentication: 'Bearer fake-tokinzes' },
      });
      expect(response).to.deep.equal({ fake: true });
    });

    it('should implement strong user authentication if requested', async () => {
      stub.onFirstCall().throws({
        response: {
          headers: {
            'x-2fa-approval-result': 'REJECTED',
            'x-2fa-approval': 'fake-token',
          },
        },
      });
      stub.onSecondCall().resolves({ data: true });

      await requestDataAndThrowParsedError(stub, 'fake-url', {
        data: { cool: 'beans' },
        headers: { Authentication: 'Bearer fake-tokinzes' },
      });

      const [url, data, options] = stub.secondCall.args;
      expect(url).to.equal('fake-url');
      expect(data).to.deep.equal({ cool: 'beans' });
      expect(options).to.have.property('headers');
      expect(options.headers).to.have.property('Authentication').equal('Bearer fake-tokinzes');
      expect(options.headers).to.have.property('x-2fa-approval').equal('fake-token');
      expect(options.headers).to.have.property('X-Signature');
    });
  });
});
