import { expect } from 'chai';

import URLResolver from '../../../../../server/graphql/v2/scalar/URL';

/** testing only parseValue because that is where the validation occurs
 * picked testcases from https://github.com/Urigo/graphql-scalars/blob/master/tests/URL.test.ts
 */
describe('server/graphql/v2/scalar/URL', () => {
  describe('throws an error', () => {
    it('when url is invalid', () => {
      expect(() => URLResolver.parseValue('invalidurlexample')).throw('Not a valid URL: invalidurlexample');
    });

    it('when url provided is not a string', () => {
      expect(() => URLResolver.parseValue(123)).throw('Not a valid URL: 123');
    });
  });

  describe('passes URL validation ', () => {
    it('when url is a valid locahost url', () => {
      expect(URLResolver.parseValue('http://localhost/')).to.equal('http://localhost/');
    });

    it('when url is a valid locahost url with port number', () => {
      expect(URLResolver.parseValue('http://localhost:3000/')).to.equal('http://localhost:3000/');
    });

    it('when url is a valid non locahost url', () => {
      expect(URLResolver.parseValue('http://localhost/')).to.equal('http://localhost/');
    });
  });
});
