import { expect } from 'chai';

import handlebars from '../../../server/lib/handlebars';
import { fakeCollective, fakeUser } from '../../test-helpers/fake-data';

const template = handlebars.compile('{{> greeting}}');

describe('templates/partials/greeting', () => {
  it('should render a generic greeting without a recipient', async () => {
    const result = template({});
    expect(result).to.eq(`<p>Hi,</p>\n`);
  });

  it('should render a collective name in greeting', async () => {
    const collective = await fakeCollective({ name: 'Test Collective' });
    const result = template({ recipientName: collective.name });
    expect(result).to.eq(`<p>Hi Test Collective,</p>\n`);
  });

  it('should render a user name in greeting', async () => {
    const user = await fakeUser();
    const result = template({ recipientName: user.collective.name });
    // The fake user has a randomly generated name, so we don't attempt full equality.
    expect(result).to.include(`<p>Hi User`);
  });
});
