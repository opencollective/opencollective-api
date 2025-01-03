import { expect } from 'chai';
import { UniqueConstraintError } from 'sequelize';

import { fakeSocialLink } from '../../test-helpers/fake-data';

describe('server/models/SocialLink', () => {
  it('should throw a proper validation error when inserting a duplicate social link', async () => {
    const socialLink1 = await fakeSocialLink();
    await expect(
      fakeSocialLink({ CollectiveId: socialLink1.CollectiveId, type: socialLink1.type, url: socialLink1.url }),
    ).to.be.rejectedWith(UniqueConstraintError);
  });
});
