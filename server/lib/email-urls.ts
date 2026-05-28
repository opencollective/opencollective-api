import config from 'config';

import { Collective } from '../models';

import { preserveExpensePagePermalinkParameters } from './permalink/entity-handlers/handlers';
import { getDashboardRoute } from './permalink/entity-handlers/utils';

type AccountLike = Partial<Pick<Collective, 'slug' | 'publicId' | 'isPrivate' | 'type'>>;

type EntityLike = {
  publicId?: string | null;
};

export const getPermalinkUrl = (publicId?: string | null): string | null => {
  if (!publicId) {
    return null;
  }

  return `${config.host.website}/permalink/${publicId}`;
};

/**
 * Returns a URL safe for emails and notifications.
 * Private accounts use permalinks when available to avoid exposing slugs in email clients.
 */
export const getAccountUrl = (account: AccountLike): string | null => {
  if (!account) {
    return null;
  } else if (account.isPrivate) {
    // Prefer permalinks for private accounts to avoid exposing slugs in email clients.
    const permalink = getPermalinkUrl(account.publicId);
    if (permalink) {
      return permalink;
    }

    // As a fallback to not crash in the (unlikely) case where the publicId is missing, use the dashboard URL.
    return getFullDashboardUrl(account);
  } else {
    // We'll keep relying on the slug (rather than permalink) for public accounts for now.
    return `${config.host.website}/${account.slug}`;
  }
};

export const getAccountUrlWithParent = (account: AccountLike, parent: AccountLike): string | null => {
  if (!account) {
    return null;
  } else if (account.isPrivate) {
    return getAccountUrl(account);
  } else {
    const accountType = account?.type;
    const separator = accountType === 'EVENT' ? 'events' : accountType === 'PROJECT' ? 'projects' : null;
    const parentSlug = parent?.slug;
    if (!accountType || !parentSlug || !separator) {
      return `${config.host.website}/${account.slug}`;
    }

    return `${config.host.website}/${parentSlug}/${separator}/${account.slug}`;
  }
};

export const getFullDashboardUrl = (
  account: AccountLike,
  section: string | null = null,
  params: Record<string, string | number | null | undefined> = {},
): string => {
  return `${config.host.website}${getDashboardRoute(account, section, params)}`;
};

export const getCollectiveExpensesUrl = (collective: AccountLike): string => {
  if (collective?.isPrivate) {
    return getFullDashboardUrl(collective, 'payment-requests');
  }

  return `${config.host.website}/${collective.slug}/expenses`;
};

export const getExpenseUrl = (
  expense: EntityLike & { id?: number },
  collective: AccountLike,
  queryParams?: Record<string, string>,
): string => {
  const query = queryParams ? `?${new URLSearchParams(queryParams).toString()}` : '';

  // Keep using the expense public page for expense invites for now (we need to work on the dashboard experience)
  if ((queryParams?.key || queryParams?.edit) && !collective?.isPrivate) {
    return preserveExpensePagePermalinkParameters(
      `${config.host.website}/${collective.slug}/expenses/${expense.id}`,
      queryParams,
    );
  }

  const permalink = getPermalinkUrl(expense?.publicId);
  if (permalink) {
    return `${permalink}${query}`;
  }

  if (!collective?.isPrivate) {
    return `${config.host.website}/${collective.slug}/expenses/${expense.id}${query}`;
  } else {
    return null;
  }
};
