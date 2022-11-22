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
    const result = template({ recipientName: 'Test Collective' });
    expect(result).to.eq(`<p>Hi Test Collective,</p>\n`);
  });

});
