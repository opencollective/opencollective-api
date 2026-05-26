/**
 * Helpers to enforce visibility rules for incognito profiles.
 */

import type { Request } from 'express';

import type { Collective } from '../models';

/**
 * Returns true when the remote user is allowed to see the given incognito account.
 * Always returns true for non-incognito accounts.
 *
 * Authorized viewers:
 * - the incognito profile's own admin (i.e. the user themselves)
 */
export function canSeeIncognitoProfile(req: Request, fromCollective: Collective): boolean {
  if (!fromCollective.isIncognito) {
    return true;
  }
  if (!req.remoteUser) {
    return false;
  }
  if (req.remoteUser.isAdminOfCollective(fromCollective)) {
    return true;
  }
  return false;
}
