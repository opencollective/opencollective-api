/**
 * Library to store and retrieve permissions in GraphQL's context.
 *
 * This is intended to solve the problem of children's permissions that depends on a parent
 * that may be far away in the hierarchy tree. Some permissions depend on the context, for example
 * you're normally not allowed to watch the address of a user. But if you're a host admin
 * validating an expense that the user has submitted, then you're allowed to see it
 * **in this context**. The problem is that we have no clue in the User's location resolver
 * about this context.
 *
 * This small helper stores this information in a standardized way within the GraphQl context.
 * It works as an opt-in for all permissions: everything is forbidden by default and you need
 * to explicitely set the flag to true with `allowContextPermission` to allow something.
 *
 * Permissions are stored inside the `req` as an object that looks like:
 * {
 *    // Action type as the key
 *    SEE_ACCOUNT_LOCATION: {
 *      // [EntityId (ie. UserId, CollectiveId)]: hasAccess
 *      45: true
 *    }
 * }
 */

import { get, set, has } from 'lodash';

/**
 * Context permissions types to use with `setContextPermission` and `getContextPermission`
 */
export enum PERMISSION_TYPE {
  SEE_ACCOUNT_LOCATION = 'SEE_ACCOUNT_LOCATION',
  SEE_EXPENSE_ATTACHMENTS_URL = 'SEE_EXPENSE_ATTACHMENTS_URL',
  SEE_PAYOUT_METHOD_DATA = 'SEE_PAYOUT_METHOD_DATA',
}

/**
 * Build a key to get/set a value in permissions.
 */
const buildKey = (permissionType: PERMISSION_TYPE, entityId: string | number): string => {
  return `permissions.${permissionType}.${entityId}`;
};

const checkPermissionType = (permissionType): void => {
  if (!has(PERMISSION_TYPE, permissionType)) {
    throw new Error(`Unknown permission type ${permissionType}`);
  }
};

/**
 * Allow `permissionType` on `entityId` for the current query.
 *
 * @param req GraphQL context (third param of resolvers)
 * @param permissionType Type of the permission, see PERMISSION_TYPE
 * @param entityId The unique identifier for the item to which the permissions apply
 */
export const allowContextPermission = (
  req: object,
  permissionType: PERMISSION_TYPE,
  entityId: string | number,
): void => {
  checkPermissionType(permissionType);
  set(req, buildKey(permissionType, entityId), true);
};

/**
 * Retrieve a permission previously set with `setPermission`.
 *
 * @returns `true` if allowed, `false` if not allowed
 */
export const getContextPermission = (
  req: object,
  permissionType: PERMISSION_TYPE,
  entityId: string | number,
): boolean => {
  checkPermissionType(permissionType);
  return get(req, buildKey(permissionType, entityId), false);
};
