import { values } from 'lodash';

import { sequelize } from '../server/models';

import { getOrCreateDBSnapshot } from './test-helpers/data-snapshot';

describe('truncate', () => {
  beforeEach(async () => {
    await getOrCreateDBSnapshot(this, 'merge-accounts', async () => {});
  });

  it('with sequelize truncate', async () => {
    console.time('sequelize default truncate');
    await sequelize.truncate({ cascade: true, restartIdentity: true });
    console.timeEnd('sequelize default truncate');
  });

  it('with homemade truncate', async () => {
    console.time('homemade truncate');
    const tableNames = values(sequelize.models).map(m => `"${m.tableName}"`);
    await sequelize.query(`TRUNCATE TABLE ${tableNames.join(', ')} RESTART IDENTITY CASCADE`);
    console.timeEnd('homemade truncate');
  });
});
