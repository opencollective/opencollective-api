import { expect } from 'chai';
import { sql, SqlBool } from 'kysely';

import OrderStatuses from '../../../server/constants/order-status';
import { compileToInlineSQL, getKysely } from '../../../server/lib/kysely';
import { EntityShortIdPrefix } from '../../../server/lib/permalink/entity-map';
import { buildSearchArms } from '../../../server/lib/sql-search';
import { sequelize } from '../../../server/models';
import { fakeCollective, fakeOrder, fakeUser } from '../../test-helpers/fake-data';
import { resetTestDB } from '../../utils';

describe('server/lib/sql-search (search arms)', () => {
  let collective, otherCollective, contributor, order, otherOrder, deletedOrder;

  const search = async (searchTerm: string, options: Partial<Parameters<typeof buildSearchArms>[1]> = {}) => {
    const arms = await buildSearchArms(searchTerm, {
      table: 'Orders',
      accountIdFields: ['Orders.CollectiveId', 'Orders.FromCollectiveId'],
      userIdFields: ['Orders.CreatedByUserId'],
      idFields: ['Orders.id'],
      textFields: ['Orders.description'],
      emailFields: [{ field: sql`lower("Orders".data#>>'{fromAccountInfo,email}')` }],
      stringArrayFields: ['Orders.tags'],
      publicIdFields: [{ field: 'Orders.publicId', prefix: EntityShortIdPrefix.Order }],
      ...options,
    });

    return arms && (await arms.execute()).map(row => row.id).sort((a, b) => a - b);
  };

  before(async () => {
    await resetTestDB();
    collective = await fakeCollective({ name: "Arms O'Collective 100%", slug: 'arms_collective' });
    otherCollective = await fakeCollective({ name: 'Unrelated', slug: 'unrelated' });
    contributor = await fakeUser(
      { email: 'zebulon.contributor@example.com' },
      { name: 'Zebulon Contributor', slug: 'zebulon' },
    );
    order = await fakeOrder({
      CollectiveId: collective.id,
      FromCollectiveId: contributor.CollectiveId,
      CreatedByUserId: contributor.id,
      status: OrderStatuses.PAID,
      description: 'Monthly support',
      tags: ['priority'],
    });
    await order.update({ data: { ...order.data, fromAccountInfo: { email: 'Snapshot@Example.com' } } });
    otherOrder = await fakeOrder({
      CollectiveId: otherCollective.id,
      status: OrderStatuses.PAID,
      description: 'Zebulon is mentioned here',
    });
    deletedOrder = await fakeOrder({
      CollectiveId: collective.id,
      FromCollectiveId: contributor.CollectiveId,
      status: OrderStatuses.PAID,
    });
    await deletedOrder.destroy();
  });

  describe('buildSearchArms', () => {
    it('returns null when the regular conditions should be used', async () => {
      expect(await search('')).to.be.null;
      expect(await search('   ')).to.be.null;
      expect(await search(`#${order.id}`)).to.be.null;
    });

    it('finds rows through the name and slug of their accounts, and through their own text', async () => {
      expect(await search('zebulon')).to.deep.eq([order.id, otherOrder.id]);
      expect(await search('Zebulon Contrib')).to.deep.eq([order.id]);
      expect(await search('unrelated')).to.deep.eq([otherOrder.id]);
      expect(await search('monthly SUPPORT')).to.deep.eq([order.id]);
      expect(await search('priority')).to.deep.eq([order.id]);
      expect(await search('nothing matches this')).to.deep.eq([]);
    });

    it('treats special characters of the term literally', async () => {
      expect(await search("O'Collective")).to.deep.eq([order.id]);
      expect(await search('100%')).to.deep.eq([order.id]);
      expect(await search('arms_collective')).to.deep.eq([order.id]);
      expect(await search('arms%collective')).to.deep.eq([]);
      expect(await search('armsXcollective')).to.deep.eq([]);
    });

    it('finds rows by exact slug, public ID and email only', async () => {
      expect(await search('@zebulon')).to.deep.eq([order.id]);
      expect(await search('@zebu')).to.deep.eq([]);
      expect(await search(order.publicId)).to.deep.eq([order.id]);
      expect(await search(collective.publicId)).to.deep.eq([order.id]);
      expect(await search('snapshot@example.com')).to.deep.eq([order.id]);
      expect(await search(contributor.email)).to.deep.eq([order.id]);
      expect(await search('nobody@example.com')).to.deep.eq([]);
    });

    it('finds rows by bare number on ID fields', async () => {
      expect(await search(`${otherOrder.id}`)).to.include(otherOrder.id);
    });

    it('ignores deleted rows and deleted accounts', async () => {
      expect(await search('zebulon')).to.not.include(deletedOrder.id);

      const deletedAccount = await fakeCollective({ name: 'Vanished Account' });
      const orderToDeletedAccount = await fakeOrder({ CollectiveId: deletedAccount.id, status: OrderStatuses.PAID });
      expect(await search('Vanished Account')).to.deep.eq([orderToDeletedAccount.id]);
      await deletedAccount.destroy();
      expect(await search('Vanished Account')).to.deep.eq([]);
    });

    it('applies the scope to every arm', async () => {
      const scope = [sql<SqlBool>`"Orders"."CollectiveId" = ${otherCollective.id}`];
      expect(await search('zebulon', { scope })).to.deep.eq([otherOrder.id]);
      expect(await search('@zebulon', { scope })).to.deep.eq([]);
    });

    it('returns null when too many accounts or rows match', async () => {
      expect(await search('zebulon', { limits: { maxAccounts: 0 } })).to.be.null;
      expect(await search('zebulon', { limits: { maxMatches: 0 } })).to.be.null;
      expect(await search('zebulon', { limits: { maxAccounts: 1, maxMatches: 1000 } })).to.deep.eq([
        order.id,
        otherOrder.id,
      ]);
    });
  });

  describe('compileToInlineSQL', () => {
    it('inlines parameters so that the query can be embedded in a Sequelize query', async () => {
      const values = ["it's", 'a "quoted" \\ back_slash%', '$1 and $2', 42];
      const query = getKysely()
        .selectFrom('Orders')
        .select([
          sql<string>`${values[0]}::text`.as('a'),
          sql<string>`${values[1]}::text`.as('b'),
          sql<string>`${values[2]}::text`.as('c'),
          sql<number>`${values[3]}::int`.as('d'),
        ])
        .where('Orders.id', '=', order.id);

      const [rows] = await sequelize.query(compileToInlineSQL(query));
      expect(rows).to.deep.eq([{ a: values[0], b: values[1], c: values[2], d: values[3] }]);
    });
  });
});
