import { expect } from 'chai';
import sinon from 'sinon';

import { fakeTransactionsImport, fakeTransactionsImportRow } from '../../test-helpers/fake-data';

describe('server/models/TransactionsImport', () => {
  describe('getAllSourceIds', () => {
    it('should return an empty set if there are no rows', async () => {
      const transactionsImport = await fakeTransactionsImport();
      const sourceIds = await transactionsImport.getAllSourceIds();
      expect(sourceIds).to.be.empty;
    });

    it('should return a set with the source IDs of all rows', async () => {
      const transactionsImport = await fakeTransactionsImport();
      await fakeTransactionsImportRow({ TransactionsImportId: transactionsImport.id, sourceId: '1' });
      await fakeTransactionsImportRow({ TransactionsImportId: transactionsImport.id, sourceId: '2' });
      await fakeTransactionsImportRow({ TransactionsImportId: transactionsImport.id, sourceId: '3' });
      await fakeTransactionsImportRow({ TransactionsImportId: transactionsImport.id, sourceId: '4' });
      const sourceIds = await transactionsImport.getAllSourceIds();
      expect(sourceIds).to.deep.equal(new Set(['1', '2', '3', '4']));
    });
  });

  describe('lock', () => {
    it('should throw an error if the import is already locked (default)', async () => {
      const lockedAt = new Date().toISOString();
      const transactionsImport = await fakeTransactionsImport({ data: { lockedAt } });
      await expect(transactionsImport.lock(() => Promise.resolve())).to.be.rejectedWith(
        'This import is already locked',
      );
    });

    it('should lock the import and run the callback', async () => {
      const callback = sinon.stub().callsFake(async transactionsImport => {
        await transactionsImport.reload();
        expect(transactionsImport.data.lockedAt).to.be.a('string').that.is.not.empty;
        throw new Error('Test error');
      });

      const transactionsImport = await fakeTransactionsImport();
      await expect(transactionsImport.lock(callback)).to.be.rejectedWith('Test error');
      expect(callback.called).to.be.true;
      expect(transactionsImport.data.lockedAt).to.be.undefined;
    });

    it('should unlock the import after the run even if an error occurs', async () => {
      const callback = sinon.stub().rejects(new Error('Test error'));
      const transactionsImport = await fakeTransactionsImport();
      await expect(transactionsImport.lock(callback)).to.be.rejectedWith('Test error');
      await transactionsImport.reload();
      expect(transactionsImport.data.lockedAt).to.be.undefined;
    });
  });
});
