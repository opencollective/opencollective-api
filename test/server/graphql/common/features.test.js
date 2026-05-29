import { expect } from 'chai';

import FEATURE from '../../../../server/constants/feature';
import FEATURE_STATUS from '../../../../server/constants/feature-status';
import {
  checkReceiveFinancialContributions,
  getFeatureStatusResolver,
} from '../../../../server/graphql/common/features';
import {
  fakeActiveHost,
  fakeCollective,
  fakeConnectedAccount,
  fakeConversation,
  fakeEvent,
  fakeHost,
  fakeProject,
  fakeUpdate,
} from '../../../test-helpers/fake-data';

describe('server/graphql/common/features', () => {
  describe('getFeatureStatusResolver', () => {
    describe('UPDATES', () => {
      it('Returns UNSUPPORTED when the feature is not supported', async () => {
        const collective = await fakeCollective({ type: 'USER' });
        const result = await getFeatureStatusResolver(FEATURE.UPDATES)(collective);
        expect(result).to.eq(FEATURE_STATUS.UNSUPPORTED);
      });

      it('Returns AVAILABLE if no update yet', async () => {
        const collective = await fakeCollective({ type: 'COLLECTIVE' });
        const result = await getFeatureStatusResolver(FEATURE.UPDATES)(collective);
        expect(result).to.eq(FEATURE_STATUS.AVAILABLE);
      });

      it("Returns ACTIVE if enabled and there's data", async () => {
        const collective = await fakeCollective({ type: 'COLLECTIVE' });
        await fakeUpdate({ CollectiveId: collective.id, publishedAt: Date.now() });
        const result = await getFeatureStatusResolver(FEATURE.UPDATES)(collective);
        expect(result).to.eq(FEATURE_STATUS.ACTIVE);
      });
    });

    describe('CONVERSATIONS', () => {
      it('Returns UNSUPPORTED when the feature is not supported', async () => {
        const collective = await fakeCollective({ type: 'USER' });
        const result = await getFeatureStatusResolver(FEATURE.CONVERSATIONS)(collective);
        expect(result).to.eq(FEATURE_STATUS.UNSUPPORTED);
      });

      it('Returns AVAILABLE if enabled but no conversation yet', async () => {
        const collective = await fakeCollective({ type: 'COLLECTIVE' });
        const result = await getFeatureStatusResolver(FEATURE.CONVERSATIONS)(collective);
        expect(result).to.eq(FEATURE_STATUS.AVAILABLE);
      });

      it("Returns ACTIVE if enabled and there's data", async () => {
        const collective = await fakeCollective({ type: 'COLLECTIVE' });
        await fakeConversation({ CollectiveId: collective.id });
        const result = await getFeatureStatusResolver(FEATURE.CONVERSATIONS)(collective);
        expect(result).to.eq(FEATURE_STATUS.ACTIVE);
      });
    });

    describe('RECEIVE_FINANCIAL_CONTRIBUTIONS', () => {
      it('returns DISABLED for a project under a frozen parent', async () => {
        const host = await fakeActiveHost({ plan: 'start-plan-2021' });
        const frozenParent = await fakeCollective({ HostCollectiveId: host.id, isActive: true });
        await frozenParent.disableFeature(FEATURE.ALL);
        await frozenParent.reload();

        // Simulate a project created after the parent was frozen (no freeze flag on the project itself)
        const project = await fakeProject({ ParentCollectiveId: frozenParent.id });
        await project.reload();

        const collectivesById = new Map([
          [frozenParent.id, frozenParent],
          [host.id, host],
        ]);
        const req = { loaders: { Collective: { byId: { load: async id => collectivesById.get(id) } } } };

        const result = await checkReceiveFinancialContributions(project, req, { ignoreActive: true });
        expect(result).to.equal(FEATURE_STATUS.DISABLED);
      });

      it('returns DISABLED for an event under a frozen parent', async () => {
        const host = await fakeActiveHost({ plan: 'start-plan-2021' });
        const frozenParent = await fakeCollective({ HostCollectiveId: host.id, isActive: true });
        await frozenParent.disableFeature(FEATURE.ALL);
        await frozenParent.reload();

        const event = await fakeEvent({ ParentCollectiveId: frozenParent.id });
        await event.reload();

        const collectivesById = new Map([
          [frozenParent.id, frozenParent],
          [host.id, host],
        ]);
        const req = { loaders: { Collective: { byId: { load: async id => collectivesById.get(id) } } } };

        const result = await checkReceiveFinancialContributions(event, req, { ignoreActive: true });
        expect(result).to.equal(FEATURE_STATUS.DISABLED);
      });

      it('returns AVAILABLE for a project whose parent is not frozen', async () => {
        const host = await fakeActiveHost({ plan: 'start-plan-2021' });
        const parent = await fakeCollective({ HostCollectiveId: host.id, isActive: true });
        const project = await fakeProject({ ParentCollectiveId: parent.id });
        await project.reload();

        const collectivesById = new Map([
          [parent.id, parent],
          [host.id, host],
        ]);
        const req = { loaders: { Collective: { byId: { load: async id => collectivesById.get(id) } } } };

        const result = await checkReceiveFinancialContributions(project, req, { ignoreActive: true });
        expect(result).to.equal(FEATURE_STATUS.AVAILABLE);
      });
    });

    describe('TRANSFERWISE', () => {
      it('Returns UNSUPPORTED when the feature is not supported', async () => {
        const collective = await fakeCollective({ type: 'USER' });
        const result = await getFeatureStatusResolver(FEATURE.TRANSFERWISE)(collective);
        expect(result).to.eq(FEATURE_STATUS.UNSUPPORTED);
      });

      it('Returns DISABLED when the feature is disabled', async () => {
        const collective = await fakeHost({ plan: 'start-plan-2021', settings: { features: { transferwise: false } } });
        const result = await getFeatureStatusResolver(FEATURE.TRANSFERWISE)(collective);
        expect(result).to.eq(FEATURE_STATUS.DISABLED);
      });

      it('Returns AVAILABLE when the feature is available', async () => {
        const collective = await fakeHost({ plan: 'start-plan-2021', settings: { features: { transferwise: true } } });
        const result = await getFeatureStatusResolver(FEATURE.TRANSFERWISE)(collective);
        expect(result).to.eq(FEATURE_STATUS.AVAILABLE);
      });

      it("Returns ACTIVE if there's a linked transferwise account", async () => {
        const collective = await fakeHost({ plan: 'start-plan-2021', settings: { features: { transferwise: true } } });
        await fakeConnectedAccount({ CollectiveId: collective.id, service: 'transferwise' });
        const result = await getFeatureStatusResolver(FEATURE.TRANSFERWISE)(collective);
        expect(result).to.eq(FEATURE_STATUS.ACTIVE);
      });
    });
  });
});
