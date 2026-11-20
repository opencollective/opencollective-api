import '../server/env';

/**
 * Seeds a blank database (restored with `npm run db:restore:blank`) with sample data for local development.
 *
 * Usage (the database must be named explicitly, see `scripts/db_seed.sh`):
 *   npm run db:restore:blank -- -d opencollective_blank
 *   npm run db:seed opencollective_blank
 *
 * Every user created here has the password `password`. The root user is `root@example.com`.
 */
import config from 'config';
import { v4 as uuid } from 'uuid';

import { CollectiveType } from '../server/constants/collectives';
import OrderStatuses from '../server/constants/order-status';
import PlatformConstants from '../server/constants/platform';
import MemberRoles from '../server/constants/roles';
import { TransactionKind } from '../server/constants/transaction-kind';
import models, { sequelize } from '../server/models';
import { PayoutMethodTypes } from '../server/models/PayoutMethod';
import {
  fakeActiveHost,
  fakeCollective,
  fakeEvent,
  fakeExpense,
  fakeOrder,
  fakePayoutMethod,
  fakeProject,
  fakeTier,
  fakeTransaction,
  fakeUser,
  fakeVendor,
} from '../test/test-helpers/fake-data';
import { seedDefaultVendors } from '../test/utils';

const PASSWORD = 'password';

const seededUsers: Array<{ name: string; email: string }> = [];

const createUser = async (email: string, name: string, data: Record<string, unknown> = {}) => {
  const user = await fakeUser({ email, data }, { name, slug: name.toLowerCase().replace(/\s+/g, '-') });
  await user.setPassword(PASSWORD);
  seededUsers.push({ name, email });
  return user;
};

const seedPlatform = async () => {
  const root = await createUser('root@example.com', 'Root Admin', { isRoot: true });

  const platform = await models.Collective.create({
    id: PlatformConstants.PlatformCollectiveId,
    type: CollectiveType.ORGANIZATION,
    name: PlatformConstants.PlatformName,
    slug: 'platform',
    currency: PlatformConstants.PlatformCurrency,
    hasMoneyManagement: true,
    hasHosting: true,
    isActive: true,
    CreatedByUserId: root.id,
  });
  await models.Member.create({
    CollectiveId: platform.id,
    MemberCollectiveId: root.CollectiveId,
    role: MemberRoles.ADMIN,
    CreatedByUserId: root.id,
  });
  await root.populateRoles({ force: true });

  return { root, platform };
};

const seedHostAndCollectives = async () => {
  const hostAdmin = await createUser('host-admin@example.com', 'Host Admin');
  const collectiveAdmin = await createUser('collective-admin@example.com', 'Collective Admin');
  const contributor = await createUser('contributor@example.com', 'Contributor');

  const host = await fakeActiveHost({
    name: 'Sample Fiscal Host',
    slug: 'sample-host',
    admin: hostAdmin,
    CreatedByUserId: hostAdmin.id,
  });

  const collectives = [];
  for (const name of ['Sample Collective', 'Another Collective']) {
    const collective = await fakeCollective({
      name,
      slug: name.toLowerCase().replace(/\s+/g, '-'),
      HostCollectiveId: host.id,
      admin: collectiveAdmin,
      CreatedByUserId: collectiveAdmin.id,
    });
    // Left out, the tier's currency is picked at random.
    await fakeTier({
      CollectiveId: collective.id,
      name: 'Backer',
      slug: `backer-${collective.id}`,
      currency: collective.currency,
    });
    collectives.push(collective);
  }

  // Every account is created by a seeded user: left out, the helpers would create a random user (and host) for it.
  const [main] = collectives;
  const createdBy = { CreatedByUserId: collectiveAdmin.id, admin: collectiveAdmin };
  await fakeEvent({ ParentCollectiveId: main.id, HostCollectiveId: host.id, name: 'Sample Event', ...createdBy });
  await fakeProject({ ParentCollectiveId: main.id, HostCollectiveId: host.id, name: 'Sample Project', ...createdBy });
  // Like vendors created in the dashboard: belongs to the host, not hosted by it.
  await fakeVendor({
    ParentCollectiveId: host.id,
    HostCollectiveId: null,
    name: 'Sample Vendor',
    CreatedByUserId: hostAdmin.id,
  });

  return { host, hostAdmin, collectiveAdmin, contributor, collectives };
};

const seedActivity = async ({ host, collectiveAdmin, contributor, collectives }) => {
  // The payee's own payout method: left out, `fakeExpense` would create one for an unrelated account.
  const payoutMethod = await fakePayoutMethod({
    type: PayoutMethodTypes.OTHER,
    name: 'Sample payout method',
    data: { content: 'Sample payout instructions' },
    CollectiveId: collectiveAdmin.CollectiveId,
    CreatedByUserId: collectiveAdmin.id,
  });
  for (const collective of collectives) {
    const order = await fakeOrder(
      {
        CreatedByUserId: contributor.id,
        FromCollectiveId: contributor.CollectiveId,
        CollectiveId: collective.id,
        status: OrderStatuses.PAID,
      },
      { withBackerMember: true },
    );
    // The contribution's transactions, as `fakeOrder({ withTransactions })` makes them but created by the
    // contributor: that option gives each one a new random creator.
    const transaction = {
      OrderId: order.id,
      kind: TransactionKind.CONTRIBUTION,
      PaymentMethodId: order.PaymentMethodId,
      TransactionGroup: uuid(),
      CreatedByUserId: contributor.id,
    };
    await fakeTransaction({
      ...transaction,
      type: 'CREDIT',
      FromCollectiveId: order.FromCollectiveId,
      CollectiveId: order.CollectiveId,
      HostCollectiveId: collective.HostCollectiveId,
      amount: order.totalAmount,
    });
    await fakeTransaction({
      ...transaction,
      type: 'DEBIT',
      FromCollectiveId: order.CollectiveId,
      CollectiveId: order.FromCollectiveId,
      amount: -order.totalAmount,
    });
    await fakeExpense({
      FromCollectiveId: collectiveAdmin.CollectiveId,
      CollectiveId: collective.id,
      UserId: collectiveAdmin.id,
      PayoutMethodId: payoutMethod.id,
      status: 'APPROVED',
      amount: 5000,
      currency: collective.currency,
      // Left out, the expense gets one to five random items, each created by a new random user.
      items: [{ description: 'Sample expense item', amount: 5000, CreatedByUserId: collectiveAdmin.id }],
    });
  }
  return host;
};

async function main(): Promise<void> {
  if (['production', 'staging'].includes(config.env)) {
    throw new Error(`Refusing to seed sample data in the ${config.env} environment`);
  }

  const database = config.database.override?.database;
  if (!database) {
    throw new Error('No database to seed: run `npm run db:seed <database>`.');
  }
  console.log(`Seeding database ${database}`);

  // Seeding twice would collide on the platform account and the seeded emails: start from a blank database.
  const existing = await models.Collective.count();
  if (existing > 0) {
    throw new Error(
      `The database ${database} already has ${existing} accounts. Restore it first with \`npm run db:restore:blank -- -d ${database} --yes\`.`,
    );
  }

  await seedPlatform();
  await seedDefaultVendors();
  const seeded = await seedHostAndCollectives();
  await seedActivity(seeded);

  console.log('✓ Seeded blank database. Users (all with the password documented in scripts/db_seed.ts):');
  seededUsers.forEach(({ name, email }) => console.log(`  - ${name}: ${email}`));
}

if (!module.parent) {
  // We exit explicitly: the Redis connection opened by the app would otherwise keep the process alive
  main()
    .then(() => sequelize.close())
    .then(() => process.exit(0))
    .catch(e => {
      console.error(e);
      sequelize.close().finally(() => process.exit(1));
    });
}
