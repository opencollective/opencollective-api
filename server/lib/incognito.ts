/**
 * Helpers to enforce visibility rules for incognito profiles.
 */

import type { Request } from 'express';

import roles from '../constants/roles';
import type { Collective } from '../models';

/**
 * Returns true when the remote user is allowed to see the given incognito account.
 * Always returns true for non-incognito accounts.
 *
 * Authorized viewers:
 * - the incognito profile's own admin (i.e. the user themselves)
 * - (optional) an admin or accountant of the host associated with the contribution/transaction context
 */
export function canSeeIncognitoProfile(
  req: Request,
  fromCollective: Collective,
  hostCollectiveId?: number | null,
): boolean {
  if (!fromCollective.isIncognito) {
    return true;
  }
  if (!req.remoteUser) {
    return false;
  }
  if (req.remoteUser.isAdminOfCollective(fromCollective)) {
    return true;
  }
  if (hostCollectiveId && req.remoteUser.hasRole([roles.ACCOUNTANT, roles.ADMIN], hostCollectiveId)) {
    return true;
  }
  return false;
}
