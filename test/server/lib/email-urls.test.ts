import { expect } from 'chai';
import config from 'config';

import { CollectiveType } from '../../../server/constants/collectives';
import {
  getAccountUrl,
  getAccountUrlWithParent,
  getCollectiveExpensesUrl,
  getExpenseUrl,
  getPermalinkUrl,
} from '../../../server/lib/email-urls';

describe('server/lib/email-urls', () => {
  describe('getPermalinkUrl', () => {
    it('returns a full permalink URL when publicId is set', () => {
      expect(getPermalinkUrl('acc_abc123')).to.equal(`${config.host.website}/permalink/acc_abc123`);
    });

    it('returns null when publicId is missing', () => {
      expect(getPermalinkUrl(null)).to.be.null;
    });
  });

  describe('getAccountUrl', () => {
    it('returns a permalink for private accounts with a publicId', () => {
      expect(getAccountUrl({ slug: 'secret-org', publicId: 'acc_private', isPrivate: true })).to.equal(
        `${config.host.website}/permalink/acc_private`,
      );
    });

    it('returns the public profile URL for public accounts', () => {
      expect(getAccountUrl({ slug: 'public-org', publicId: 'acc_public', isPrivate: false })).to.equal(
        `${config.host.website}/public-org`,
      );
    });

    it('falls back to the dashboard URL when private account has no publicId', () => {
      expect(getAccountUrl({ slug: 'secret-org', isPrivate: true })).to.equal(
        `${config.host.website}/dashboard/secret-org`,
      );
    });
  });

  describe('getAccountUrlWithParent', () => {
    it('returns a permalink for private child accounts', () => {
      expect(
        getAccountUrlWithParent(
          { slug: 'secret-project', publicId: 'acc_project', isPrivate: true, type: CollectiveType.PROJECT },
          { slug: 'parent-org' },
        ),
      ).to.equal(`${config.host.website}/permalink/acc_project`);
    });

    it('returns the nested public URL for public child accounts', () => {
      expect(
        getAccountUrlWithParent(
          { slug: 'public-project', isPrivate: false, type: CollectiveType.PROJECT },
          { slug: 'parent-org' },
        ),
      ).to.equal(`${config.host.website}/parent-org/projects/public-project`);
    });
  });

  describe('getCollectiveExpensesUrl', () => {
    it('returns a dashboard URL for private collectives', () => {
      expect(getCollectiveExpensesUrl({ slug: 'secret-org', isPrivate: true })).to.equal(
        `${config.host.website}/dashboard/secret-org/payment-requests`,
      );
    });

    it('returns the public expenses page for public collectives', () => {
      expect(getCollectiveExpensesUrl({ slug: 'public-org', isPrivate: false })).to.equal(
        `${config.host.website}/public-org/expenses`,
      );
    });
  });

  describe('getExpenseUrl', () => {
    it('uses a permalink for private collectives when available', () => {
      expect(
        getExpenseUrl(
          { id: 42, publicId: 'exp_private' },
          { slug: 'secret-org', isPrivate: true },
          { key: 'draft-key' },
        ),
      ).to.equal(`${config.host.website}/permalink/exp_private?key=draft-key`);
    });
  });
});
