import { expect } from 'chai';

import { isSensitiveHeader, redactHeaders, redactUrl, redactVariables } from '../../../server/lib/hyperwatch-redaction';

describe('server/lib/hyperwatch-redaction', () => {
  describe('headers', () => {
    it('removes credentials and keeps the rest', () => {
      const headers = {
        accept: 'application/json',
        'user-agent': 'Mozilla/5.0',
        'x-forwarded-for': '1.2.3.4',
        'oc-secret': 'service-key',
        cookie: 'accessToken=xxx',
        authorization: 'Bearer xxx',
        'proxy-authorization': 'Basic xxx',
        'api-key': 'xxx',
        'personal-token': 'xxx',
        'x-two-factor-authentication': 'totp xxx',
        'x-xsrf-token': 'xxx',
        'x-session-id': 'xxx',
        'x-api_key': 'xxx',
        'plaid-secret': 'xxx',
        'x-password': 'xxx',
        referer: 'https://opencollective.com/signin?token=abc&next=%2Fdashboard',
      };

      expect(redactHeaders(headers)).to.deep.equal({
        accept: 'application/json',
        'user-agent': 'Mozilla/5.0',
        'x-forwarded-for': '1.2.3.4',
        'oc-secret': 'service-key',
        referer: 'https://opencollective.com/signin?token=%5Bredacted%5D&next=%2Fdashboard',
      });
    });

    it('is case-insensitive and keeps oc-secret', () => {
      expect(isSensitiveHeader('Authorization')).to.be.true;
      expect(isSensitiveHeader('Personal-Token')).to.be.true;
      expect(isSensitiveHeader('OC-Secret')).to.be.false;
      expect(isSensitiveHeader('content-type')).to.be.false;
    });
  });

  describe('variables', () => {
    it('redacts nested inputs and arrays, keeping the shape', () => {
      const variables = {
        order: {
          amount: { valueInCents: 5000, currency: 'USD' },
          toAccount: { slug: 'webpack' },
          guestInfo: {
            email: 'jane@example.com',
            name: 'Jane Doe',
            captcha: { token: 'captcha-token', provider: 'HCAPTCHA' },
          },
          fromAccountInfo: {
            legalName: 'Jane Doe Inc',
            location: { address: '1 Main St', city: 'Paris', postalCode: '75001', country: 'FR' },
          },
          tags: ['foo', 'bar'],
          customData: [{ email: 'a@example.com' }, { email: 'b@example.com', id: 1 }],
        },
        expense: {
          description: 'Invoice',
          privateMessage: 'Bank details',
          payoutMethod: { type: 'BANK_ACCOUNT', data: { accountHolderName: 'Jane', details: { IBAN: 'FR76' } } },
        },
        twoFactorAuthenticatorCode: '123456',
        accessToken: 'xxx',
        emails: ['a@example.com'],
        html: '<p>Hi</p>',
        nullable: null,
        limit: 10,
        slug: 'webpack',
        orderBy: { field: 'CREATED_AT', direction: 'DESC' },
      };
      const original = JSON.parse(JSON.stringify(variables));

      expect(redactVariables(variables)).to.deep.equal({
        order: {
          amount: { valueInCents: 5000, currency: 'USD' },
          toAccount: { slug: 'webpack' },
          guestInfo: {
            email: '[redacted]',
            name: 'Jane Doe',
            captcha: '[redacted]',
          },
          fromAccountInfo: {
            legalName: '[redacted]',
            location: '[redacted]',
          },
          tags: ['foo', 'bar'],
          customData: [{ email: '[redacted]' }, { email: '[redacted]', id: 1 }],
        },
        expense: {
          description: 'Invoice',
          privateMessage: '[redacted]',
          payoutMethod: {
            type: 'BANK_ACCOUNT',
            data: { accountHolderName: '[redacted]', details: { IBAN: '[redacted]' } },
          },
        },
        twoFactorAuthenticatorCode: '[redacted]',
        accessToken: '[redacted]',
        emails: '[redacted]',
        html: '[redacted]',
        nullable: null,
        limit: 10,
        slug: 'webpack',
        orderBy: { field: 'CREATED_AT', direction: 'DESC' },
      });

      // Does not mutate the input
      expect(variables).to.deep.equal(original);
    });

    it('redacts compound and plural keys', () => {
      expect(
        redactVariables({
          'legal-name': 'Jane Doe Inc',
          contactFirstName: 'Jane',
          payeeLegalName: 'Jane Doe Inc',
          addresses: ['1 Main St'],
          cities: ['Paris'],
          name: 'Jane',
          description: 'Public',
        }),
      ).to.deep.equal({
        'legal-name': '[redacted]',
        contactFirstName: '[redacted]',
        payeeLegalName: '[redacted]',
        addresses: '[redacted]',
        cities: '[redacted]',
        name: 'Jane',
        description: 'Public',
      });
    });

    it('redacts draft keys and the financial fields mutations accept', () => {
      expect(
        redactVariables({
          draftKey: 'draft-key',
          virtualCard: { privateData: { cardNumber: '4242', expiryDate: '12/30', cvv: '123' } },
          payoutMethod: {
            data: {
              currency: 'USD',
              details: {
                abartn: '026009593',
                bankCode: 'xxx',
                bsbCode: 'xxx',
                customerReferenceNumber: 'xxx',
                idDocumentNumber: 'xxx',
                idDocumentType: 'passport',
                identificationNumber: 'xxx',
                ifscCode: 'xxx',
                institutionNumber: 'xxx',
                interacAccount: 'xxx',
                sortCode: 'xxx',
                transitNumber: 'xxx',
              },
            },
          },
        }),
      ).to.deep.equal({
        draftKey: '[redacted]',
        virtualCard: { privateData: { cardNumber: '[redacted]', expiryDate: '12/30', cvv: '[redacted]' } },
        payoutMethod: {
          data: {
            currency: 'USD',
            details: {
              abartn: '[redacted]',
              bankCode: '[redacted]',
              bsbCode: '[redacted]',
              customerReferenceNumber: '[redacted]',
              idDocumentNumber: '[redacted]',
              idDocumentType: '[redacted]',
              identificationNumber: '[redacted]',
              ifscCode: '[redacted]',
              institutionNumber: '[redacted]',
              interacAccount: '[redacted]',
              sortCode: '[redacted]',
              transitNumber: '[redacted]',
            },
          },
        },
      });
    });

    it('handles long keys in linear time', () => {
      const key = Array.from({ length: 3000 }, () => 'aB').join('');
      const start = Date.now();
      expect(redactVariables({ [key]: 'x' })).to.deep.equal({ [key]: 'x' });
      expect(Date.now() - start).to.be.below(1000);
    });

    it('redacts what is nested too deep to inspect', () => {
      let variables: Record<string, unknown> = { slug: 'webpack' };
      for (let i = 0; i < 20000; i++) {
        variables = { input: variables };
      }
      let result = redactVariables(variables);
      let depth = 0;
      while (result && typeof result === 'object' && 'input' in result) {
        result = result.input as Record<string, unknown>;
        depth++;
      }
      expect(result).to.equal('[redacted]');
      expect(depth).to.be.below(100);
    });

    it('leaves non-objects untouched', () => {
      expect(redactVariables(undefined)).to.be.undefined;
      expect(redactVariables(null)).to.be.null;
      expect(redactVariables('string')).to.equal('string');
    });
  });

  describe('URLs', () => {
    it('redacts sensitive query string parameters', () => {
      expect(redactUrl('/signin/verify?token=abc&next=%2Fdashboard')).to.equal(
        '/signin/verify?token=%5Bredacted%5D&next=%2Fdashboard',
      );
      expect(redactUrl('/users/signin?email=jane%40example.com&code=123456&slug=webpack')).to.equal(
        '/users/signin?email=%5Bredacted%5D&code=%5Bredacted%5D&slug=webpack',
      );
      expect(redactUrl('/connected-accounts/stripe/callback?api_key=xxx&state=1')).to.equal(
        '/connected-accounts/stripe/callback?api_key=%5Bredacted%5D&state=1',
      );
    });

    it('redacts GraphQL variables passed in the query string', () => {
      const variables = encodeURIComponent(JSON.stringify({ slug: 'webpack', email: 'jane@example.com' }));
      expect(redactUrl(`/graphql/v2?operationName=Account&variables=${variables}`)).to.equal(
        '/graphql/v2?operationName=Account&variables=%7B%22slug%22%3A%22webpack%22%2C%22email%22%3A%22%5Bredacted%5D%22%7D',
      );
    });

    it('redacts GraphQL variables that are not valid JSON', () => {
      expect(redactUrl('/graphql/v2?operationName=Account&variables=%7B%22email%22%3A%22jane%40example.com')).to.equal(
        '/graphql/v2?operationName=Account&variables=%5Bredacted%5D',
      );
    });

    it('redacts GraphQL variables that are valid JSON but not an object', () => {
      expect(redactUrl('/graphql/v2?variables=%22token%3Dsecret%22')).to.equal('/graphql/v2?variables=%5Bredacted%5D');
      expect(redactUrl('/graphql/v2?variables=%5B%22secret%22%5D')).to.equal('/graphql/v2?variables=%5Bredacted%5D');
      expect(redactUrl('/graphql/v2?variables=null')).to.equal('/graphql/v2?variables=%5Bredacted%5D');
    });

    it('redacts kebab-case API key parameters', () => {
      expect(redactUrl('/webpack.json?api-key=secret&limit=10')).to.equal(
        '/webpack.json?api-key=%5Bredacted%5D&limit=10',
      );
      expect(redactUrl('/webpack.json?apiKey=secret')).to.equal('/webpack.json?apiKey=%5Bredacted%5D');
    });

    it('redacts draft keys and expense permalink keys', () => {
      expect(redactUrl('/search?legal_name=Jane&slug=webpack')).to.equal(
        '/search?legal_name=%5Bredacted%5D&slug=webpack',
      );
      expect(redactUrl('/files/abc?expenseId=1&draftKey=xxx')).to.equal(
        '/files/abc?expenseId=1&draftKey=%5Bredacted%5D',
      );
      expect(redactUrl('https://opencollective.com/webpack/expenses/1?key=xxx&edit=1')).to.equal(
        'https://opencollective.com/webpack/expenses/1?key=%5Bredacted%5D&edit=1',
      );
    });

    it('redacts credentials and personal data from the path', () => {
      expect(redactUrl('/graphql/v1/0123456789abcdef')).to.equal('/graphql/v1/[redacted]');
      expect(redactUrl('/graphql/0123456789abcdef?opName=Account')).to.equal('/graphql/[redacted]?opName=Account');
      expect(
        redactUrl('/services/email/unsubscribe/jane%40example.com/webpack/collective.expense.created/abc'),
      ).to.equal('/services/email/unsubscribe/[redacted]/webpack/collective.expense.created/[redacted]');
    });

    it('keeps URLs without sensitive parameters as they are', () => {
      expect(redactUrl('/graphql')).to.equal('/graphql');
      expect(redactUrl('/graphql/v2')).to.equal('/graphql/v2');
      expect(redactUrl('/graphql/v2?opName=Account&slug=webpack')).to.equal('/graphql/v2?opName=Account&slug=webpack');
      expect(redactUrl('/graphql?opName=Account&slug=webpack')).to.equal('/graphql?opName=Account&slug=webpack');
      expect(redactUrl('/webpack/members.json?limit=10')).to.equal('/webpack/members.json?limit=10');
    });
  });
});
