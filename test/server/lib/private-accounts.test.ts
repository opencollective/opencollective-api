import { expect } from 'chai';
import type { Request } from 'express';
import { stub } from 'sinon';

import { Forbidden } from '../../../server/graphql/errors';
import {
  assertCanSeeAccount,
  assertCanSeeAllAccounts,
  canSeeAllPrivateAccounts,
  canSeePrivateAccount,
} from '../../../server/lib/private-accounts';

type MinimalCollective = { id: number; isPrivate: boolean };

function mockReq(canSeeById: Record<number, boolean>): Request {
  const load = stub().callsFake((id: number) => Promise.resolve(Boolean(canSeeById[id])));
  const loadMany = stub().callsFake((ids: number[]) => Promise.resolve(ids.map(id => Boolean(canSeeById[id]))));
  return {
    loaders: {
      Collective: {
        canSeePrivateAccount: { load, loadMany },
      },
    },
  } as unknown as Request;
}

describe('server/lib/private-accounts', () => {
  describe('canSeePrivateAccount', () => {
    it('returns true without using the loader when the account is not private', async () => {
      const req = mockReq({});
      const account = { id: 1, isPrivate: false } as MinimalCollective;
      const result = await canSeePrivateAccount(req, account as never);
      expect(result).to.be.true;
      expect(req.loaders.Collective.canSeePrivateAccount.load).to.not.have.been.called;
    });

    it('delegates to canSeePrivateAccount loader when the account is private', async () => {
      const req = mockReq({ 99: true });
      const account = { id: 99, isPrivate: true } as MinimalCollective;
      const result = await canSeePrivateAccount(req, account as never);
      expect(result).to.be.true;
      expect(req.loaders.Collective.canSeePrivateAccount.load).to.have.been.calledOnceWithExactly(99);
    });
  });

  describe('canSeeAllPrivateAccounts', () => {
    it('returns true when there are no private accounts (loader not used)', async () => {
      const req = mockReq({});
      const accounts = [
        { id: 1, isPrivate: false },
        { id: 2, isPrivate: false },
      ] as MinimalCollective[];
      const result = await canSeeAllPrivateAccounts(req, accounts as never[]);
      expect(result).to.be.true;
      expect(req.loaders.Collective.canSeePrivateAccount.loadMany).to.not.have.been.called;
    });

    it('returns true when every private account passes the loader', async () => {
      const req = mockReq({ 10: true, 11: true });
      const accounts = [
        { id: 10, isPrivate: true },
        { id: 11, isPrivate: true },
      ] as MinimalCollective[];
      const result = await canSeeAllPrivateAccounts(req, accounts as never[]);
      expect(result).to.be.true;
      expect(req.loaders.Collective.canSeePrivateAccount.loadMany).to.have.been.calledOnceWithExactly([10, 11]);
    });

    it('returns false when any private account fails the loader', async () => {
      const req = mockReq({ 10: true, 11: false });
      const accounts = [
        { id: 10, isPrivate: true },
        { id: 11, isPrivate: true },
      ] as MinimalCollective[];
      const result = await canSeeAllPrivateAccounts(req, accounts as never[]);
      expect(result).to.be.false;
    });
  });

  describe('assertCanSeeAccount', () => {
    it('does not throw when the account is not private', async () => {
      const req = mockReq({});
      const account = { id: 1, isPrivate: false } as MinimalCollective;
      await assertCanSeeAccount(req, account as never);
      expect(req.loaders.Collective.canSeePrivateAccount.load).to.not.have.been.called;
    });

    it('does not throw when the account is private and the loader allows access', async () => {
      const req = mockReq({ 42: true });
      const account = { id: 42, isPrivate: true } as MinimalCollective;
      await assertCanSeeAccount(req, account as never);
    });

    it('throws Forbidden when the account is private and the loader denies access', async () => {
      const req = mockReq({ 7: false });
      const account = { id: 7, isPrivate: true } as MinimalCollective;
      await expect(assertCanSeeAccount(req, account as never)).to.be.rejectedWith(
        Forbidden,
        'This account is private. You must be a member to view it.',
      );
    });
  });

  describe('assertCanSeeAllAccounts', () => {
    it('throws when canSeeAllPrivateAccounts is false', async () => {
      const req = mockReq({ 10: false });
      const accounts = [{ id: 10, isPrivate: true }] as MinimalCollective[];
      await expect(assertCanSeeAllAccounts(req, accounts as never[])).to.be.rejectedWith(
        Forbidden,
        'One or more of the accounts are private. You must be a member to view them.',
      );
    });

    it('does not throw when all private accounts are visible', async () => {
      const req = mockReq({ 10: true });
      const accounts = [{ id: 10, isPrivate: true }] as MinimalCollective[];
      await assertCanSeeAllAccounts(req, accounts as never[]);
    });
  });
});
