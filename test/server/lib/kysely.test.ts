import { expect } from 'chai';
import { Model, ModelStatic } from 'sequelize';

import { CollectiveType } from '../../../server/constants/collectives';
import { getKysely, kyselyToSequelizeModels } from '../../../server/lib/kysely';
import models, { sequelize } from '../../../server/models';
import { fakeCollective } from '../../test-helpers/fake-data';
import * as utils from '../../utils';

function isModelFullyLoaded(instance: Model | Record<string, unknown>): boolean {
  const model = instance as Model;
  const ModelClass = model.constructor as ModelStatic<Model>;
  const rawAttributes = ModelClass?.rawAttributes;
  if (!rawAttributes || typeof model.dataValues === 'undefined') {
    return false; // plain Kysely row or not a Sequelize model
  }
  // Only require non-virtual attributes (virtuals are not in DB rows / dataValues)
  const modelAttributes = Object.keys(rawAttributes).filter(
    attr => (rawAttributes[attr].type as { key?: string })?.key !== 'VIRTUAL',
  );
  const instanceKeys = Object.keys(model.dataValues);
  return modelAttributes.every(attr => instanceKeys.includes(attr));
}

describe('server/lib/kysely', () => {
  let collective: Awaited<ReturnType<typeof fakeCollective>>;
  const testSlug = 'kysely-test-collective';

  before(async () => {
    await utils.resetTestDB();
    collective = await fakeCollective({
      slug: testSlug,
      name: 'Kysely Test Collective',
      type: CollectiveType.COLLECTIVE,
      currency: 'USD',
      tags: ['kysely-view-test-tag'],
    });

    await sequelize.query(`REFRESH MATERIALIZED VIEW "CollectiveTagStats"`);
  });

  describe('Querying views', () => {
    it('CollectiveTagStats', async () => {
      const db = getKysely();
      const rows = await db
        .selectFrom('CollectiveTagStats')
        .selectAll()
        .where('tag', '=', 'kysely-view-test-tag')
        .where('HostCollectiveId', '=', collective.HostCollectiveId)
        .execute();

      expect(rows).to.deep.equal([
        {
          tag: 'kysely-view-test-tag',
          count: 1,
          HostCollectiveId: collective.HostCollectiveId,
        },
      ]);
    });
  });

  describe('Querying models', () => {
    describe('querying Collectives', () => {
      it('returns the same collective by primary key as Sequelize', async () => {
        const db = getKysely();
        const rows = await db
          .selectFrom('Collectives')
          .selectAll()
          .where('id', '=', collective.id)
          .execute()
          .then(kyselyToSequelizeModels(models.Collective));

        expect(rows).to.have.length(1);
        const row = rows[0];
        expect(row).to.be.instanceOf(models.Collective);
        expect(row.id).to.equal(collective.id);
        expect(isModelFullyLoaded(row)).to.be.true;
      });

      it('returns the same collective by slug as Sequelize', async () => {
        const db = getKysely();
        const rows = await db
          .selectFrom('Collectives')
          .selectAll()
          .where('slug', '=', testSlug)
          .execute()
          .then(kyselyToSequelizeModels(models.Collective));

        expect(rows).to.have.length(1);
        const fromSequelize = await models.Collective.findOne({ where: { slug: testSlug } });
        expect(fromSequelize).to.not.be.null;

        const row = rows[0];
        expect(row.id).to.equal(fromSequelize!.id);
        expect(isModelFullyLoaded(row)).to.be.true;
      });

      it('returns at least the created collective when filtering by type', async () => {
        const db = getKysely();
        const rows = await db
          .selectFrom('Collectives')
          .select(['id', 'slug', 'name', 'type'])
          .where('type', '=', CollectiveType.COLLECTIVE)
          .execute();

        expect(rows.length).to.be.at.least(1);
        const ourRow = rows.find(r => r.slug === testSlug);
        expect(ourRow).to.not.be.undefined;
        expect(ourRow!.id).to.equal(collective.id);
        expect(ourRow!.name).to.equal('Kysely Test Collective');
        expect(ourRow!.type).to.equal('COLLECTIVE');
        expect(isModelFullyLoaded(ourRow)).to.be.false; // only id, slug, name, type are loaded
      });

      it('returns the same collective with multiple conditions (slug and currency)', async () => {
        const db = getKysely();
        const rows = await db
          .selectFrom('Collectives')
          .selectAll()
          .where('slug', '=', testSlug)
          .where('currency', '=', 'USD')
          .execute()
          .then(kyselyToSequelizeModels(models.Collective));

        expect(rows).to.have.length(1);
        const fromSequelize = await models.Collective.findOne({
          where: { slug: testSlug, currency: 'USD' },
        });
        expect(fromSequelize).to.not.be.null;

        const row = rows[0];
        expect(row.id).to.equal(fromSequelize!.id);
      });
    });
  });

  describe('Querying views + tables with joins', () => {
    it('CollectiveTagStats with joins on the Collective table', async () => {
      const db = getKysely();
      const rows = await db
        .selectFrom('CollectiveTagStats')
        .innerJoin('Collectives', 'Collectives.id', 'CollectiveTagStats.HostCollectiveId')
        .select([
          'CollectiveTagStats.tag',
          'CollectiveTagStats.count',
          'CollectiveTagStats.HostCollectiveId',
          'Collectives.slug',
        ])
        .where('CollectiveTagStats.tag', '=', 'kysely-view-test-tag')
        .where('CollectiveTagStats.HostCollectiveId', '=', collective.HostCollectiveId)
        .execute();

      expect(rows).to.have.length(1);
      expect(rows[0]).to.deep.include({
        tag: 'kysely-view-test-tag',
        count: 1,
        HostCollectiveId: collective.HostCollectiveId,
      });

      expect(rows[0].tag).to.equal('kysely-view-test-tag');
      expect(rows[0].slug).to.equal(collective.host.slug);
    });
  });
});
