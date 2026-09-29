import { expect } from 'chai';
import config from 'config';
import { stub } from 'sinon';

import { ValidationFailed } from '../../../server/graphql/errors';
import {
  areHttpRedirectUrisAllowed,
  assertOAuthRedirectUri,
  parseNavigableHttpUrl,
} from '../../../server/lib/url-validation';

describe('server/lib/url-validation', () => {
  describe('parseNavigableHttpUrl', () => {
    it('accepts http and https URLs', () => {
      expect(parseNavigableHttpUrl('https://example.com/callback').toString()).to.equal('https://example.com/callback');
      expect(parseNavigableHttpUrl('http://localhost:3000/callback').toString()).to.equal(
        'http://localhost:3000/callback',
      );
    });

    it('rejects javascript:, data:, blob:, and other non-http(s) schemes', () => {
      const invalid = [
        'javascript:alert(1)',
        'data:text/html,hello',
        'blob:https://example.com/uuid',
        'ftp://files.example.com/file',
        'file:///etc/passwd',
      ];

      for (const value of invalid) {
        expect(() => parseNavigableHttpUrl(value))
          .to.throw(ValidationFailed)
          .with.property('message', `URL must use HTTP or HTTPS: ${value}`);
      }
    });

    it('rejects invalid URLs and non-strings', () => {
      expect(() => parseNavigableHttpUrl('not-a-url'))
        .to.throw(ValidationFailed)
        .with.property('message', 'Not a valid URL: not-a-url');
      expect(() => parseNavigableHttpUrl(123))
        .to.throw(ValidationFailed)
        .with.property('message', 'Not a valid URL: 123');
    });

    it('rejects http when allowHttp is false', () => {
      expect(() => parseNavigableHttpUrl('http://localhost/callback', { allowHttp: false }))
        .to.throw(ValidationFailed)
        .with.property('message', 'URL must use HTTPS: http://localhost/callback');
      expect(parseNavigableHttpUrl('https://example.com/callback', { allowHttp: false }).protocol).to.equal('https:');
    });
  });

  describe('assertOAuthRedirectUri', () => {
    it('allows https redirect URIs', () => {
      expect(assertOAuthRedirectUri('https://example.com/callback')).to.equal('https://example.com/callback');
    });

    it('allows http redirect URIs outside production', () => {
      expect(areHttpRedirectUrisAllowed()).to.equal(true);
      expect(assertOAuthRedirectUri('http://localhost:3000/callback')).to.equal('http://localhost:3000/callback');
    });

    it('rejects javascript: and data: redirect URIs', () => {
      expect(() => assertOAuthRedirectUri('javascript:alert(document.domain)')).to.throw(ValidationFailed);
      expect(() => assertOAuthRedirectUri('data:text/html,<script>alert(1)</script>')).to.throw(ValidationFailed);
      expect(() => assertOAuthRedirectUri('javascript://example.com/%0aalert(1)')).to.throw(ValidationFailed);
    });

    it('rejects http redirect URIs in production', () => {
      const envStub = stub(config, 'env').value('production');
      try {
        expect(areHttpRedirectUrisAllowed()).to.equal(false);
        expect(() => assertOAuthRedirectUri('http://localhost:3000/callback'))
          .to.throw(ValidationFailed)
          .with.property('message', 'URL must use HTTPS: http://localhost:3000/callback');
        expect(assertOAuthRedirectUri('https://example.com/callback')).to.equal('https://example.com/callback');
      } finally {
        envStub.restore();
      }
    });
  });
});
