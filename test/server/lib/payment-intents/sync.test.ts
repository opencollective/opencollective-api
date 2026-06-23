import { expect } from 'chai';

import { resolveSharedParentCollectiveId } from '../../../../server/lib/payment-intents/sync';
import { fakeCollective, fakeProject } from '../../../test-helpers/fake-data';

describe('server/lib/payment-intents/sync', () => {
  describe('resolveSharedParentCollectiveId', () => {
    it('returns null when payer or payee is missing', async () => {
      const collective = await fakeCollective();

      expect(await resolveSharedParentCollectiveId(null, collective.id)).to.be.null;
      expect(await resolveSharedParentCollectiveId(collective.id, null)).to.be.null;
      expect(await resolveSharedParentCollectiveId(null, null)).to.be.null;
    });

    it('returns the collective id when payer and payee are the same', async () => {
      const collective = await fakeCollective();

      expect(await resolveSharedParentCollectiveId(collective.id, collective.id)).to.eq(collective.id);
    });

    it('returns the parent collective id when payer is parent of payee', async () => {
      const parent = await fakeCollective();
      const child = await fakeProject({ ParentCollectiveId: parent.id });

      expect(await resolveSharedParentCollectiveId(parent.id, child.id)).to.eq(parent.id);
    });

    it('returns the parent collective id when payee is parent of payer', async () => {
      const parent = await fakeCollective();
      const child = await fakeProject({ ParentCollectiveId: parent.id });

      expect(await resolveSharedParentCollectiveId(child.id, parent.id)).to.eq(parent.id);
    });

    it('returns the shared parent collective id when payer and payee are siblings', async () => {
      const parent = await fakeCollective();
      const payer = await fakeProject({ ParentCollectiveId: parent.id });
      const payee = await fakeProject({ ParentCollectiveId: parent.id });

      expect(await resolveSharedParentCollectiveId(payer.id, payee.id)).to.eq(parent.id);
    });

    it('returns null for unrelated collectives', async () => {
      const payer = await fakeCollective();
      const payee = await fakeCollective();

      expect(await resolveSharedParentCollectiveId(payer.id, payee.id)).to.be.null;
    });

    it('returns null when a collective id does not exist', async () => {
      const collective = await fakeCollective();

      expect(await resolveSharedParentCollectiveId(collective.id, 999999999)).to.be.null;
      expect(await resolveSharedParentCollectiveId(999999999, collective.id)).to.be.null;
    });
  });
});
