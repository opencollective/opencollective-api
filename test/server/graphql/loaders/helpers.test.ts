import { expect } from 'chai';
import { createSandbox, stub } from 'sinon';

import { buildLoaderForAssociation } from '../../../../server/graphql/loaders/helpers';
import models from '../../../../server/models';
import { fakeCollective, fakeHost } from '../../../test-helpers/fake-data';
import { resetTestDB } from '../../../utils';

describe('server/graphql/loaders/helpers', () => {
  let sandbox;

  before(async () => {
    await resetTestDB();
    sandbox = createSandbox();
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('buildLoaderForAssociation', () => {
    it("loads the requested model's association from the model", async () => {
      const host = await fakeHost();
      const collective = await fakeCollective({ isActive: true, HostCollectiveId: host.id });
      const dbSpy = sandbox.spy(models.Collective, 'findAll');
      const loader = buildLoaderForAssociation<typeof models.Collective>(models.Collective, 'host');

      collective.host = host;
      const result = await loader.load(collective);
      expect(result.id).to.equal(host.id);
      expect(dbSpy.called).to.be.false;
    });

    it("loads the requested model's association from the database", async () => {
      const host = await fakeHost();
      const collective = await fakeCollective({ isActive: true, HostCollectiveId: host.id });
      const dbSpy = sandbox.spy(models.Collective, 'findAll');
      const loader = buildLoaderForAssociation<typeof models.Collective>(models.Collective, 'host');

      collective.host = undefined;
      const result = await loader.load(collective);
      expect(result.id).to.equal(host.id);
      expect(dbSpy.calledOnce).to.be.true;
    });

    it('previous results are cached', async () => {
      const host = await fakeHost();
      const collective = await fakeCollective({ isActive: true, HostCollectiveId: host.id });
      const dbSpy = sandbox.spy(models.Collective, 'findAll');
      const loader = buildLoaderForAssociation<typeof models.Collective>(models.Collective, 'host');

      // First call
      collective.host = undefined;
      const result = await loader.load(collective);
      expect(result.id).to.equal(host.id);
      expect(dbSpy.calledOnce).to.be.true;

      // Second call
      dbSpy.resetHistory();
      collective.host = undefined;
      const result2 = await loader.load(collective);
      expect(result2.id).to.equal(host.id);
      expect(dbSpy.called).to.be.false;
    });

    it("loads the requested model's association from a custom loader", async () => {
      const host = await fakeHost();
      const collective = await fakeCollective({ isActive: true, HostCollectiveId: host.id });
      const customLoader = stub().resolves([host]);
      const dbSpy = sandbox.spy(models.Collective, 'findAll');
      const loader = buildLoaderForAssociation<typeof models.Collective>(models.Collective, 'host', {
        loader: customLoader,
      });

      collective.host = undefined;
      const result = await loader.load(collective);
      expect(result.id).to.equal(host.id);
      expect(dbSpy.called).to.be.false;
      expect(customLoader.calledOnce).to.be.true;
    });

    it("loads the requested model's association from another entity passed alongside the first one", async () => {
      const host = await fakeHost();
      const collective1 = await fakeCollective({ isActive: true, HostCollectiveId: host.id });
      const collective2 = await fakeCollective({ isActive: true, HostCollectiveId: host.id });
      const dbSpy = sandbox.spy(models.Collective, 'findAll');
      const loader = buildLoaderForAssociation<typeof models.Collective>(models.Collective, 'host');

      collective1.host = undefined;
      collective2.host = host;
      const results = await loader.loadMany([collective1, collective2]);
      results.forEach(result => expect(result.id).to.equal(host.id));
      expect(dbSpy.called).to.be.false;
    });

    it('can use a filter to conditionally load', async () => {
      const host = await fakeHost();
      const collective = await fakeCollective({ isActive: true, HostCollectiveId: host.id });
      const dbSpy = sandbox.spy(models.Collective, 'findAll');
      const loader = buildLoaderForAssociation<typeof models.Collective>(models.Collective, 'host', {
        filter: () => false,
      });

      collective.host = undefined;
      const result = await loader.load(collective);
      expect(result).to.be.null;
      expect(dbSpy.called).to.be.false;
    });
  });
});
