import { expect } from 'chai';
import config from 'config';
import httpMocks from 'node-mocks-http';
import sinon from 'sinon';

import { search } from '../../../server/controllers/gitbook';

const makeRequest = (query: object) =>
  httpMocks.createRequest({
    method: 'GET',
    url: '/docs/search',
    query,
  });

describe('server/controllers/gitbook', () => {
  let fetchStub: sinon.SinonStub;

  beforeEach(() => {
    fetchStub = sinon.stub(globalThis, 'fetch').resolves({
      status: 200,
      json: () => Promise.resolve({ results: [] }),
    } as Response);
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('search', () => {
    it('sends the caller query as a single, encoded parameter', async () => {
      const query = 'expenses & taxes #23 at 100%';
      const response = httpMocks.createResponse();

      await search(makeRequest({ query }), response);

      expect(fetchStub).to.have.been.calledOnce;
      const url = new URL(String(fetchStub.firstCall.args[0]));
      expect(url.origin).to.equal(config.get('gitbook.apiUrl'));
      expect(url.pathname).to.equal(`/v1/spaces/${config.get('gitbook.spaceId')}/search`);
      expect(Array.from(url.searchParams.keys())).to.deep.equal(['query']);
      expect(url.searchParams.getAll('query')).to.deep.equal([query]);
    });

    it('keeps the GitBook API key in the Authorization header', async () => {
      const response = httpMocks.createResponse();

      await search(makeRequest({ query: 'hosting fees' }), response);

      expect(fetchStub.firstCall.args[1]?.method).to.equal('GET');
      expect(fetchStub.firstCall.args[1]?.headers).to.deep.equal({
        Authorization: `Bearer ${config.get('gitbook.apiKey')}`,
      });
    });

    it('forwards the upstream status and body', async () => {
      const response = httpMocks.createResponse();

      await search(makeRequest({ query: 'hosting fees' }), response);

      expect(response._getStatusCode()).to.equal(200);
      expect(response._getData()).to.deep.equal({ results: [] });
    });

    it('returns 400 if the query is missing', async () => {
      const response = httpMocks.createResponse();

      await search(makeRequest({}), response);

      expect(response._getStatusCode()).to.equal(400);
      expect(fetchStub).to.not.have.been.called;
    });

    it('returns 400 if the query is not a string', async () => {
      const response = httpMocks.createResponse();

      await search(makeRequest({ query: ['backers', 'sponsors'] }), response);

      expect(response._getStatusCode()).to.equal(400);
      expect(fetchStub).to.not.have.been.called;
    });
  });
});
