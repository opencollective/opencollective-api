/**
 * Shared test fixture for private organization visibility tests.
 *
 * Creates a reusable world with:
 * - privateHost: private ORGANIZATION acting as a fiscal host
 * - privateCollective: a COLLECTIVE hosted by privateHost (inherits isPrivate)
 * - privateProject / privateEvent: children of privateCollective
 * - publicHost + publicCollective: control group, always public
 * - Users: privateHostAdmin, privateHostAccountant, privateCollectiveAdmin, privateCollectiveAccountant, randomUser, rootAdmin
 * - One of each resource (expense, order, transaction, update, conversation) on the private tree
 */

import { CollectiveType } from '../../server/constants/collectives';
import MemberRoles from '../../server/constants/roles';

import {
  fakeActiveHost,
  fakeCollective,
  fakeConversation,
  fakeExpense,
  fakeMember,
  fakeOrder,
  fakeTransaction,
  fakeUpdate,
  fakeUser,
} from './fake-data';

export type PrivateAccountFixture = Awaited<ReturnType<typeof createPrivateAccountFixture>>;

export async function createPrivateAccountFixture() {
  // --- Users ---
  const rootAdmin = await fakeUser({ data: { isRoot: true } });
  const privateHostAdmin = await fakeUser();
  const privateHostAccountant = await fakeUser();
  const privateCollectiveAdmin = await fakeUser();
  const privateCollectiveAdmin2 = await fakeUser();
  const privateCollectiveAccountant = await fakeUser();
  const randomUser = await fakeUser();

  // --- Private host (fiscal host) ---
  const privateHost = await fakeActiveHost({
    isPrivate: true,
    admin: privateHostAdmin.collective,
  });
  // Also add accountant role on host
  await fakeMember({
    CollectiveId: privateHost.id,
    MemberCollectiveId: privateHostAccountant.CollectiveId,
    role: MemberRoles.ACCOUNTANT,
  });
  // Make platform collective admin of this host so isAdminOfPlatform works
  await fakeMember({
    CollectiveId: 1, // OC Inc platform collective
    MemberCollectiveId: rootAdmin.CollectiveId,
    role: MemberRoles.ADMIN,
  });

  // --- Private collective (hosted by privateHost) ---
  const privateCollective = await fakeCollective({
    HostCollectiveId: privateHost.id,
    isPrivate: true,
    approvedAt: new Date(),
    admin: privateCollectiveAdmin.collective,
  });
  const privateCollective2 = await fakeCollective({
    HostCollectiveId: privateHost.id,
    isPrivate: true,
    approvedAt: new Date(),
    admin: privateCollectiveAdmin2.collective,
  });
  // Add accountant role on collective
  await fakeMember({
    CollectiveId: privateCollective.id,
    MemberCollectiveId: privateCollectiveAccountant.CollectiveId,
    role: MemberRoles.ACCOUNTANT,
  });

  // --- Private children ---
  const privateProject = await fakeCollective({
    type: CollectiveType.PROJECT,
    ParentCollectiveId: privateCollective.id,
    HostCollectiveId: privateHost.id,
    isPrivate: true,
  });
  const privateEvent = await fakeCollective({
    type: CollectiveType.EVENT,
    ParentCollectiveId: privateCollective.id,
    HostCollectiveId: privateHost.id,
    isPrivate: true,
  });

  // --- Public control group ---
  const publicHost = await fakeActiveHost();
  const publicCollective = await fakeCollective({ HostCollectiveId: publicHost.id });

  // --- Resources on the private tree ---
  const privateUpdate = await fakeUpdate({
    CollectiveId: privateCollective.id,
    publishedAt: new Date(),
  });

  const privateConversation = await fakeConversation({ CollectiveId: privateCollective.id });

  const privateExpense = await fakeExpense({ CollectiveId: privateCollective.id, status: 'PENDING' });

  const privateOrder = await fakeOrder({ CollectiveId: privateCollective.id }, { withSubscription: false });

  // A credit transaction on the private collective
  const privateTransaction = await fakeTransaction({
    CollectiveId: privateCollective.id,
    type: 'CREDIT',
    amount: 1000,
    currency: 'USD',
  });

  return {
    // Users
    rootAdmin,
    privateHostAdmin,
    privateHostAccountant,
    privateCollectiveAdmin,
    privateCollectiveAdmin2,
    privateCollectiveAccountant,
    randomUser,
    // Collectives
    privateHost,
    privateCollective,
    privateCollective2,
    privateProject,
    privateEvent,
    publicHost,
    publicCollective,
    // Resources
    privateUpdate,
    privateConversation,
    privateExpense,
    privateOrder,
    privateTransaction,
  };
}
