export enum CollectiveType {
  COLLECTIVE = 'COLLECTIVE',
  EVENT = 'EVENT',
  USER = 'USER',
  ORGANIZATION = 'ORGANIZATION',
  BOT = 'BOT',
  PROJECT = 'PROJECT',
  FUND = 'FUND',
  VENDOR = 'VENDOR',
}

export const CollectiveTypesList = Object.values(CollectiveType);

/**
 * Defines the account types that are allowed to create projects.
 */
export const PROJECTS_ALLOWED_ACCOUNT_TYPES = [
  CollectiveType.FUND,
  CollectiveType.ORGANIZATION,
  CollectiveType.COLLECTIVE,
] as const;
