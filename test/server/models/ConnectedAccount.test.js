import { expect } from 'chai';

import { fakeConnectedAccount } from '../../test-helpers/fake-data';

describe('server/models/ConnectedAccount', () => {
  describe('encryption', () => {
    it('should encrypt token and refreshToken', async () => {
      const params = { token: 'fake-token', refreshToken: 'fake-refresh' };
      const ca = await fakeConnectedAccount(params);

      expect(ca.token).to.equals(params.token);
      expect(ca.refreshToken).to.equals(params.refreshToken);
      expect(ca.getDataValue('token')).to.not.equals(params.token);
      expect(ca.getDataValue('refreshToken')).to.not.equals(params.refreshToken);
    });

    it('should support long tokens and refresh tokens exceeding 255 characters', async () => {
      const longToken = 'a'.repeat(500);
      const longRefreshToken = 'b'.repeat(500);
      const params = { token: longToken, refreshToken: longRefreshToken };
      const ca = await fakeConnectedAccount(params);

      expect(ca.token).to.equals(longToken);
      expect(ca.refreshToken).to.equals(longRefreshToken);
      expect(ca.getDataValue('token')).to.not.equals(longToken);
      expect(ca.getDataValue('refreshToken')).to.not.equals(longRefreshToken);
    });
  });
});
