/**
 * Tests for `server/lib/sequelize-temporal.ts`, ported from the original `sequelize-temporal` test suite
 * (https://github.com/bonaval/sequelize-temporal/blob/master/test/test.js). The original ran against SQLite;
 * these run against the Postgres test database, using a dedicated Sequelize instance and dedicated tables
 * so they don't interfere with the application models.
 */
import { expect } from 'chai';
import { DataTypes, Model, ModelStatic, Op, Sequelize } from 'sequelize';

import { getDBConf } from '../../../server/lib/db';
import Temporal, { TemporalOptions } from '../../../server/lib/sequelize-temporal';

describe('server/lib/sequelize-temporal', () => {
  let sequelize: Sequelize;
  let User: ModelStatic<Model>;
  let UserHistory: ModelStatic<Model>;
  let Group: ModelStatic<Model>;
  const queries: string[] = [];

  const logging = (message: string) => {
    if (process.env.LOGGING === 'true') {
      console.log(message);
    }

    queries.push(message.substring(message.indexOf(':') + 2));
  };

  const dropTestTables = async () => {
    await sequelize.query(
      'DROP TABLE IF EXISTS "TemporalUserHistories", "TemporalUsers", "TemporalGroups", "TemporalFruitHistories", "TemporalFruits" CASCADE',
    );
  };

  const freshDBWithOptions = async (modelOptions = {}, temporalOptions?: TemporalOptions) => {
    if (sequelize) {
      await dropTestTables();
      await sequelize.close();
    }

    const dbConfig = getDBConf('database');
    sequelize = new Sequelize(dbConfig.database, dbConfig.username, dbConfig.password, {
      host: dbConfig.host,
      port: Number(dbConfig.port),
      dialect: 'postgres',
      logging,
    });

    User = Temporal(
      sequelize.define(
        'TemporalUser',
        {
          name: DataTypes.TEXT,
          virtual: DataTypes.VIRTUAL(DataTypes.STRING, ['name']),
        },
        modelOptions,
      ),
      sequelize,
      temporalOptions,
    );
    UserHistory = sequelize.models.TemporalUserHistory;

    Group = sequelize.define('TemporalGroup', { name: DataTypes.TEXT });
    Group.hasMany(User);
    User.belongsTo(Group);
    User.addScope('withGroup', { include: [Group] });

    await sequelize.sync({ force: true });
    queries.length = 0;
  };

  const freshDB = () => freshDBWithOptions();
  const freshDBWithFullModeAndParanoid = () => freshDBWithOptions({ paranoid: true }, { full: true });

  const expectHistoryCount = async (n: number, opts = {}) => {
    const count = await UserHistory.count(opts);
    expect(count, 'history entries').to.equal(n);
  };

  afterEach(() => {
    queries.length = 0;
  });

  after(async () => {
    if (sequelize) {
      await dropTestTables();
      await sequelize.close();
    }
  });

  describe('history model', () => {
    beforeEach(freshDB);

    it('defines a `<ModelName>History` model with all the model attributes plus `hid` and `archivedAt`', () => {
      // Note: `TemporalGroupId` is not included because the association is defined after calling `Temporal`
      expect(UserHistory).to.exist;
      expect(UserHistory.getTableName()).to.equal('TemporalUserHistories');
      expect(Object.keys(UserHistory.getAttributes())).to.have.members([
        'id',
        'name',
        'virtual',
        'createdAt',
        'updatedAt',
        'hid',
        'archivedAt',
      ]);
    });

    it('uses `hid` as the primary key, and not the original primary key', () => {
      expect(UserHistory.primaryKeyAttributes).to.deep.equal(['hid']);
      const attributes = UserHistory.getAttributes();
      expect(attributes.hid.autoIncrement).to.be.true;
      expect(attributes.id.primaryKey).to.not.be.true;
      expect(attributes.id.autoIncrement).to.not.be.true;
      expect(attributes.id.unique).to.not.be.true;
    });

    it('does not set a default value for timestamps, so they are copied from the original record', () => {
      const attributes = UserHistory.getAttributes();
      expect(attributes.createdAt.defaultValue).to.be.undefined;
      expect(attributes.updatedAt.defaultValue).to.be.undefined;
      expect(UserHistory.options.timestamps).to.be.false;
    });

    it('keeps non-unique indexes from the original model', () => {
      Temporal(
        sequelize.define(
          'TemporalFruit',
          { name: DataTypes.TEXT, color: DataTypes.TEXT },
          { indexes: [{ fields: ['color'] }, { fields: ['name', 'color'], unique: true }] },
        ),
        sequelize,
      );

      const FruitHistory = sequelize.models.TemporalFruitHistory;
      expect(FruitHistory.options.indexes.map(index => index.fields)).to.deep.equal([['color']]);
    });

    it('does not copy unique indexes and constraints from the original model', async () => {
      const Fruit = Temporal(
        sequelize.define(
          'TemporalFruit',
          { name: { type: DataTypes.TEXT, unique: true }, color: DataTypes.TEXT },
          {
            indexes: [
              { fields: ['name', 'color'], unique: true },
              { fields: ['color'], type: 'UNIQUE' },
            ],
          },
        ),
        sequelize,
      );
      await sequelize.sync();

      const FruitHistory = sequelize.models.TemporalFruitHistory;
      expect(FruitHistory.getAttributes().name.unique).to.not.be.true;
      expect(FruitHistory.options.indexes).to.deep.equal([]);

      // Archiving the same record multiple times is allowed
      const fruit = await Fruit.create({ name: 'apple', color: 'red' });
      await fruit.update({ color: 'green' });
      await fruit.update({ color: 'yellow' });
      expect(await FruitHistory.count({ where: { name: 'apple' } })).to.equal(2);
    });
  });

  describe('hooks', () => {
    beforeEach(freshDB);

    it('onCreate: should not store the new version in history db', async () => {
      await User.create({ name: 'test' });
      await expectHistoryCount(0);
    });

    it('onUpdate/onDestroy: should save to the historyDB', async () => {
      const user = await User.create();
      await expectHistoryCount(0);
      user.set('name', 'foo');
      await user.save();
      await expectHistoryCount(1);
      await user.destroy();
      await expectHistoryCount(2);
    });

    it('onUpdate: should store the previous version to the historyDB', async () => {
      const user = await User.create({ name: 'foo' });
      await expectHistoryCount(0);
      user.set('name', 'bar');
      await user.save();
      await expectHistoryCount(1);

      const users = await UserHistory.findAll();
      expect(users.length, 'only one entry in DB').to.equal(1);
      expect(users[0].get('name'), 'previous entry saved').to.equal('foo');
      expect(users[0].get('id')).to.equal(user.get('id'));
      expect(users[0].get('archivedAt')).to.be.an.instanceOf(Date);

      const reloadedUser = await User.findOne();
      await reloadedUser.destroy();
      await expectHistoryCount(2);
    });

    it('onDelete: should store the previous version to the historyDB', async () => {
      const user = await User.create({ name: 'foo' });
      await expectHistoryCount(0);
      await user.destroy();
      await expectHistoryCount(1);

      const users = await UserHistory.findAll();
      expect(users.length, 'only one entry in DB').to.equal(1);
      expect(users[0].get('name'), 'previous entry saved').to.equal('foo');
    });
  });

  describe('transactions', () => {
    beforeEach(freshDB);

    it('revert on failed transactions', async () => {
      const transaction = await sequelize.transaction();
      const opts = { transaction };
      const user = await User.create({}, opts);
      await expectHistoryCount(0, opts);
      user.set('name', 'foo');
      await user.save(opts);
      await expectHistoryCount(1, opts);
      await transaction.rollback();
      await expectHistoryCount(0);
    });
  });

  describe('bulk update', () => {
    beforeEach(freshDB);

    it('should archive every entry', async () => {
      await User.bulkCreate([{ name: 'foo1' }, { name: 'foo2' }]);
      await expectHistoryCount(0);
      await User.update({ name: 'updated-foo' }, { where: {} });
      await expectHistoryCount(2);
      const histories = await UserHistory.findAll({ order: [['name', 'ASC']] });
      expect(histories.map(h => h.get('name'))).to.deep.equal(['foo1', 'foo2']);
    });

    it('should only archive the entries matching the `where`', async () => {
      await User.bulkCreate([{ name: 'foo1' }, { name: 'foo2' }, { name: 'bar' }]);
      await User.update({ name: 'updated-foo' }, { where: { name: { [Op.like]: 'foo%' } } });
      await expectHistoryCount(2);
    });

    it('should not archive twice when using `individualHooks`', async () => {
      await User.bulkCreate([{ name: 'foo1' }, { name: 'foo2' }]);
      await User.update({ name: 'updated-foo' }, { where: {}, individualHooks: true });
      await expectHistoryCount(2);
    });

    it('should revert under transactions', async () => {
      const transaction = await sequelize.transaction();
      const opts = { transaction };
      await User.bulkCreate([{ name: 'foo1' }, { name: 'foo2' }], opts);
      await expectHistoryCount(0, opts);
      await User.update({ name: 'updated-foo' }, { where: {}, transaction });
      await expectHistoryCount(2, opts);
      await transaction.rollback();
      await expectHistoryCount(0);
    });
  });

  describe('bulk destroy/truncate', () => {
    beforeEach(freshDB);

    it('should archive every entry', async () => {
      await User.bulkCreate([{ name: 'foo1' }, { name: 'foo2' }]);
      await expectHistoryCount(0);
      await User.destroy({ where: {}, truncate: true });
      await expectHistoryCount(2);
    });

    it('should revert under transactions', async () => {
      const transaction = await sequelize.transaction();
      const opts = { transaction };
      await User.bulkCreate([{ name: 'foo1' }, { name: 'foo2' }], opts);
      await expectHistoryCount(0, opts);
      await User.destroy({ where: {}, truncate: true, transaction });
      await expectHistoryCount(2, opts);
      await transaction.rollback();
      await expectHistoryCount(0);
    });
  });

  describe('read-only', () => {
    beforeEach(freshDB);

    it('should forbid updates', async () => {
      const userHistory = await UserHistory.create({
        id: 1,
        name: 'foo',
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await expect(userHistory.update({ name: 'bla' })).to.be.rejectedWith(
        Error,
        "This is a read-only history database. You aren't allowed to modify it.",
      );
    });

    it('should forbid deletes', async () => {
      const userHistory = await UserHistory.create({
        id: 1,
        name: 'foo',
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await expect(userHistory.destroy()).to.be.rejectedWith(
        Error,
        "This is a read-only history database. You aren't allowed to modify it.",
      );
    });
  });

  describe('interference with the original model', () => {
    beforeEach(freshDB);

    it("shouldn't delete instance methods", async () => {
      const Fruit = Temporal(sequelize.define('TemporalFruit', { name: DataTypes.TEXT }), sequelize);
      Fruit.prototype['sayHi'] = () => 2;
      await sequelize.sync();
      const fruit = await Fruit.create();
      expect(fruit['sayHi']).to.be.a('function');
      expect(fruit['sayHi']()).to.equal(2);
    });

    it("shouldn't interfere with hooks of the model", async () => {
      let triggered = 0;
      const Fruit = Temporal(
        sequelize.define(
          'TemporalFruit',
          { name: DataTypes.TEXT },
          {
            hooks: {
              beforeCreate: () => {
                triggered++;
              },
            },
          },
        ),
        sequelize,
      );
      await sequelize.sync();
      await Fruit.create();
      expect(triggered, 'hook trigger count').to.equal(1);
    });

    it("shouldn't interfere with setters", async () => {
      let triggered = 0;
      const Fruit = Temporal(
        sequelize.define('TemporalFruit', {
          name: {
            type: DataTypes.TEXT,
            set: () => {
              triggered++;
            },
          },
        }),
        sequelize,
      );
      await sequelize.sync();
      await Fruit.create({ name: 'apple' });
      expect(triggered, 'hook trigger count').to.equal(1);
    });

    it('should return the model it was given', async () => {
      const Fruit = sequelize.define('TemporalFruit', { name: DataTypes.TEXT });
      expect(Temporal(Fruit, sequelize)).to.equal(Fruit);
    });
  });

  describe('full mode', () => {
    beforeEach(freshDBWithFullModeAndParanoid);

    it('onCreate: should store the new version in history db', async () => {
      await User.create({ name: 'test' });
      const histories = await UserHistory.findAll();
      expect(histories.length).to.equal(1);
      expect(histories[0].get('name')).to.equal('test');
    });

    it('onUpdate: should store the new version to the historyDB', async () => {
      const user = await User.create({ name: 'test' });
      await user.update({ name: 'renamed' });
      const histories = await UserHistory.findAll({ order: [['hid', 'ASC']] });
      expect(histories.length, 'two entries in DB').to.equal(2);
      expect(histories[0].get('name'), 'first version saved').to.equal('test');
      expect(histories[1].get('name'), 'second version saved').to.equal('renamed');
    });

    it('onDelete: should store the previous version to the historyDB', async () => {
      const user = await User.create({ name: 'test' });
      await user.update({ name: 'renamed' });
      await user.destroy();
      const histories = await UserHistory.findAll({ order: [['hid', 'ASC']] });
      expect(histories.length, 'three entries in DB').to.equal(3);
      expect(histories[0].get('name'), 'first version saved').to.equal('test');
      expect(histories[1].get('name'), 'second version saved').to.equal('renamed');
      expect(histories[2].get('deletedAt'), 'deleted version saved').to.not.be.null;
    });

    it('onRestore: should store the new version to the historyDB', async () => {
      const user = await User.create({ name: 'test' });
      await user.destroy();
      await user.restore();
      const histories = await UserHistory.findAll({ order: [['hid', 'ASC']] });
      expect(histories.length, 'three entries in DB').to.equal(3);
      expect(histories[0].get('name'), 'first version saved').to.equal('test');
      expect(histories[1].get('deletedAt'), 'deleted version saved').to.not.be.null;
      expect(histories[2].get('deletedAt'), 'restored version saved').to.be.null;
    });

    it('should revert on failed transactions, even when using after hooks', async () => {
      const transaction = await sequelize.transaction();
      const options = { transaction };
      const user = await User.create({ name: 'test' }, options);
      await user.destroy(options);
      await expectHistoryCount(2, options);
      await transaction.rollback();
      await expectHistoryCount(0);
    });

    it('onUpdate: should store the previous version to the historyDB even if entity was partially loaded', async () => {
      const created = await User.create({ name: 'name' });
      const user = await User.scope('withGroup').findByPk(created.get('id') as number, { attributes: ['id', 'name'] }); // Don't fetch timestamps

      await user.update({ name: 'newName' });
      await user.update({ name: 'thirdName' });

      const history = await UserHistory.findAll({ order: [['hid', 'ASC']] });

      expect(history.length, 'initial revision and to updates saved').to.equal(3);

      const [initial, firstUpdate, secondUpdate] = history;

      expect(+initial.get('createdAt'), 'createdAt was saved during first update').to.equal(
        +firstUpdate.get('createdAt'),
      );
      expect(+initial.get('createdAt'), 'createdAt was saved during second update').to.equal(
        +secondUpdate.get('createdAt'),
      );

      expect(firstUpdate.get('updatedAt'), 'updatedAt was saved during first update').to.be.at.least(
        initial.get('createdAt') as Date,
      );
      expect(secondUpdate.get('updatedAt'), 'updatedAt was saved during second update').to.be.at.least(
        firstUpdate.get('updatedAt') as Date,
      );

      expect(initial.get('name')).to.equal('name');
      expect(firstUpdate.get('name')).to.equal('newName');
      expect(secondUpdate.get('name')).to.equal('thirdName');

      const selects = queries.filter(query => query.startsWith('SELECT'));
      const userId = created.get('id');

      expect(selects).to.deep.equal([
        `SELECT "TemporalUser"."id", "TemporalUser"."name", "TemporalGroup"."id" AS "TemporalGroup.id", "TemporalGroup"."name" AS "TemporalGroup.name", "TemporalGroup"."createdAt" AS "TemporalGroup.createdAt", "TemporalGroup"."updatedAt" AS "TemporalGroup.updatedAt" FROM "TemporalUsers" AS "TemporalUser" LEFT OUTER JOIN "TemporalGroups" AS "TemporalGroup" ON "TemporalUser"."TemporalGroupId" = "TemporalGroup"."id" WHERE ("TemporalUser"."deletedAt" IS NULL AND "TemporalUser"."id" = ${userId});`,
        // Reload for first update, no includes and only required fields. Second update does not need a reload
        `SELECT "createdAt", "TemporalGroupId" FROM "TemporalUsers" AS "TemporalUser" WHERE "TemporalUser"."id" = ${userId};`,
        `SELECT "id", "name", "createdAt", "updatedAt", "deletedAt", "hid", "archivedAt" FROM "TemporalUserHistories" AS "TemporalUserHistory" ORDER BY "TemporalUserHistory"."hid" ASC;`,
      ]);
    });

    it('onUpdate: should not reload virtual fields', async () => {
      const created = await User.create({ name: 'name' });
      const user = await User.findByPk(created.get('id') as number, {
        attributes: ['id', 'name', 'createdAt', 'TemporalGroupId'],
      }); // Don't fetch timestamps

      await user.update({ name: 'newName' });
      await user.update({ name: 'thirdName' });

      const history = await UserHistory.findAll({ order: [['hid', 'ASC']] });

      expect(history.length, 'initial revision and to updates saved').to.equal(3);

      const [initial, firstUpdate, secondUpdate] = history;

      expect(+initial.get('createdAt')).to.equal(+firstUpdate.get('createdAt'));
      expect(+initial.get('createdAt')).to.equal(+secondUpdate.get('createdAt'));
      expect(firstUpdate.get('updatedAt')).to.be.at.least(initial.get('createdAt') as Date);
      expect(secondUpdate.get('updatedAt')).to.be.at.least(firstUpdate.get('updatedAt') as Date);

      expect(initial.get('name')).to.equal('name');
      expect(firstUpdate.get('name')).to.equal('newName');
      expect(secondUpdate.get('name')).to.equal('thirdName');

      const selects = queries.filter(query => query.startsWith('SELECT'));
      const userId = created.get('id');

      // No reload
      expect(selects).to.deep.equal([
        `SELECT "id", "name", "createdAt", "TemporalGroupId" FROM "TemporalUsers" AS "TemporalUser" WHERE ("TemporalUser"."deletedAt" IS NULL AND "TemporalUser"."id" = ${userId});`,
        `SELECT "id", "name", "createdAt", "updatedAt", "deletedAt", "hid", "archivedAt" FROM "TemporalUserHistories" AS "TemporalUserHistory" ORDER BY "TemporalUserHistory"."hid" ASC;`,
      ]);
    });

    it('onUpdate: should not reload attributes listed in `reloadIgnoredAttributes`', async () => {
      await freshDBWithOptions(
        { paranoid: true },
        { full: true, reloadIgnoredAttributes: ['deletedAt', 'TemporalGroupId'] },
      );
      const created = await User.create({ name: 'name' });
      const user = await User.findByPk(created.get('id') as number, {
        attributes: ['id', 'name', 'createdAt', 'updatedAt'],
      });
      queries.length = 0;

      await user.update({ name: 'newName' });

      const selects = queries.filter(query => query.startsWith('SELECT'));
      expect(selects).to.deep.equal([]);
      const history = await UserHistory.findAll({ order: [['hid', 'ASC']] });
      expect(history.length).to.equal(2);
      expect(history[1].get('name')).to.equal('newName');
      expect(+history[1].get('createdAt')).to.equal(+created.get('createdAt'));
    });
  });

  describe('silent mode', () => {
    it('onUpdate: should save to the historyDB if silent option is true but skipIfSilent is not set', async () => {
      await freshDB();
      const user = await User.create();
      await expectHistoryCount(0);
      user.set('name', 'foo');
      await user.save({ silent: true });
      await expectHistoryCount(1);
      await user.destroy();
      await expectHistoryCount(2);
    });

    it('onUpdate: should not save to the historyDB if silent option is true and skipIfSilent is true', async () => {
      await freshDBWithOptions(undefined, { skipIfSilent: true });
      const user = await User.create();
      await expectHistoryCount(0);
      user.set('name', 'foo');
      await user.save({ silent: true });
      await expectHistoryCount(0);
      await user.destroy();
      await expectHistoryCount(1);
    });

    it('bulkUpdate: should not save to the historyDB if silent is true and skipIfSilent is true', async () => {
      await freshDBWithOptions(undefined, { skipIfSilent: true });
      await User.bulkCreate([{ name: 'foo1' }, { name: 'foo2' }]);
      await expectHistoryCount(0);
      await User.update({ name: 'updated-foo' }, { where: {}, silent: true });
      await expectHistoryCount(0);
    });
  });

  describe('non-blocking mode', () => {
    beforeEach(() => freshDBWithOptions(undefined, { blocking: false }));

    it('onUpdate: should eventually store the previous version to the historyDB', async () => {
      const user = await User.create({ name: 'foo' });
      await user.update({ name: 'bar' });
      await waitForHistoryCount(1);
      const histories = await UserHistory.findAll();
      expect(histories[0].get('name')).to.equal('foo');
    });

    it('bulkUpdate: should eventually archive every entry', async () => {
      await User.bulkCreate([{ name: 'foo1' }, { name: 'foo2' }]);
      await User.update({ name: 'updated-foo' }, { where: {} });
      await waitForHistoryCount(2);
    });

    const waitForHistoryCount = async (n: number) => {
      for (let i = 0; i < 50; i++) {
        if ((await UserHistory.count()) === n) {
          return;
        }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      await expectHistoryCount(n);
    };
  });
});
