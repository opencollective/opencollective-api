const ECOSYSTEMS_API_URL = 'https://packages.ecosyste.ms/api/v1';
const ECOSYSTEMS_REPOS_API_URL = 'https://repos.ecosyste.ms/api/v1';
const ECOSYSTEMS_COMMITS_API_URL = 'https://commits.ecosyste.ms/api/v1';
const ECOSYSTEMS_ISSUES_API_URL = 'https://issues.ecosyste.ms/api/v1';

const ECOSYSTEMS_REQUEST_TIMEOUT_MS = 20 * 1000;

/** Optional API key, sent as `Authorization: Bearer` (ecosyste.ms paid/hosted tiers) */
function getEcosystemsHeaders(): Record<string, string> {
  const token = (process.env.ECOSYSTEMS_API_KEY || process.env.ECOSYSTEMS_TOKEN)?.trim();
  return {
    'Content-Type': 'application/json',
    'User-Agent': 'opencollective-api',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

export type RepoMetadata = {
  full_name?: string;
  owner?: string | null;
  host?: { name?: string | null } | null;
  description: string | null;
  stargazers_count?: number;
  forks_count?: number;
  open_issues_count?: number;
  pushed_at?: string;
  created_at?: string;
  license: string | null;
  topics?: string[] | null;
  archived?: boolean;
  fork?: boolean;
  commit_stats?: { total_commits: number; total_committers: number; last_synced_commit?: string | null };
};

export type EcosystemsPackage = {
  name: string;
  ecosystem: string;
  description: string | null;
  repository_url: string | null;
  downloads: number;
  dependent_packages_count: number;
  dependent_repos_count: number;
  first_release_published_at?: string | null;
  latest_release_published_at: string | null;
  maintainers?: { login?: string | null; name?: string | null }[] | null;
  repo_metadata: RepoMetadata | null;
};

type EcosystemsCommitter = {
  name?: string | null;
  email?: string | null;
  login?: string | null;
  count?: number;
};

type EcosystemsCommitsRepository = {
  status?: string | null;
  full_name?: string;
  default_branch?: string | null;
  total_commits?: number;
  total_committers?: number;
  total_bot_commits?: number;
  total_bot_committers?: number;
  past_year_total_commits?: number;
  past_year_total_committers?: number;
  past_year_total_bot_commits?: number;
  past_year_total_bot_committers?: number;
  created_at?: string;
  updated_at?: string;
  committers?: EcosystemsCommitter[];
  past_year_committers?: EcosystemsCommitter[];
};

type EcosystemsMaintainer = {
  login?: string | null;
  count?: number;
  url?: string | null;
};

type EcosystemsIssuesRepository = {
  status?: string | null;
  full_name?: string;
  created_at?: string;
  updated_at?: string;
  issues_count?: number;
  pull_requests_count?: number;
  issues_closed_count?: number;
  pull_requests_closed_count?: number;
  issue_authors_count?: number;
  pull_request_authors_count?: number;
  issue_authors?: Record<string, number>;
  pull_request_authors?: Record<string, number>;
  issue_author_associations_count?: Record<string, number>;
  pull_request_author_associations_count?: Record<string, number>;
  maintainers?: EcosystemsMaintainer[];
  active_maintainers?: EcosystemsMaintainer[];
  past_year_issue_authors_count?: number;
  past_year_pull_request_authors_count?: number;
};

type EcosystemsOwner = {
  login?: string;
  kind?: string;
  name?: string | null;
  description?: string | null;
  company?: string | null;
  location?: string | null;
  website?: string | null;
  repositories_count?: number;
  total_stars?: number;
  followers?: number;
  created_at?: string;
  updated_at?: string;
};

export type EcosystemsRepoSummary = {
  packages: EcosystemsPackage[];
  repository: RepoMetadata | null;
  contributors: EcosystemsCommitsRepository | null;
  issues: EcosystemsIssuesRepository | null;
  owner: EcosystemsOwner | null;
};

export function normalizeRepoKey(url: string): string {
  const trimmed = (url || '')
    .trim()
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');
  try {
    const parsed = new URL(trimmed);
    const host = parsed.host.replace(/^www\./, '').toLowerCase();
    const pathname = parsed.pathname.replace(/\/+$/, '').replace(/\.git$/, '');
    return `${host}${pathname.toLowerCase()}`;
  } catch {
    return trimmed.toLowerCase();
  }
}

export function findRepoMetadata(packages: EcosystemsPackage[]): RepoMetadata | null {
  for (const pkg of packages) {
    if (pkg.repo_metadata && Object.keys(pkg.repo_metadata).length > 0) {
      return pkg.repo_metadata;
    }
  }
  return null;
}

async function fetchFromEcosystems<T>(apiUrl: string, path: string, params: Record<string, string>): Promise<T> {
  const url = new URL(path, apiUrl);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));

  const response = await fetch(url, {
    headers: getEcosystemsHeaders(),
    signal: AbortSignal.timeout(ECOSYSTEMS_REQUEST_TIMEOUT_MS),
  });
  if (response.status === 404) {
    return null;
  } else if (!response.ok) {
    throw new Error(`ecosyste.ms request failed with status ${response.status}: ${url.pathname}`);
  }

  return response.json();
}

async function fetchRepoPackages(repoUrl: string): Promise<EcosystemsPackage[]> {
  const url = new URL(`${ECOSYSTEMS_API_URL}/packages/bulk_lookup`);

  const response = await fetch(url, {
    method: 'POST',
    headers: getEcosystemsHeaders(),
    // eslint-disable-next-line camelcase -- ecosyste.ms API payload
    body: JSON.stringify({ repository_urls: [repoUrl] }),
    signal: AbortSignal.timeout(ECOSYSTEMS_REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`ecosyste.ms packages lookup failed with status ${response.status}`);
  }

  const packages = await response.json();
  return Array.isArray(packages) ? packages : [];
}

async function fetchRepositoryLookup(repoUrl: string): Promise<RepoMetadata | null> {
  return fetchFromEcosystems(ECOSYSTEMS_REPOS_API_URL, '/api/v1/repositories/lookup', { url: repoUrl });
}

async function fetchCommitsLookup(repoUrl: string): Promise<EcosystemsCommitsRepository | null> {
  return fetchFromEcosystems(ECOSYSTEMS_COMMITS_API_URL, '/api/v1/repositories/lookup', { url: repoUrl });
}

async function fetchIssuesLookup(repoUrl: string): Promise<EcosystemsIssuesRepository | null> {
  return fetchFromEcosystems(ECOSYSTEMS_ISSUES_API_URL, '/api/v1/repositories/lookup', { url: repoUrl });
}

async function fetchOwnerLookup(hostName: string, owner: string): Promise<EcosystemsOwner | null> {
  return fetchFromEcosystems(
    ECOSYSTEMS_REPOS_API_URL,
    `/api/v1/hosts/${encodeURIComponent(hostName)}/owners/${encodeURIComponent(owner)}`,
    {},
  );
}

const ECOSYSTEMS_HOST_BY_HOSTNAME: Record<string, string> = {
  'github.com': 'GitHub',
  'gitlab.com': 'GitLab',
  'bitbucket.org': 'Bitbucket',
  'codeberg.org': 'Codeberg',
  'gitea.com': 'Gitea',
};

function hostAndOwnerFromUrl(url: string): { hostName: string; owner: string } | null {
  try {
    const parsed = new URL((url || '').trim());
    const hostName = ECOSYSTEMS_HOST_BY_HOSTNAME[parsed.host.replace(/^www\./, '').toLowerCase()];
    const owner = parsed.pathname.split('/').filter(Boolean)[0];
    return hostName && owner ? { hostName, owner } : null;
  } catch {
    return null;
  }
}

export async function fetchRepoSummary(repoUrl: string): Promise<EcosystemsRepoSummary> {
  const [packages, contributors, issues] = await Promise.all([
    fetchRepoPackages(repoUrl),
    fetchCommitsLookup(repoUrl),
    fetchIssuesLookup(repoUrl),
  ]);

  // Same resolution order as the POC: prefer the metadata attached to a package, fall back to the repos lookup
  const repository = findRepoMetadata(packages) || (await fetchRepositoryLookup(repoUrl));

  let owner: EcosystemsOwner | null = null;
  const fromUrl = hostAndOwnerFromUrl(repoUrl);
  const hostName = repository?.host?.name || fromUrl?.hostName;
  const ownerLogin = repository?.owner || fromUrl?.owner;
  if (hostName && ownerLogin) {
    owner = await fetchOwnerLookup(hostName, ownerLogin);
  }

  return { packages, repository, contributors, issues, owner };
}
