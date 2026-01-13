// Ensure ts-node loads all files from tsconfig so global .d.ts augmentations are applied.
if (!process.env.TS_NODE_FILES) {
  process.env.TS_NODE_FILES = 'true';
}

// Skip typechecking in the test runner; `npm run type:check` handles it separately.
if (!process.env.TS_NODE_TRANSPILE_ONLY) {
  process.env.TS_NODE_TRANSPILE_ONLY = 'true';
}

// Use native TS compiler
if (!process.env.TS_NODE_COMPILER) {
  process.env.TS_NODE_COMPILER = 'typescript';
}

// setting up NODE_ENV to test when running the tests.
if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = 'test';
}

require('ts-node/register');

require('../server/env.ts');

const chai = require('chai');
const chaiAsPromised = require('chai-as-promised');
const chaiJestSnapshot = require('chai-jest-snapshot');
const chaiSorted = require('chai-sorted');
const chaiSubset = require('chai-subset');
const { mapValues } = require('lodash');
const markdownTable = require('markdown-table');
const Sequelize = require('sequelize');
const sinonChai = require('sinon-chai');

const { checkS3Configured, dangerouslyInitNonProductionBuckets } = require('../server/lib/awsS3');

chai.use(chaiAsPromised);
chai.use(chaiJestSnapshot);
chai.use(chaiSubset);
chai.use(chaiSorted);
chai.use(sinonChai);

module.exports.mochaHooks = {
  beforeAll: async function () {
    chaiJestSnapshot.resetSnapshotRegistry();

    try {
      if (checkS3Configured()) {
        await dangerouslyInitNonProductionBuckets();
      } else {
        console.warn('S3 is not configured, skipping S3 bucket initialization');
      }
    } catch {
      if (process.env.OC_ENV !== 'ci') {
        console.warn(
          'Unable to initialize test S3 buckets. This is expected if you are running the tests locally without touching uploaded files tests. Otherwise, start minio (see docs/s3.md).',
        );
      }
    }
  },
  beforeEach: function () {
    chaiJestSnapshot.configureUsingMochaContext(this);
  },
};

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
