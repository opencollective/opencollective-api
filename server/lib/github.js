import { createOAuthAppAuth } from '@octokit/auth-oauth-app';
import { Octokit } from '@octokit/rest';
import config from 'config';
import { get, has, pick, trim, trimEnd, trimStart } from 'lodash';
import fetch from 'node-fetch';

import cache from './cache';
import logger from './logger';
import { reportMessageToSentry } from './sentry';

const compactRepo = repo => {
  repo = pick(repo, [
    'name', // (1)
    'full_name', // (1) (4)
    'description', // (1)
    'owner', // (1) (4)
    'stargazers_count', // (1) (4)
    'fork', // (3)
    'license', // (4)
  ]);
  repo.owner = pick(repo.owner, [
    'login', // (1)
    'type', // (4)
  ]);
  // 1) Required for the old website, according to:
  // https://github.com/opencollective/opencollective-website/blob/master/frontend/src/reducers/github.js
  // 3) Required for update-contributions
  // 4) Required on the frontend in the "OSC application flow"
  return repo;
};

export function getOctokit(accessToken) {
  const octokitParams = { request: { fetch } };

  if (accessToken) {
    octokitParams.auth = `token ${accessToken}`;
  } else if (has(config, 'github.clientID') && has(config, 'github.clientSecret')) {
    octokitParams.authStrategy = createOAuthAppAuth;
    octokitParams.auth = {
      clientId: get(config, 'github.clientID'),
      clientSecret: get(config, 'github.clientSecret'),
    };
  }

  return new Octokit(octokitParams);
}

export function getData(res) {
  if (has(res, ['headers', 'x-ratelimit-remaining'])) {
    logger.debug(`RateLimit Remaining: ${get(res, ['headers', 'x-ratelimit-remaining'])}`);
  }
  return res.data;
}

/**
 * Get all the public repos for which user is admin
 */
export async function getAllUserPublicRepos(accessToken) {
  const cacheKey = `user_repos_all_${accessToken}`;
  const fromCache = await cache.get(cacheKey);
  if (fromCache) {
    return fromCache;
  }

  const octokit = getOctokit(accessToken);

  // eslint-disable-next-line camelcase
  const parameters = { page: 1, per_page: 100, visibility: 'public' };

  let repos = [];
  let fetchRepos;
  const maxNbPages = 15; // More than that would probably timeout the request
  do {
    // https://octokit.github.io/rest.js/v18#repos-list-for-authenticated-user
    // https://developer.github.com/v3/repos/#list-your-repositories
    fetchRepos = await octokit.repos.listForAuthenticatedUser(parameters).then(getData);
    repos = [...repos, ...fetchRepos.filter(r => r.permissions.admin)];
    parameters.page++;
  } while (fetchRepos.length === parameters.per_page && parameters.page < maxNbPages);

  if (parameters.page === maxNbPages) {
    logger.error(`Aborted: Too many repos to fetch for user with token ${accessToken}`);
    reportMessageToSentry('Aborted: Too many repos to fetch for user', {
      severity: 'warning',
      accessToken: accessToken.replace(/^(.{3})(.+)(.{3})$/, '$1****$3'), // abcdefghijkl -> abc****jkl
    });
  }

  repos = repos.map(compactRepo);

  cache.set(cacheKey, repos, 5 * 60 /* 5 minutes */);

  return repos;
}

export async function getAllOrganizationPublicRepos(org, accessToken) {
  const cacheKey = `org_repos_all_${org}`;
  const fromCache = await cache.get(cacheKey);
  if (fromCache) {
    return fromCache;
  }

  const octokit = getOctokit(accessToken);

  // eslint-disable-next-line camelcase
  const parameters = { org, page: 1, per_page: 100, type: 'public' };

  let repos = [];
  let fetchRepos;
  do {
    // https://octokit.github.io/rest.js/v18#repos-list-for-org
    // https://developer.github.com/v3/repos/#list-organization-repositories
    fetchRepos = await octokit.repos.listForOrg(parameters).then(getData);
    repos = [...repos, ...fetchRepos];
    parameters.page++;
  } while (fetchRepos.length === parameters.per_page);

  repos = repos.map(compactRepo);

  cache.set(cacheKey, repos, 5 * 60 /* 5 minutes */);

  return repos;
}

export async function getRepo(name, accessToken) {
  const octokit = getOctokit(accessToken);
  // https://octokit.github.io/rest.js/v18#repos-get
  // https://developer.github.com/v3/repos/#get
  const [owner, repo] = name.split('/');
  return octokit.repos
    .get({ owner, repo })
    .then(getData)
    .catch(err => {
      if (err.status === 404) {
        throw new Error(`GitHub repository "${name}" not found`);
      } else {
        throw err;
      }
    });
}

export async function getOrg(name, accessToken) {
  const octokit = getOctokit(accessToken);
  // https://octokit.github.io/rest.js/v18#orgs-get
  // https://developer.github.com/v3/orgs/#get-an-organization
  return octokit.orgs.get({ org: name }).then(getData);
}

export async function getUser(name, accessToken) {
  const octokit = getOctokit(accessToken);
  // https://octokit.github.io/rest.js/v18#users-get-by-username
  // https://docs.github.com/en/rest/reference/users#get-a-user
  return octokit.users.getByUsername({ username: name }).then(getData);
}

export async function getOrgMemberships(accessToken) {
  const octokit = getOctokit(accessToken);
  // https://octokit.github.io/rest.js/v18#orgs-list-memberships-for-authenticated-user
  // https://developer.github.com/v3/orgs/members/#list-your-organization-memberships
  // eslint-disable-next-line camelcase
  return octokit.orgs.listMembershipsForAuthenticatedUser({ page: 1, per_page: 100 }).then(getData);
}

export async function checkGithubExists(githubHandle, accessToken) {
  if (githubHandle.includes('/')) {
    // A repository GitHub Handle (most common)
    const repo = await getRepo(githubHandle, accessToken).catch(() => null);
    if (!repo) {
      throw new Error('We could not verify the GitHub repository exists');
    }
  } else {
    // An organization GitHub Handle
    const org = await getOrg(githubHandle, accessToken).catch(() => null);
    if (!org) {
      throw new Error('We could not verify the GitHub organization exists');
    }
  }
}

export async function checkGithubAdmin(githubHandle, accessToken) {
  if (githubHandle.includes('/')) {
    // A repository GitHub Handle (most common)
    const repo = await getRepo(githubHandle, accessToken);
    const isGithubRepositoryAdmin = get(repo, 'permissions.admin') === true;
    if (!isGithubRepositoryAdmin) {
      throw new Error("We could not verify that you're admin of the GitHub repository");
    }
  } else {
    // An organization GitHub Handle
    const memberships = await getOrgMemberships(accessToken);
    const organizationAdminMembership =
      memberships &&
      memberships.find(m => m.organization.login === githubHandle && m.state === 'active' && m.role === 'admin');
    if (!organizationAdminMembership) {
      throw new Error("We could not verify that you're admin of the GitHub organization");
    }
  }
}

export async function checkGithubStars(githubHandle, accessToken) {
  if (githubHandle.includes('/')) {
    // A repository GitHub Handle (most common)
    const repo = await getRepo(githubHandle, accessToken);
    if (repo.stargazers_count < config.githubFlow.minNbStars) {
      throw new Error(`The repository need at least ${config.githubFlow.minNbStars} stars.`);
    }
  } else {
    // An organization GitHub Handle
    const allRepos = await getAllOrganizationPublicRepos(githubHandle, accessToken).catch(() => null);
    const repoWith100stars = allRepos.find(repo => repo.stargazers_count >= config.githubFlow.minNbStars);
    if (!repoWith100stars) {
      throw new Error(
        `The organization need at least one repository with ${config.githubFlow.minNbStars} GitHub stars.`,
      );
    }
  }
}

export async function getValidatorInfo(githubHandle, accessToken) {
  const octokit = getOctokit(accessToken);
  const [owner, repo] = githubHandle.split('/');
  const { repository } = await octokit.graphql(
    `
      query Repository($owner: String!, $repo: String!) {
        repository(owner: $owner, name: $repo) {
          isFork
          stargazerCount
          viewerCanAdminister
          owner {
            ... on Organization {
              login
            }
          }
          licenseInfo {
            name
            spdxId
          }
          defaultBranchRef {
            target {
              ... on Commit {
                committedDate
              }
            }
          }
          collaborators {
            totalCount
          }
        }
      }
    `,
    {
      owner,
      repo,
    },
  );

  return {
    lastCommitDate: repository.defaultBranchRef.target.committedDate,
    starsCount: repository.stargazerCount,
    collaboratorsCount: repository.collaborators.totalCount,
    isFork: repository.isFork,
    isOwnedByOrg: !!repository.owner?.login,
    isAdmin: repository.viewerCanAdminister,
    licenseSpdxId: repository.licenseInfo?.spdxId,
  };
}

const githubUsernameRegex = new RegExp('[a-z\\d](?:[a-z\\d]|-|_(?=[a-z\\d])){0,38}', 'i');
const githubRepositoryRegex = new RegExp('\\.?[a-z\\d](?:[a-z\\.\\d]|-|_(?=[a-z\\.\\d])){1,100}', 'i');
export const githubHandleRegex = new RegExp(
  `^${githubUsernameRegex.source}(/(${githubRepositoryRegex.source})?)?$`,
  'i',
);
const githubPathnameRegex = new RegExp(`^/${githubUsernameRegex.source}(/(${githubRepositoryRegex.source})?)?`, 'i');

/**
 * Return the github handle from a URL
 *
 * @param {string} url
 * @returns {string|null} handle
 *
 * @example
 * getGithubHandleFromUrl('https://github.com/opencollective/opencollective-frontend')
 * => 'opencollective/opencollective-frontend'
 */
export const getGithubHandleFromUrl = url => {
  try {
    const { hostname, pathname } = new URL(url);
    if (hostname !== 'github.com' || pathname.length < 2) {
      return null;
    }

    const regexResult = pathname.match(githubPathnameRegex);
    if (regexResult) {
      const handle = trim(regexResult[0], '/');
      if (githubHandleRegex.test(handle)) {
        return handle;
      }
    }
  } catch {
    // Ignore invalid URLs
  }

  return null;
};

/**
 * Generate a Github URL from a handle. Return null if handle is invalid
 *
 * @param {string} handle
 * @returns {string|null}
 */
export const getGithubUrlFromHandle = handle => {
  // "  @@@test//   " => "@test"
  const cleanHandle = trimStart(trimEnd(handle?.trim(), '/'), '@');
  if (cleanHandle) {
    // In case handle is a Github URL, we return it with the proper format
    const handleFromUrl = getGithubHandleFromUrl(cleanHandle);
    if (handleFromUrl) {
      return `https://github.com/${handleFromUrl}`;
    }

    if (githubHandleRegex.test(cleanHandle)) {
      const [org, repo] = cleanHandle.replace(/^@/, '').split('/');
      return `https://github.com/${repo ? `${org}/${repo}` : org}`;
    }
  }

  return null;
};
