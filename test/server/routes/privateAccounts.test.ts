/**
 * Tests that private organizations are blocked at the REST / permalink endpoints.
 *
 * Covers: /id/:id (permalink handler).
 */

import { expect } from 'chai';
import sinon from 'sinon';

import { handlePermalink } from '../../../server/lib/permalink/handler';
import { createPrivateAccountFixture, type PrivateAccountFixture } from '../../test-helpers/private-account-fixture';
import { makeRequest, resetTestDB } from '../../utils';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type FakeUser = Awaited<ReturnType<typeof import('../../test-helpers/fake-data').fakeUser>>;

const invokePermalink = async (publicId: string, remoteUser: FakeUser | null) => {
  if (remoteUser) {
    await remoteUser.populateRoles();
  }

  const redirect = sinon.stub();
  const req = {
    ...makeRequest(remoteUser),
    params: { id: publicId },
  } as any;
  const res = { redirect } as any;
  await handlePermalink(req, res);
  return redirect;
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('server/routes/privateAccounts - permalink handler', () => {
  let ctx: PrivateAccountFixture;

  before(async function () {
    this.timeout(60_000);
    await resetTestDB();
    ctx = await createPrivateAccountFixture();
  });

  describe('/id/:id - Collective permalink', () => {
    it('redirects unauthenticated users to /signin for a private account', async () => {
      const redirect = await invokePermalink(ctx.privateCollective.publicId, null);
      expect(redirect.calledOnce).to.be.true;
      const destination: string = redirect.firstCall.args[1];
      // Unauthenticated → sign in redirect
      expect(destination).to.match(/\/(signin|access-denied)/);
    });

    it('redirects random authenticated users to /access-denied for a private account', async () => {
      const redirect = await invokePermalink(ctx.privateCollective.publicId, ctx.randomUser);
      expect(redirect.calledOnce).to.be.true;
      const destination: string = redirect.firstCall.args[1];
      expect(destination).to.eq('/access-denied');
    });

    it('redirects authorized (host admin) users to the collective dashboard', async () => {
      const redirect = await invokePermalink(ctx.privateCollective.publicId, ctx.privateHostAdmin);
      expect(redirect.calledOnce).to.be.true;
      const destination: string = redirect.firstCall.args[1];
      // Host admin should see a dashboard or collective page URL, not an error URL
      expect(destination).to.not.match(/\/(signin|access-denied|not-found)/);
    });

    it('redirects collective admin to the collective dashboard', async () => {
      const redirect = await invokePermalink(ctx.privateCollective.publicId, ctx.privateCollectiveAdmin);
      expect(redirect.calledOnce).to.be.true;
      const destination: string = redirect.firstCall.args[1];
      expect(destination).to.not.match(/\/(signin|access-denied|not-found)/);
    });

    it('does not affect public accounts (still redirectable)', async () => {
      const redirect = await invokePermalink(ctx.publicCollective.publicId, null);
      expect(redirect.calledOnce).to.be.true;
      const destination: string = redirect.firstCall.args[1];
      expect(destination).to.not.match(/\/(signin|access-denied|not-found)/);
    });
  });
});
