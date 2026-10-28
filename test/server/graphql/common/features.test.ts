import { expect } from 'chai';

import { CollectiveType } from '../../../../server/constants/collectives';
import { Service } from '../../../../server/constants/connected-account';
import FEATURE from '../../../../server/constants/feature';
import FEATURE_STATUS from '../../../../server/constants/feature-status';
import {
  checkReceiveFinancialContributions,
  getFeatureStatusResolver,
} from '../../../../server/graphql/common/features';
import type { Collective as CollectiveModel } from '../../../../server/models';
import {
  fakeActiveHost,
  fakeCollective,
  fakeConnectedAccount,
  fakeConversation,
  fakeEvent,
  fakeHost,
  fakeProject,
  fakeUpdate,
  fakeVendor,
} from '../../../test-helpers/fake-data';

/** The resolver takes `(collective, args, req)`; these tests only exercise `collective`. */
const resolveFeatureStatus = (feature: FEATURE, collective) =>
  getFeatureStatusResolver(feature)(collective, undefined, undefined);

describe('server/graphql/common/features', () => {
  describe('getFeatureStatusResolver', () => {
    describe('UPDATES', () => {
      it('Returns UNSUPPORTED when the feature is not supported', async () => {
        const collective = await fakeCollective({ type: CollectiveType.USER });
        const result = await resolveFeatureStatus(FEATURE.UPDATES, collective);
        expect(result).to.eq(FEATURE_STATUS.UNSUPPORTED);
      });

      it('Returns AVAILABLE if no update yet', async () => {
        const collective = await fakeCollective({ type: CollectiveType.COLLECTIVE });
        const result = await resolveFeatureStatus(FEATURE.UPDATES, collective);
        expect(result).to.eq(FEATURE_STATUS.AVAILABLE);
      });

      it("Returns ACTIVE if enabled and there's data", async () => {
        const collective = await fakeCollective({ type: CollectiveType.COLLECTIVE });
        await fakeUpdate({ CollectiveId: collective.id, publishedAt: new Date() });
        const result = await resolveFeatureStatus(FEATURE.UPDATES, collective);
        expect(result).to.eq(FEATURE_STATUS.ACTIVE);
      });
    });

    describe('CONVERSATIONS', () => {
      it('Returns UNSUPPORTED when the feature is not supported', async () => {
        const collective = await fakeCollective({ type: CollectiveType.USER });
        const result = await resolveFeatureStatus(FEATURE.CONVERSATIONS, collective);
        expect(result).to.eq(FEATURE_STATUS.UNSUPPORTED);
      });

      it('Returns AVAILABLE if enabled but no conversation yet', async () => {
        const collective = await fakeCollective({ type: CollectiveType.COLLECTIVE });
        const result = await resolveFeatureStatus(FEATURE.CONVERSATIONS, collective);
        expect(result).to.eq(FEATURE_STATUS.AVAILABLE);
      });

      it("Returns ACTIVE if enabled and there's data", async () => {
        const collective = await fakeCollective({ type: CollectiveType.COLLECTIVE });
        await fakeConversation({ CollectiveId: collective.id });
        const result = await resolveFeatureStatus(FEATURE.CONVERSATIONS, collective);
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

    describe('PUBLIC_PROFILE', () => {
      it('Returns ACTIVE for a regular (non-vendor) public collective', async () => {
        const collective = await fakeCollective({ type: CollectiveType.COLLECTIVE });
        const result = await resolveFeatureStatus(FEATURE.PUBLIC_PROFILE, collective);
        expect(result).to.eq(FEATURE_STATUS.ACTIVE);
      });

      it('Returns UNSUPPORTED for a private account', async () => {
        const collective = await fakeCollective({ type: CollectiveType.COLLECTIVE, isPrivate: true });
        const result = await resolveFeatureStatus(FEATURE.PUBLIC_PROFILE, collective);
        expect(result).to.eq(FEATURE_STATUS.UNSUPPORTED);
      });

      it('Returns DISABLED for a vendor when publicProfile is not explicitly enabled', async () => {
        const vendor = await fakeVendor();
        const result = await resolveFeatureStatus(FEATURE.PUBLIC_PROFILE, vendor);
        expect(result).to.eq(FEATURE_STATUS.DISABLED);
      });

      it('Returns DISABLED for a vendor when publicProfile is explicitly disabled', async () => {
        const vendor = await fakeVendor({ settings: { features: { publicProfile: false } } });
        const result = await resolveFeatureStatus(FEATURE.PUBLIC_PROFILE, vendor);
        expect(result).to.eq(FEATURE_STATUS.DISABLED);
      });

      it('Returns ACTIVE for a vendor when publicProfile is explicitly enabled by the fiscal host admin', async () => {
        const vendor = await fakeVendor({ settings: { features: { publicProfile: true } } });
        const result = await resolveFeatureStatus(FEATURE.PUBLIC_PROFILE, vendor);
        expect(result).to.eq(FEATURE_STATUS.ACTIVE);
      });
    });

    describe('TRANSFERWISE', () => {
      it('Returns UNSUPPORTED when the feature is not supported', async () => {
        const collective = await fakeCollective({ type: CollectiveType.USER });
        const result = await resolveFeatureStatus(FEATURE.TRANSFERWISE, collective);
        expect(result).to.eq(FEATURE_STATUS.UNSUPPORTED);
      });

      it('Returns DISABLED when the feature is disabled', async () => {
        const collective = await fakeHost({
          plan: 'start-plan-2021',
          settings: { features: { transferwise: false } } as CollectiveModel['settings'],
        });
        const result = await resolveFeatureStatus(FEATURE.TRANSFERWISE, collective);
        expect(result).to.eq(FEATURE_STATUS.DISABLED);
      });

      it('Returns AVAILABLE when the feature is available', async () => {
        const collective = await fakeHost({
          plan: 'start-plan-2021',
          settings: { features: { transferwise: true } } as CollectiveModel['settings'],
        });
        const result = await resolveFeatureStatus(FEATURE.TRANSFERWISE, collective);
        expect(result).to.eq(FEATURE_STATUS.AVAILABLE);
      });

      it("Returns ACTIVE if there's a linked transferwise account", async () => {
        const collective = await fakeHost({
          plan: 'start-plan-2021',
          settings: { features: { transferwise: true } } as CollectiveModel['settings'],
        });
        await fakeConnectedAccount({ CollectiveId: collective.id, service: Service.TRANSFERWISE });
        const result = await resolveFeatureStatus(FEATURE.TRANSFERWISE, collective);
        expect(result).to.eq(FEATURE_STATUS.ACTIVE);
      });
    });
  });
});
