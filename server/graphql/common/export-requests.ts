import MemberRoles from '../../constants/roles';
import type { Collective } from '../../models';
import type User from '../../models/User';

/**
 * Whether a user can request, view or download exports for the given account.
 *
 * Mirrors the other financial read paths (e.g. `AccountPermissions.canDownloadPaymentReceipts`,
 * transaction permissions): ADMIN or ACCOUNTANT of the account, its fiscal host, or its parent.
 * Accountants have read access to all financial information, so they must be able to export it.
 */
export const canUseExportRequestsForAccount = (user: User, account: Collective): boolean =>
  Boolean(user?.hasRoleInCollectiveOrHost([MemberRoles.ADMIN, MemberRoles.ACCOUNTANT], account));
