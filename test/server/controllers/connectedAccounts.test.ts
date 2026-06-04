import { expect } from 'chai';
import { createSandbox } from 'sinon';

import { Service } from '../../../server/constants/connected-account';
import { disconnect } from '../../../server/controllers/connectedAccounts';
import { fakeCollective, fakeConnectedAccount, fakeUser } from '../../test-helpers/fake-data';

describe('server/controllers/connectedAccounts', () => {
  describe('disconnect', () => {
    const sandbox = createSandbox();
    after(sandbox.restore);
    beforeEach(sandbox.restore);

    const makeReqRes = (params, remoteUser?) => {
      const res = {
        _body: null as unknown,
        send(body) {
          this._body = body;
        },
      };
      const req = { params, remoteUser };
      return { req, res };
    };

    it('returns an error when not logged in', async () => {
      const collective = await fakeCollective();
      const { req, res } = makeReqRes({ collectiveId: collective.id, service: Service.TRANSFERWISE });

      await disconnect(req as any, res as any);

      expect((res._body as any).error.message).to.match(/must be logged in/i);
    });

    it('returns an error when user is not an admin of the collective', async () => {
      const collective = await fakeCollective();
      const remoteUser = await fakeUser();
      await remoteUser.populateRoles();

      const { req, res } = makeReqRes({ collectiveId: collective.id, service: Service.TRANSFERWISE }, remoteUser);

      await disconnect(req as any, res as any);

      expect((res._body as any).error.message).to.match(/not authorized/i);
    });

    it('deletes a TransferWise connected account that has no mirrored accounts', async () => {
      const remoteUser = await fakeUser();
      const collective = await fakeCollective({ admin: remoteUser });
      await remoteUser.populateRoles();

      await fakeConnectedAccount({ CollectiveId: collective.id, service: Service.TRANSFERWISE });

      const { req, res } = makeReqRes({ collectiveId: collective.id, service: Service.TRANSFERWISE }, remoteUser);

      await disconnect(req as any, res as any);

      expect((res._body as any).deleted).to.be.true;
      expect((res._body as any).service).to.equal(Service.TRANSFERWISE);
    });

    it('returns an error when trying to delete a TransferWise connected account that has a mirrored account', async () => {
      const remoteUser = await fakeUser();
      const collective = await fakeCollective({ admin: remoteUser });
      const mirroringCollective = await fakeCollective();
      await remoteUser.populateRoles();

      const twAccount = await fakeConnectedAccount({ CollectiveId: collective.id, service: Service.TRANSFERWISE });
      // Create a mirrored account that references the original
      await fakeConnectedAccount({
        CollectiveId: mirroringCollective.id,
        service: Service.TRANSFERWISE,
        data: { MirrorConnectedAccountId: twAccount.id },
      });

      const { req, res } = makeReqRes({ collectiveId: collective.id, service: Service.TRANSFERWISE }, remoteUser);

      await disconnect(req as any, res as any);

      expect((res._body as any).error).to.exist;
      expect((res._body as any).error.message).to.match(/mirrored/i);
    });

    it('deletes non-TransferWise connected accounts without checking for mirrors', async () => {
      const remoteUser = await fakeUser();
      const collective = await fakeCollective({ admin: remoteUser });
      await remoteUser.populateRoles();

      await fakeConnectedAccount({ CollectiveId: collective.id, service: Service.GITHUB });

      const { req, res } = makeReqRes({ collectiveId: collective.id, service: Service.GITHUB }, remoteUser);

      await disconnect(req as any, res as any);

      expect((res._body as any).deleted).to.be.true;
      expect((res._body as any).service).to.equal(Service.GITHUB);
    });
  });
});
