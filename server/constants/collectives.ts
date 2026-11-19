export enum CollectiveType {
  COLLECTIVE = 'COLLECTIVE',
  EVENT = 'EVENT',
  USER = 'USER',
  ORGANIZATION = 'ORGANIZATION',
  BOT = 'BOT',
  PROJECT = 'PROJECT',
  FUND = 'FUND',
  VENDOR = 'VENDOR',
  PLATFORM = 'PLATFORM',
}

export const CollectiveTypesList = Object.values(CollectiveType);

/**
 * Name of an individual profile created without one (e.g. by `/users/signup`, before the user completes
 * their profile). Not "incognito": that is the name of the profiles used for incognito contributions.
 */
export const PLACEHOLDER_USER_NAME = 'New user';

/**
 * Defines the account types that are allowed to create projects.
 */
export const PROJECTS_ALLOWED_ACCOUNT_TYPES = [
  CollectiveType.FUND,
  CollectiveType.ORGANIZATION,
  CollectiveType.COLLECTIVE,
] as const;
