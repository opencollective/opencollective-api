/**
 * Helpers to enforce visibility rules for private organizations.
 */

import type { Request } from 'express';

import { Forbidden } from '../graphql/errors';
import type { Collective } from '../models';

/**
 * Returns true when the remote user is allowed to see the given account.
 * Always returns true for non-private accounts.
 */
export async function canSeePrivateAccount(req: Request, account: Collective): Promise<boolean> {
  if (!account.isPrivate) {
    return true;
  }
  return req.loaders.Collective.canSeePrivateAccount.load(account.id);
}

export async function canSeeAllPrivateAccounts(req: Request, accounts: Collective[]): Promise<boolean> {
  const privateAccounts = accounts.filter(account => account?.isPrivate);
  if (privateAccounts.length === 0) {
    return true;
  }
  const result = await req.loaders.Collective.canSeePrivateAccount.loadMany(privateAccounts.map(account => account.id));

  return result.every(canSee => canSee);
}

/**
 * Throws a Forbidden error when the remote user is not allowed to see the given account.
 * The error deliberately states that the account exists but is not accessible, so the
 * frontend can distinguish "not found" from "access denied".
 */
export async function assertCanSeeAccount(req: Request, account: Collective): Promise<void> {
  if (!account.isPrivate) {
    return;
  }
  const canSee = await req.loaders.Collective.canSeePrivateAccount.load(account.id);
  if (!canSee) {
    throw new Forbidden('This account is private. You must be a member to view it.');
  }
}

export async function assertCanSeeAllAccounts(req: Request, accounts: Collective[]): Promise<void> {
  if (!(await canSeeAllPrivateAccounts(req, accounts))) {
    throw new Forbidden('One or more of the accounts are private. You must be a member to view them.');
  }
}
