import { expect } from 'chai';

import { fakePersonalToken } from '../../test-helpers/fake-data';

describe('server/models/PersonalToken', () => {
  describe('data field validation', () => {
    it('allows null data', async () => {
      const token = await fakePersonalToken({ data: null });
      expect(token.data).to.be.null;
    });

    it('allows undefined data (which becomes null)', async () => {
      const token = await fakePersonalToken({ data: undefined });
      expect(token.data).to.be.null;
    });

    it('allows empty object as data', async () => {
      const token = await fakePersonalToken({ data: {} });
      expect(token.data).to.deep.equal({});
    });

    it('allows object with allowGraphQLV1 boolean property', async () => {
      const token = await fakePersonalToken({ data: { allowGraphQLV1: true } });
      expect(token.data).to.deep.equal({ allowGraphQLV1: true });

      const token2 = await fakePersonalToken({ data: { allowGraphQLV1: false } });
      expect(token2.data).to.deep.equal({ allowGraphQLV1: false });
    });

    it('rejects objects with invalid allowGraphQLV1 types', async () => {
      try {
        await fakePersonalToken({ data: { allowGraphQLV1: 'true' } } as unknown);
        throw new Error('Should have failed validation');
      } catch (error) {
        expect(error.name).to.equal('SequelizeValidationError');
      }

      try {
        await fakePersonalToken({ data: { allowGraphQLV1: 1 } } as unknown);
        throw new Error('Should have failed validation');
      } catch (error) {
        expect(error.name).to.equal('SequelizeValidationError');
      }
    });
  });
});
