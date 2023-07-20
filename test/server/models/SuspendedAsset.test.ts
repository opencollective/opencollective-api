import { expect } from 'chai';

import SuspendedAsset, { AssetType } from '../../../server/models/SuspendedAsset.js';
import { fakeSuspendedAsset, multiple } from '../../test-helpers/fake-data.js';

describe('server/models/SuspendedAsset', () => {
  describe('assertAssetIsNotSuspended', () => {
    before(async () => {
      await multiple(fakeSuspendedAsset, 10, {});
    });

    it('should throw if asset is suspended', async () => {
      const assetParams = { type: AssetType.IP, fingerprint: '1.1.1.1' };
      await fakeSuspendedAsset(assetParams);

      await expect(SuspendedAsset.assertAssetIsNotSuspended(assetParams)).to.be.rejectedWith('IP is suspended');
    });

    it('should resolve if asset is not suspended', async () => {
      const assetParams = { type: AssetType.IP, fingerprint: '1.2.3.4' };

      await expect(SuspendedAsset.assertAssetIsNotSuspended(assetParams)).to.be.fulfilled;
    });
  });
});
