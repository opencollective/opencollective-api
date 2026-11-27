import { expect } from 'chai';
import { Plaid, PlaidEnvironment, PlaidError, PlaidTimeoutError } from 'plaid';

import { getPlaidEnvironment, getPlaidErrorData } from '../../../../server/lib/plaid/client';

describe('server/lib/plaid/client', () => {
  describe('getPlaidEnvironment', () => {
    it('maps the configured environment', () => {
      expect(getPlaidEnvironment('sandbox')).to.eq(PlaidEnvironment.Sandbox);
      expect(getPlaidEnvironment('production')).to.eq(PlaidEnvironment.Production);
    });

    it('uses sandbox in tests', () => {
      expect(getPlaidEnvironment()).to.eq(PlaidEnvironment.Sandbox);
    });

    it('throws on unknown environments rather than defaulting to production', () => {
      expect(() => getPlaidEnvironment('development')).to.throw('Invalid Plaid environment: development');
      expect(() => getPlaidEnvironment('')).to.throw('Invalid Plaid environment');
    });
  });

  describe('getPlaidErrorData', () => {
    /* eslint-disable camelcase */
    const plaidErrorBody = {
      error_type: 'ITEM_ERROR',
      error_code: 'ITEM_LOGIN_REQUIRED',
      error_message: 'the login details of this item have changed',
      display_message: null,
      request_id: 'request-id',
    } as Plaid.PlaidError;
    /* eslint-enable camelcase */

    it('returns the Plaid error payload for API errors', () => {
      expect(getPlaidErrorData(new Plaid.BadRequestError(plaidErrorBody))).to.deep.eq(plaidErrorBody);
      expect(getPlaidErrorData(new PlaidError({ statusCode: 403, body: plaidErrorBody }))).to.deep.eq(plaidErrorBody);
    });

    it('returns undefined when Plaid did not respond', () => {
      expect(getPlaidErrorData(new PlaidTimeoutError('Timeout'))).to.be.undefined;
      expect(getPlaidErrorData(new PlaidError({ message: 'fetch failed' }))).to.be.undefined;
      expect(getPlaidErrorData(new PlaidError({ statusCode: 502, body: '<html>Bad Gateway</html>' }))).to.be.undefined;
    });

    it('returns undefined for non-Plaid errors', () => {
      expect(getPlaidErrorData(new Error('Something else'))).to.be.undefined;
      expect(getPlaidErrorData({ response: { data: plaidErrorBody } })).to.be.undefined;
      expect(getPlaidErrorData(undefined)).to.be.undefined;
    });
  });
});
