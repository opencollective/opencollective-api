import { expect } from 'chai';

import FEATURE from '../../../../server/constants/feature.js';
import FEATURE_STATUS from '../../../../server/constants/feature-status.js';
import { getFeatureStatusResolver } from '../../../../server/graphql/common/features.js';
import {
  fakeCollective,
  fakeConnectedAccount,
  fakeConversation,
  fakeHost,
  fakeUpdate,
} from '../../../test-helpers/fake-data.js';

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

    describe('TRANSFERWISE', () => {
      it('Returns UNSUPPORTED when the feature is not supported', async () => {
        const collective = await fakeCollective({ type: 'USER' });
        const result = await getFeatureStatusResolver(FEATURE.TRANSFERWISE)(collective);
        expect(result).to.eq(FEATURE_STATUS.UNSUPPORTED);
      });

      it('Returns DISABLED when the feature is disabled', async () => {
        const collective = await fakeHost({ settings: { features: { transferwise: false } } });
        const result = await getFeatureStatusResolver(FEATURE.TRANSFERWISE)(collective);
        expect(result).to.eq(FEATURE_STATUS.DISABLED);
      });

      it("Returns ACTIVE if there's a linked transferwise account", async () => {
        const collective = await fakeHost({ settings: { features: { transferwise: true } } });
        await fakeConnectedAccount({ CollectiveId: collective.id, service: 'transferwise' });
        const result = await getFeatureStatusResolver(FEATURE.TRANSFERWISE)(collective);
        expect(result).to.eq(FEATURE_STATUS.ACTIVE);
      });
    });

    // TO DO
    // describe('RECURRING_CONTRIBUTIONS', () => {
    //   //
    // });
  });
});
