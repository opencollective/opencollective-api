import { expect } from 'chai';
import config from 'config';

import { getEditRecurringContributionsUrl } from '../../../server/lib/url-utils';
import { fakeOrganization, fakeUser } from '../../test-helpers/fake-data';

describe('server/lib/url-utils', () => {
  describe('getEditRecurringContributionsUrl', () => {
    it('generates link for user', async () => {
      const user = await fakeUser();
      expect(getEditRecurringContributionsUrl(user.collective)).to.equal(
        `${config.host.website}/dashboard/${user.collective.slug}/outgoing-contributions?status=ACTIVE&status=ERROR&type=RECURRING`,
      );
    });

    it('generates link for organization', async () => {
      const org = await fakeOrganization();
      expect(getEditRecurringContributionsUrl(org)).to.equal(
        `${config.host.website}/dashboard/${org.slug}/outgoing-contributions?status=ACTIVE&status=ERROR&type=RECURRING`,
      );
    });
  });
});
