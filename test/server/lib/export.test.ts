import { expect } from 'chai';

import { buildForeignKeyTree, traverse } from '../../../server/lib/export';
import models from '../../../server/models';
import { fakeCollective, fakeUser, multiple } from '../../test-helpers/fake-data';
import { resetTestDB } from '../../utils';

describe('export', () => {
  describe('buildForeignKeyTree', () => {
    it('should build a tree of foreign keys for all models', () => {
      const tree = buildForeignKeyTree(models);

      expect(tree.Collective).to.deep.include({ User: ['CollectiveId'] });
    });
  });

  describe('traverse', () => {
    let user;
    before(async () => {
      await resetTestDB();
      await multiple(fakeUser, 3);
      await multiple(fakeCollective, 3);
      user = await fakeUser({ collectiveData: { slug: 'test-user' } });
    });

    after(resetTestDB);

    it('should traverse the tree based on model references', async () => {
      const parsed = {};
      const results = await traverse({
        model: 'Collective',
        where: { slug: user.collective.slug },
        dependencies: ['User'],
        parsed,
      });

      expect(results).to.containSubset([{ model: 'User', id: user.id }]);
      expect(results).to.containSubset([{ model: 'Collective', id: user.collective.id }]);
    });

    it('should traverse using "on" statement', async () => {
      const parsed = {};
      const results = await traverse({
        model: 'Collective',
        where: { slug: user.collective.slug },
        dependencies: [{ model: 'User', on: 'CollectiveId' }],
        parsed,
      });

      expect(results).to.containSubset([{ model: 'User', id: user.id }]);
      expect(results).to.containSubset([{ model: 'Collective', id: user.collective.id }]);
    });

    it('should traverse using "from" statement', async () => {
      const parsed = {};
      const results = await traverse({
        model: 'User',
        where: { id: user.id },
        dependencies: [{ model: 'Collective', from: 'CollectiveId' }],
        parsed,
      });

      expect(results).to.containSubset([{ model: 'User', id: user.id }]);
      expect(results).to.containSubset([{ model: 'Collective', id: user.collective.id }]);
    });

    it('should traverse using where function paremetetr', async () => {
      const parsed = {};
      const results = await traverse({
        model: 'User',
        where: { id: user.id },
        dependencies: [{ model: 'Collective', where: userRow => ({ id: userRow.CollectiveId }) }],
        parsed,
      });

      expect(results).to.containSubset([{ model: 'User', id: user.id }]);
      expect(results).to.containSubset([{ model: 'Collective', id: user.collective.id }]);
    });
  });
});
