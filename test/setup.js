import chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import chaiJestSnapshot from 'chai-jest-snapshot';
import chaiSorted from 'chai-sorted';
import chaiSubset from 'chai-subset';
import { mapValues } from 'lodash-es';
import markdownTable from 'markdown-table';
import Sequelize from 'sequelize';
import sinonChai from 'sinon-chai';
import * as td from 'testdouble';

// setting up NODE_ENV to test when running the tests.
if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = 'test';
}

chai.use(chaiAsPromised);
chai.use(chaiJestSnapshot);
chai.use(chaiSubset);
chai.use(chaiSorted);
chai.use(sinonChai);

afterEach(() => {
  td.reset();
});

before(() => {
  chaiJestSnapshot.resetSnapshotRegistry();
});

beforeEach(function () {
  chaiJestSnapshot.configureUsingMochaContext(this);
});

// Chai plugins
const sortDeep = item => {
  if (Array.isArray(item)) {
    return item.sort();
  } else if (item && typeof item === 'object') {
    return mapValues(item, sortDeep);
  } else {
    return item;
  }
};

chai.util.addMethod(chai.Assertion.prototype, 'eqInAnyOrder', function equalInAnyOrder(b, m) {
  const a = this.__flags.object;
  const { negate, message } = this.__flags;

  const msg = m || message;

  if (negate) {
    new chai.Assertion(sortDeep(a), msg).to.not.deep.equal(sortDeep(b));
  } else {
    new chai.Assertion(sortDeep(a), msg).to.deep.equal(sortDeep(b));
  }
});

/**
 * Custom chai assertion to ensure that sequelize object is soft deleted
 */
chai.util.addProperty(chai.Assertion.prototype, 'softDeleted', async function () {
  // Make sure we are working with a sequelize model
  new chai.Assertion(this._obj).to.be.instanceOf(Sequelize.Model, 'softDeleted');

  // Check if `deletedAt` is set after reloading
  const promiseGetEntityDeletedAt = this._obj
    .reload({ paranoid: false })
    .then(updatedEntity => updatedEntity.dataValues.deletedAt);

  if (this.__flags.negate) {
    await new chai.Assertion(promiseGetEntityDeletedAt, 'Entity should not be deleted in DB').to.eventually.not.exist;
  } else {
    await new chai.Assertion(promiseGetEntityDeletedAt, 'Entity should be deleted in DB').to.eventually.exist;
  }
});

chai.util.addMethod(chai.Assertion.prototype, 'matchTableSnapshot', function () {
  const headers = Object.keys(this._obj[0]);
  const prettyTable = markdownTable([headers, ...this._obj.map(Object.values)]);
  new chai.Assertion(`\n${prettyTable}`).to.matchSnapshot();
});
