import { expect } from 'chai';
import sinon from 'sinon';

import { OpenSearchModelsAdapters } from '../../../../server/lib/open-search/adapters';
import { OpenSearchBatchProcessor } from '../../../../server/lib/open-search/batch-processor';
import * as OpenSearchClient from '../../../../server/lib/open-search/client';
import { formatIndexNameForOpenSearch } from '../../../../server/lib/open-search/common';
import { OpenSearchIndexName } from '../../../../server/lib/open-search/constants';
import { OpenSearchRequestType } from '../../../../server/lib/open-search/types';
import { fakeComment, fakeExpense, fakeHostApplication, fakeTier, fakeUpdate } from '../../../test-helpers/fake-data';
import { createPrivateAccountFixture } from '../../../test-helpers/private-account-fixture';

describe('server/lib/open-search/private-collectives', () => {
  let fixture;
  let privateTier;
  let privateComment;
  let privateHostApplication;
  let publicExpense;
  let publicUpdate;

  before(async () => {
    fixture = await createPrivateAccountFixture();

    privateTier = await fakeTier({ CollectiveId: fixture.privateCollective.id });
    privateComment = await fakeComment({ CollectiveId: fixture.privateCollective.id });
    privateHostApplication = await fakeHostApplication({
      CollectiveId: fixture.privateCollective.id,
      HostCollectiveId: fixture.privateHost.id,
    });

    publicExpense = await fakeExpense({ CollectiveId: fixture.publicCollective.id });
    publicUpdate = await fakeUpdate({
      CollectiveId: fixture.publicCollective.id,
      publishedAt: new Date(),
    });
  });

  const getPrivateCollectiveIds = () => [
    fixture.privateHost.id,
    fixture.privateCollective.id,
    fixture.privateCollective2.id,
    fixture.privateProject.id,
    fixture.privateEvent.id,
  ];

  const expectAdapterExcludesPrivateResources = async (index, privateId, publicId = null) => {
    const adapter = OpenSearchModelsAdapters[index];

    const entriesById = await adapter.findEntriesToIndex({ ids: [privateId] });
    expect(entriesById).to.be.empty;

    const entriesByCollective = await adapter.findEntriesToIndex({
      relatedToCollectiveIds: [fixture.privateCollective.id],
    });
    expect(entriesByCollective.map(entry => entry.id)).to.not.include(privateId);

    if (publicId) {
      const publicEntries = await adapter.findEntriesToIndex({ ids: [publicId] });
      expect(publicEntries.map(entry => entry.id)).to.include(publicId);
    }
  };

  describe('findEntriesToIndex', () => {
    it('does not return private collectives when queried by id', async () => {
      const adapter = OpenSearchModelsAdapters[OpenSearchIndexName.COLLECTIVES];
      const entries = await adapter.findEntriesToIndex({ ids: getPrivateCollectiveIds() });

      expect(entries.map(entry => entry['id'])).to.not.include.members(getPrivateCollectiveIds());
    });

    it('does not return private collectives when queried by relatedToCollectiveIds', async () => {
      const adapter = OpenSearchModelsAdapters[OpenSearchIndexName.COLLECTIVES];
      const entries = await adapter.findEntriesToIndex({
        relatedToCollectiveIds: [fixture.privateCollective.id],
      });

      expect(entries.map(entry => entry['id'])).to.not.include.members(getPrivateCollectiveIds());
    });

    it('still returns public collectives when queried by id', async () => {
      const adapter = OpenSearchModelsAdapters[OpenSearchIndexName.COLLECTIVES];
      const entries = await adapter.findEntriesToIndex({ ids: [fixture.publicCollective.id] });

      expect(entries.map(entry => entry['id'])).to.include(fixture.publicCollective.id);
    });

    it('does not index expenses on private collectives', async () => {
      await expectAdapterExcludesPrivateResources(
        OpenSearchIndexName.EXPENSES,
        fixture.privateExpense.id,
        publicExpense.id,
      );
    });

    it('does not index updates on private collectives', async () => {
      await expectAdapterExcludesPrivateResources(
        OpenSearchIndexName.UPDATES,
        fixture.privateUpdate.id,
        publicUpdate.id,
      );
    });

    it('does not index orders on private collectives', async () => {
      await expectAdapterExcludesPrivateResources(OpenSearchIndexName.ORDERS, fixture.privateOrder.id);
    });

    it('does not index transactions on private collectives', async () => {
      await expectAdapterExcludesPrivateResources(OpenSearchIndexName.TRANSACTIONS, fixture.privateTransaction.id);
    });

    it('does not index tiers on private collectives', async () => {
      await expectAdapterExcludesPrivateResources(OpenSearchIndexName.TIERS, privateTier.id);
    });

    it('does not index comments on private collectives', async () => {
      await expectAdapterExcludesPrivateResources(OpenSearchIndexName.COMMENTS, privateComment.id);
    });

    it('does not index host applications on private collectives', async () => {
      await expectAdapterExcludesPrivateResources(OpenSearchIndexName.HOST_APPLICATIONS, privateHostApplication.id);
    });
  });

  describe('batch processor', () => {
    let processor;
    let clientStub;

    beforeEach(() => {
      (OpenSearchBatchProcessor as any).instance = null;
      clientStub = {
        bulk: sinon.stub().resolves({ body: { items: [], errors: false, took: 0 } }),
        deleteByQuery: sinon.stub().resolves({ took: 0 }),
      };
      sinon.stub(OpenSearchClient, 'getOpenSearchClient').returns(clientStub);
      processor = OpenSearchBatchProcessor.getInstance();
      processor.start();
    });

    afterEach(() => {
      sinon.restore();
    });

    it('does not index private expenses and issues a delete instead', async () => {
      processor.addToQueue({
        type: OpenSearchRequestType.INSERT,
        table: 'Expenses',
        payload: { id: fixture.privateExpense.id },
      });

      await (processor as any)._processBatch();

      const bulkBody = clientStub.bulk.firstCall.args[0].body;
      expect(bulkBody).to.not.deep.include({ index: { _id: fixture.privateExpense.id.toString() } });
      expect(bulkBody).to.deep.include({
        delete: {
          _index: formatIndexNameForOpenSearch(OpenSearchIndexName.EXPENSES),
          _id: fixture.privateExpense.id.toString(),
        },
      });
    });

    it('does not re-index related resources when re-indexing a private collective', async () => {
      const { operations } = await (processor as any).convertRequestsToBulkOperations([
        {
          type: OpenSearchRequestType.FULL_ACCOUNT_RE_INDEX,
          payload: { id: fixture.privateCollective.id },
        },
      ]);

      const indexedIds = operations.filter((_, i) => i % 2 === 0 && operations[i].index).map(entry => entry.index._id);

      expect(indexedIds).to.not.include(fixture.privateExpense.id.toString());
      expect(indexedIds).to.not.include(fixture.privateUpdate.id.toString());
      expect(indexedIds).to.not.include(fixture.privateOrder.id.toString());
      expect(indexedIds).to.not.include(fixture.privateTransaction.id.toString());
      expect(indexedIds).to.not.include(privateTier.id.toString());
      expect(indexedIds).to.not.include(privateComment.id.toString());
      expect(indexedIds).to.not.include(privateHostApplication.id.toString());
      expect(indexedIds).to.not.include(fixture.privateCollective.id.toString());
    });
  });
});
