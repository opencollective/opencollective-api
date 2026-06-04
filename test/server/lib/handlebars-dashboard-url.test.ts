import { expect } from 'chai';
import config from 'config';

import handlebars from '../../../server/lib/handlebars';

describe('server/lib/handlebars dashboardUrl', () => {
  it('builds a dashboard URL without leaking Handlebars options into query params', () => {
    const template = handlebars.compile("{{dashboardUrl collective 'transactions'}}");
    const collective = { slug: 'my-org' };
    expect(template({ collective })).to.equal(`${config.host.website}/dashboard/my-org/transactions`);
  });

  it('passes explicit query params', () => {
    const template = handlebars.compile('{{{dashboardUrl collective section params}}}');
    const collective = { slug: 'my-org' };
    const section = 'outgoing-contributions';
    const params = { orderId: 123 };
    expect(template({ collective, section, params })).to.equal(
      `${config.host.website}/dashboard/my-org/outgoing-contributions?orderId=123`,
    );
  });
});
