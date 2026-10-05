import hyperwatch from '@hyperwatch/hyperwatch';
import { expect } from 'chai';

import { removeCredentials } from '../../../server/lib/hyperwatch';

// Logs built like the middleware does: createLog from the request, then the GraphQL body
const createLog = (headers, body) => {
  const log = hyperwatch.util.createLog(
    { ip: '1.2.3.4', method: 'POST', url: '/graphql/v2', headers },
    { statusCode: 200 },
  );
  return body ? log.set('graphql', body) : log;
};

describe('server/lib/hyperwatch', () => {
  describe('removeCredentials', () => {
    it('removes the credential headers and keeps the others', () => {
      const log = removeCredentials(
        createLog({
          authorization: 'Bearer jwt',
          cookie: 'accessToken=jwt',
          'personal-token': 'personal',
          'api-key': 'key',
          'service-key': 'key',
          'user-agent': 'opencollective-pdf/1.0',
          'oc-application': 'pdf',
        }),
      );

      expect(log.getIn(['request', 'headers']).toJS()).to.deep.equal({
        'user-agent': 'opencollective-pdf/1.0',
        'oc-application': 'pdf',
      });
    });

    it('removes the internal API key from the GraphQL body', () => {
      // eslint-disable-next-line camelcase
      const log = removeCredentials(createLog({}, { query: '{ me { id } }', variables: {}, api_key: 'key' }));

      expect(log.getIn(['graphql', 'api_key'])).to.be.undefined;
      expect(log.getIn(['graphql', 'query'])).to.equal('{ me { id } }');
    });

    it('leaves logs without credentials as they are', () => {
      const log = createLog({ 'user-agent': 'curl' }, { query: '{ me { id } }' });
      expect(removeCredentials(log).equals(log)).to.be.true;
    });
  });
});
