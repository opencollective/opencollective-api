import { expect } from 'chai';

import FEATURE from '../../../../server/constants/feature';
import FEATURE_STATUS from '../../../../server/constants/feature-status';
import { getFeatureStatusResolver } from '../../../../server/graphql/common/features';


describe('server/graphql/common/features', () => {
  describe('getFeatureStatusResolver', () => {
    describe('UPDATES', () => {
      it('Returns UNSUPPORTED when the feature is not supported', async () => {
        const collective = await fakeCollective({ type: 'USER' });
        const result = await getFeatureStatusResolver(FEATURE.UPDATES)(collective);
        expect(result).to.eq(FEATURE_STATUS.UNSUPPORTED);
      });


        expect(result).to.eq(FEATURE_STATUS.AVAILABLE);
      });

      it("Returns ACTIVE if enabled and there's data", async () => {

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

  });
});
