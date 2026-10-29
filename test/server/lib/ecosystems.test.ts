import { expect } from 'chai';
import sinon from 'sinon';

import {
  EcosystemsPackage,
  fetchRepoSummary,
  fetchRepoSummaryWithStatus,
  findRepoMetadata,
  normalizeRepoKey,
  RepoMetadata,
} from '../../../server/lib/ecosystems';

/* eslint-disable camelcase -- ecosyste.ms API fields are snake_case */

type MockRoute = {
  match: (url: string) => boolean;
  status?: number;
  body?: unknown;
};

const mockEcosystemsFetch = (routes: MockRoute[]) =>
  sinon.stub(globalThis, 'fetch').callsFake(async (input: any, init?: any) => {
    const url = String(input);
    const route = routes.find(r => r.match(url));
    if (!route) {
      throw new Error(`Unexpected fetch in test: ${url} (${init?.method || 'GET'})`);
    }
    const status = route.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(route.body),
    } as Response;
  });

const PACKAGES_ROUTE: MockRoute = {
  match: url => url.includes('packages.ecosyste.ms') && url.includes('/packages/bulk_lookup'),
  body: [],
};
const REPOSITORY_ROUTE: MockRoute = {
  match: url => url.includes('repos.ecosyste.ms') && url.includes('/repositories/lookup'),
  body: null,
};
const COMMITS_ROUTE: MockRoute = {
  match: url => url.includes('commits.ecosyste.ms') && url.includes('/repositories/lookup'),
  body: null,
};
const ISSUES_ROUTE: MockRoute = {
  match: url => url.includes('issues.ecosyste.ms') && url.includes('/repositories/lookup'),
  body: null,
};
const OWNER_ROUTE: MockRoute = {
  match: url => url.includes('repos.ecosyste.ms') && url.includes('/hosts/GitHub/owners/'),
  body: null,
};

const REPO_URL = 'https://github.com/opencollective/opencollective-frontend';

const REPO_METADATA = {
  full_name: 'opencollective/opencollective-frontend',
  owner: 'opencollective',
  host: { name: 'GitHub' },
  description: 'The frontend',
  stargazers_count: 900,
  forks_count: 450,
  pushed_at: '2026-10-11T11:24:07.000Z',
  created_at: '2016-12-12T04:36:39.000Z',
  license: 'mit',
  archived: false,
  fork: false,
  commit_stats: { total_commits: 12872, total_committers: 165, last_synced_commit: 'abc123' },
};

const PACKAGE = {
  name: '@opencollective/frontend-components',
  ecosystem: 'npm',
  description: null,
  repository_url: REPO_URL,
  downloads: 193,
  dependent_packages_count: 1,
  dependent_repos_count: 2,
  first_release_published_at: '2022-10-18T15:23:27.142Z',
  latest_release_published_at: '2024-02-19T10:55:30.669Z',
  maintainers: [{ login: 'betree', name: null }],
  repo_metadata: REPO_METADATA,
} as unknown as EcosystemsPackage;

describe('server/lib/ecosystems', () => {
  let fetchStub: sinon.SinonStub;

  beforeEach(() => {
    delete process.env.ECOSYSTEMS_API_KEY;
    delete process.env.ECOSYSTEMS_TOKEN;
  });

  afterEach(() => {
    delete process.env.ECOSYSTEMS_API_KEY;
    delete process.env.ECOSYSTEMS_TOKEN;
    if (fetchStub) {
      fetchStub.restore();
      fetchStub = null;
    }
  });

  describe('normalizeRepoKey', () => {
    it('normalizes protocol, www, trailing slashes and .git suffixes', () => {
      expect(normalizeRepoKey('https://www.github.com/Foo/Bar.git/')).to.equal('github.com/foo/bar');
      expect(normalizeRepoKey('http://gitlab.com/foo/bar/')).to.equal('gitlab.com/foo/bar');
      expect(normalizeRepoKey('not a url')).to.equal('not a url');
    });
  });

  describe('findRepoMetadata', () => {
    it('returns the first non-empty repo_metadata', () => {
      const packages = [
        { repo_metadata: null },
        { repo_metadata: {} },
        { repo_metadata: REPO_METADATA as RepoMetadata },
      ] as EcosystemsPackage[];
      expect(findRepoMetadata(packages)).to.deep.equal(REPO_METADATA);
      expect(findRepoMetadata([{ repo_metadata: null }] as EcosystemsPackage[])).to.be.null;
    });
  });

  describe('fetchRepoSummary', () => {
    it('requests a single repository URL and returns it as a EcosystemsRepoSummary', async () => {
      fetchStub = mockEcosystemsFetch([
        {
          match: PACKAGES_ROUTE.match,
          body: [PACKAGE],
        },
        {
          match: COMMITS_ROUTE.match,
          body: { full_name: 'opencollective/opencollective-frontend', total_commits: 10 },
        },
        { match: ISSUES_ROUTE.match, body: { full_name: 'opencollective/opencollective-frontend', issues_count: 3 } },
        { match: OWNER_ROUTE.match, body: { login: 'opencollective', name: 'Open Collective' } },
      ]);

      const entry = await fetchRepoSummary(REPO_URL);

      // The entry has the same structure as the POC's EcosystemsRepoSummary
      expect(Object.keys(entry).sort()).to.deep.equal(['contributors', 'issues', 'owner', 'packages', 'repository']);
      expect(entry.packages).to.deep.equal([PACKAGE]);
      expect(entry.repository).to.deep.equal(REPO_METADATA); // Resolved from the package's repo_metadata
      expect(entry.contributors).to.deep.equal({
        full_name: 'opencollective/opencollective-frontend',
        total_commits: 10,
      });
      expect(entry.issues).to.deep.equal({ full_name: 'opencollective/opencollective-frontend', issues_count: 3 });
      expect(entry.owner).to.deep.equal({ login: 'opencollective', name: 'Open Collective' });

      // A single repo is requested (no list of URLs), and the owner is resolved from the repo host/owner
      const packagesCall = fetchStub.getCalls().find(call => PACKAGES_ROUTE.match(String(call.args[0])));
      expect(packagesCall.args[1].method).to.equal('POST');
      expect(JSON.parse(packagesCall.args[1].body)).to.deep.equal({ repository_urls: [REPO_URL] });

      const ownerCall = fetchStub.getCalls().find(call => OWNER_ROUTE.match(String(call.args[0])));
      expect(String(ownerCall.args[0])).to.contain('/hosts/GitHub/owners/opencollective');
    });

    it('sends the ecosystems token as a bearer token when configured', async () => {
      process.env.ECOSYSTEMS_API_KEY = 'test-token';
      fetchStub = mockEcosystemsFetch([
        { match: PACKAGES_ROUTE.match, body: [PACKAGE] },
        {
          match: COMMITS_ROUTE.match,
          body: { full_name: 'opencollective/opencollective-frontend', total_commits: 10 },
        },
        { match: ISSUES_ROUTE.match, body: { full_name: 'opencollective/opencollective-frontend', issues_count: 3 } },
        { match: OWNER_ROUTE.match, body: { login: 'opencollective', name: 'Open Collective' } },
      ]);

      await fetchRepoSummary(REPO_URL);

      for (const call of fetchStub.getCalls()) {
        expect(call.args[1].headers.Authorization).to.equal('Bearer test-token');
      }
    });

    it('falls back to the repos lookup for repository metadata when the repo has no package', async () => {
      fetchStub = mockEcosystemsFetch([
        PACKAGES_ROUTE,
        { match: REPOSITORY_ROUTE.match, body: REPO_METADATA },
        COMMITS_ROUTE,
        ISSUES_ROUTE,
        OWNER_ROUTE,
      ]);

      const entry = await fetchRepoSummary(REPO_URL);

      expect(entry.packages).to.deep.equal([]);
      expect(entry.repository).to.deep.equal(REPO_METADATA);
    });

    it('returns null sections for lookups that reply 404', async () => {
      fetchStub = mockEcosystemsFetch([
        PACKAGES_ROUTE,
        { match: REPOSITORY_ROUTE.match, status: 404, body: { error: 'not found' } },
        { match: COMMITS_ROUTE.match, status: 404, body: { error: 'not found' } },
        { match: ISSUES_ROUTE.match, status: 404, body: { error: 'not found' } },
        { match: OWNER_ROUTE.match, status: 404, body: { error: 'not found' } },
      ]);

      const entry = await fetchRepoSummary(REPO_URL);

      expect(entry).to.deep.equal({ packages: [], repository: null, contributors: null, issues: null, owner: null });
    });

    it('tolerates secondary lookup failures', async () => {
      fetchStub = mockEcosystemsFetch([
        { match: PACKAGES_ROUTE.match, body: [PACKAGE] },
        REPOSITORY_ROUTE,
        { match: COMMITS_ROUTE.match, status: 500, body: { error: 'boom' } },
        { match: ISSUES_ROUTE.match, status: 500, body: { error: 'boom' } },
        { match: OWNER_ROUTE.match, status: 500, body: { error: 'boom' } },
      ]);

      const entry = await fetchRepoSummary(REPO_URL);

      expect(entry.repository).to.deep.equal(REPO_METADATA);
      expect(entry.contributors).to.be.null;
      expect(entry.issues).to.be.null;
      expect(entry.owner).to.be.null;
    });

    it('reports secondary lookup failures so callers can avoid caching a partial summary', async () => {
      fetchStub = mockEcosystemsFetch([
        { match: PACKAGES_ROUTE.match, body: [PACKAGE] },
        REPOSITORY_ROUTE,
        { match: COMMITS_ROUTE.match, status: 500, body: { error: 'boom' } },
        ISSUES_ROUTE,
        OWNER_ROUTE,
      ]);

      const { summary, isComplete } = await fetchRepoSummaryWithStatus(REPO_URL);

      expect(summary.repository).to.deep.equal(REPO_METADATA);
      expect(summary.contributors).to.be.null;
      expect(isComplete).to.be.false;

      // A complete summary is reported as such
      fetchStub.restore();
      fetchStub = mockEcosystemsFetch([
        { match: PACKAGES_ROUTE.match, body: [PACKAGE] },
        REPOSITORY_ROUTE,
        COMMITS_ROUTE,
        ISSUES_ROUTE,
        OWNER_ROUTE,
      ]);
      const complete = await fetchRepoSummaryWithStatus(REPO_URL);
      expect(complete.isComplete).to.be.true;
    });

    it('throws when a core repository lookup fails', async () => {
      fetchStub = mockEcosystemsFetch([
        PACKAGES_ROUTE,
        { match: REPOSITORY_ROUTE.match, status: 500, body: { error: 'boom' } },
        COMMITS_ROUTE,
        ISSUES_ROUTE,
        OWNER_ROUTE,
      ]);

      await expect(fetchRepoSummary(REPO_URL)).to.be.rejectedWith('ecosyste.ms request failed with status 500');
    });
  });
});
