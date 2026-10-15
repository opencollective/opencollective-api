import { expect } from 'chai';
import httpMocks from 'node-mocks-http';
import sinon from 'sinon';

import { getRepositoryInfo } from '../../../server/controllers/ecosystems';
import cache from '../../../server/lib/cache';
import RateLimit from '../../../server/lib/rate-limit';

/* eslint-disable camelcase -- ecosyste.ms API fields are snake_case */

const REPO_URL = 'https://github.com/opencollective/opencollective-frontend';

const REPOSITORY_METADATA = {
  full_name: 'opencollective/opencollective-frontend',
  owner: 'opencollective',
  description: 'The frontend',
  license: 'mit',
};

/** Replies with the appropriate upstream body for each ecosyste.ms endpoint */
const stubEcosystemsFetch = (sandbox: sinon.SinonSandbox) =>
  sandbox.stub(globalThis, 'fetch').callsFake(async (input: any) => {
    const url = String(input);
    let body;
    if (url.includes('packages.ecosyste.ms')) {
      body = [];
    } else if (url.includes('commits.ecosyste.ms')) {
      body = { total_commits: 10 };
    } else if (url.includes('issues.ecosyste.ms')) {
      body = { issues_count: 3 };
    } else if (url.includes('/hosts/')) {
      body = { login: 'opencollective' };
    } else {
      body = REPOSITORY_METADATA;
    }

    return { ok: true, status: 200, json: () => Promise.resolve(body) } as Response;
  });

const EXPECTED_ENTRY = {
  packages: [],
  repository: REPOSITORY_METADATA,
  contributors: { total_commits: 10 },
  issues: { issues_count: 3 },
  owner: { login: 'opencollective' },
};

const makeRequest = (query: object) =>
  httpMocks.createRequest({
    method: 'GET',
    url: '/ecosystems/repository',
    query,
  });

describe('server/controllers/ecosystems', () => {
  let sandbox: sinon.SinonSandbox;
  let registerCallStub: sinon.SinonStub;

  beforeEach(async () => {
    sandbox = sinon.createSandbox();
    await cache.clear();
    registerCallStub = sandbox.stub(RateLimit.prototype, 'registerCall').resolves(true);
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('getRepositoryInfo', () => {
    it('returns 400 when the url is missing or invalid', async () => {
      const fetchStub = stubEcosystemsFetch(sandbox);

      for (const query of [{}, { url: 'not-a-url' }, { url: ['https://github.com/foo/bar'] }]) {
        const response = httpMocks.createResponse();
        await getRepositoryInfo(makeRequest(query), response);
        expect(response._getStatusCode()).to.equal(400);
      }

      expect(fetchStub).to.not.have.been.called;
    });

    it('replies with the RepoCacheEntry for the requested repository', async () => {
      stubEcosystemsFetch(sandbox);

      const response = httpMocks.createResponse();
      await getRepositoryInfo(makeRequest({ url: REPO_URL }), response);

      expect(response._getStatusCode()).to.equal(200);
      expect(response._getData()).to.deep.equal(EXPECTED_ENTRY);
    });

    it('caches the upstream response for a same repository URL', async () => {
      const fetchStub = stubEcosystemsFetch(sandbox);

      const firstResponse = httpMocks.createResponse();
      await getRepositoryInfo(makeRequest({ url: REPO_URL }), firstResponse);
      const upstreamCallsCount = fetchStub.callCount;

      const secondResponse = httpMocks.createResponse();
      await getRepositoryInfo(makeRequest({ url: `${REPO_URL}/` }), secondResponse);

      expect(firstResponse._getStatusCode()).to.equal(200);
      expect(secondResponse._getStatusCode()).to.equal(200);
      expect(secondResponse._getData()).to.deep.equal(EXPECTED_ENTRY);
      expect(upstreamCallsCount).to.be.greaterThan(0);
      expect(fetchStub.callCount).to.equal(upstreamCallsCount); // Served from the cache, no extra upstream call
    });

    it('returns 429 when the rate limit is reached', async () => {
      registerCallStub.resolves(false);
      const fetchStub = stubEcosystemsFetch(sandbox);

      const response = httpMocks.createResponse();
      await getRepositoryInfo(makeRequest({ url: REPO_URL }), response);

      expect(response._getStatusCode()).to.equal(429);
      expect(response._getData().error.type).to.equal('rate_limit_exceeded');
      expect(fetchStub).to.not.have.been.called;
    });

    it('returns 502 when the upstream request fails', async () => {
      sandbox.stub(globalThis, 'fetch').rejects(new Error('ecosyste.ms is down'));

      const response = httpMocks.createResponse();
      await getRepositoryInfo(makeRequest({ url: REPO_URL }), response);

      expect(response._getStatusCode()).to.equal(502);
      expect(response._getData().error.type).to.equal('bad_gateway');
    });
  });
});
