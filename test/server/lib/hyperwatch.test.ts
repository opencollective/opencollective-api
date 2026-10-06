import hyperwatch from '@hyperwatch/hyperwatch';
import { expect } from 'chai';

import { removeCredentials } from '../../../server/lib/hyperwatch';

// Logs built like the middleware does: createLog from the request, then the GraphQL body
const createLog = ({
  url = '/graphql/v2',
  headers = {},
  body,
}: {
  url?: string;
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
}) => {
  const log = hyperwatch.util.createLog({ ip: '1.2.3.4', method: 'POST', url, headers }, { statusCode: 200 });
  return body ? log.set('graphql', body) : log;
};

describe('server/lib/hyperwatch', () => {
  describe('removeCredentials', () => {
    it('removes the credential headers and keeps the others', () => {
      const log = removeCredentials(
        createLog({
          headers: {
            authorization: 'Bearer jwt',
            cookie: 'accessToken=jwt',
            'personal-token': 'personal',
            'api-key': 'key',
            'service-key': 'key',
            'user-agent': 'opencollective-pdf/1.0',
            'oc-application': 'pdf',
          },
        }),
      );

      expect(log.getIn(['request', 'headers']).toJS()).to.deep.equal({
        'user-agent': 'opencollective-pdf/1.0',
        'oc-application': 'pdf',
      });
    });

    it('replaces the credentials in the query string and keeps the rest of the URL', () => {
      const log = removeCredentials(
        createLog({ url: '/graphql/v2?api_key=key&foo=a%20b&apiKey=key&personalToken=personal#x' }),
      );

      expect(log.getIn(['request', 'url'])).to.equal(
        '/graphql/v2?api_key=[Filtered]&foo=a%20b&apiKey=[Filtered]&personalToken=[Filtered]#x',
      );
    });

    it('removes the service key from the GraphQL body', () => {
      // eslint-disable-next-line camelcase
      const log = removeCredentials(createLog({ body: { query: '{ me { id } }', variables: {}, api_key: 'key' } }));

      expect(log.getIn(['graphql', 'api_key'])).to.be.undefined;
      expect(log.getIn(['graphql', 'query'])).to.equal('{ me { id } }');
    });

    it('leaves logs without credentials as they are', () => {
      const log = createLog({
        url: '/graphql/v2?foo=bar',
        headers: { 'user-agent': 'curl' },
        body: { query: '{ me { id } }' },
      });
      expect(removeCredentials(log).equals(log)).to.be.true;
    });
  });
});
