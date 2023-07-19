import { expect } from 'chai';
import config from 'config';

import { getEditRecurringContributionsUrl } from '../../../server/lib/url-utils.js';
import { fakeOrganization, fakeUser } from '../../test-helpers/fake-data.js';

describe('server/lib/url-utils', () => {
  describe('getEditRecurringContributionsUrl', () => {
    it('generates link for user', async () => {
      const user = await fakeUser();
      expect(getEditRecurringContributionsUrl(user.collective)).to.equal(`${config.host.website}/manage-contributions`);
    });

    it('generates link for organization', async () => {
      const org = await fakeOrganization();
      expect(getEditRecurringContributionsUrl(org)).to.equal(`${config.host.website}/${org.slug}/manage-contributions`);
    });
  });
});
