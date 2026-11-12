import { expect } from 'chai';
import { type Compilable, type RawBuilder, sql, SqlBool } from 'kysely';

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
    const raw = (query: RawBuilder<unknown>): Compilable => ({ compile: () => query.compile(getKysely()) });
    const run = async (query: RawBuilder<unknown>) => (await sequelize.query(compileToInlineSQL(raw(query))))[0];
    const selectAsText = (values: unknown[]) =>
      sql`SELECT ${sql.join(values.map((value, index) => sql`${value}::text AS ${sql.ref(`v${index}`)}`))}`;
    const inlineError = (query: RawBuilder<unknown>): Error => {
      try {
        compileToInlineSQL(raw(query));
      } catch (e) {
        return e;
      }
      throw new Error('Expected compileToInlineSQL to throw');
    };

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

    it('returns strings as they were given, whatever they contain', async () => {
      const values = [
        '',
        "'",
        "''",
        "\\'",
        '\\',
        '\\\\',
        "x' || version() || 'y",
        `'; DROP TABLE "Orders"; --`,
        '$1',
        '$2 $1',
        '$10',
        '$&',
        "$` $' $$",
        ':name',
        '?',
        '--',
        '/* */',
        '*/ 1 /*',
        "E'\\''",
        '$tag$ quoted $tag$',
        'line 1\nline 2\r\n\tline 3',
        'unicode \u00e9 \u2028 \ud83d\ude00',
      ];

      const [row] = await run(selectAsText(values));
      expect(Object.values(row)).to.deep.eq(values);
    });

    it('gives each use of a value its own parameter', async () => {
      const value = "it's $1";
      const query = sql`SELECT ${value}::text AS a, ${value}::text AS b`;
      expect(raw(query).compile().parameters).to.deep.eq([value, value]);
      expect(await run(query)).to.deep.eq([{ a: value, b: value }]);
    });

    it('keeps the order of 10 parameters or more', async () => {
      const values = Array.from({ length: 12 }, (_, index) => `value ${index + 1}`);
      const [row] = await run(selectAsText(values));
      expect(Object.values(row)).to.deep.eq(values);
    });

    it('returns the SQL of a query without parameters as is', async () => {
      expect(compileToInlineSQL(raw(sql`SELECT 1 AS v`))).to.eq('SELECT 1 AS v');
    });

    it('returns the same rows as the parameterized search arms', async () => {
      const scope = [sql<SqlBool>`"Orders"."CollectiveId" IN (${sql.join([collective.id, otherCollective.id])})`];
      const terms = ['zebulon', "O'Collective", '100%', '@zebulon', 'snapshot@example.com', order.publicId];
      terms.push(`${otherOrder.id}`, '15.5', "it's $1 :name ? -- /* */ \\");
      let nbMatches = 0;
      for (const searchTerm of terms) {
        const arms = await buildSearchArms(searchTerm, {
          table: 'Orders',
          scope,
          accountIdFields: ['Orders.CollectiveId', 'Orders.FromCollectiveId'],
          userIdFields: ['Orders.CreatedByUserId'],
          idFields: ['Orders.id'],
          textFields: ['Orders.description'],
          amountFields: ['Orders.totalAmount'],
          emailFields: [{ field: sql`lower("Orders".data#>>'{fromAccountInfo,email}')` }],
          stringArrayFields: ['Orders.tags'],
          publicIdFields: [{ field: 'Orders.publicId', prefix: EntityShortIdPrefix.Order }],
        });

        const [inlinedRows] = await sequelize.query(compileToInlineSQL(arms));
        expect(inlinedRows, searchTerm).to.have.deep.members(await arms.execute());
        nbMatches += inlinedRows.length;
      }

      expect(nbMatches).to.be.greaterThan(terms.length / 2);
    });

    it('throws when the SQL of the query has its own $1-like text', async () => {
      const hostile = "x' || version() || 'y";
      const message = /placeholders/;
      expect(inlineError(sql`SELECT ${sql.lit('costs $1 each')} AS a, ${hostile}::text AS b`)).to.match(message);
      expect(inlineError(sql`SELECT ${sql.lit('costs $2 each')} AS a, ${hostile}::text AS b`)).to.match(message);
      expect(inlineError(sql`SELECT ${sql.raw('$3')} AS a, ${hostile}::text AS b`)).to.match(message);
      expect(inlineError(sql`SELECT ${sql.raw('$0')} AS a, ${hostile}::text AS b`)).to.match(message);
      expect(inlineError(sql`SELECT ${sql.lit('costs $1 each')} AS a`)).to.match(message);
      expect(inlineError(sql`SELECT ${hostile}::text AS a, ${sql.lit('$1')} AS b`).message).to.not.include('version');
    });

    it('throws when a parameter is glued to the token before it', async () => {
      // `E$1` would turn into an escape string (`E'…'`), where a backslash escapes the closing quote
      expect(inlineError(sql`SELECT E${"\\' || version() --"} AS a`)).to.match(/placeholders/);
      expect(inlineError(sql`SELECT 'a'${'b'} AS a`)).to.match(/placeholders/);
      expect(inlineError(sql`SELECT ${'a'}${'b'} AS a`)).to.match(/placeholders/);
    });

    it('puts negative numbers in parentheses', async () => {
      expect(await run(sql`SELECT 3-${-2} AS v`)).to.deep.eq([{ v: 5 }]);
      expect(await run(sql`SELECT 3 - ${-2} AS a, -${-2} AS b, ${-1.5}::float AS c, ${0}::int AS d`)).to.deep.eq([
        { a: 5, b: 2, c: -1.5, d: 0 },
      ]);
    });

    it('throws for parameters that are not strings or finite numbers', async () => {
      const secret = 'hunter2';
      const values = [NaN, Infinity, -Infinity, true, false, null, undefined, 10n, new Date(), [1, 2], [secret]];
      for (const value of [...values, { secret }, Buffer.from(secret)]) {
        const error = inlineError(sql`SELECT ${'ok'}::text AS a, ${value} AS b`);
        expect(error, String(value)).to.match(/strings and finite numbers/);
        expect(error.message).to.not.include(secret);
      }
    });
  });
});
