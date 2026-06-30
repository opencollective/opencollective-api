import { expect } from 'chai';
import config from 'config';

import handlebars from '../../../server/lib/handlebars';

describe('server/lib/handlebars permalink', () => {
  it('builds a permalink URL when publicId is set', () => {
    const template = handlebars.compile('{{permalink expense}}');
    const expense = { publicId: 'exp_abc123' };
    expect(template({ expense })).to.equal(`${config.host.website}/permalink/exp_abc123`);
  });

  it('returns fallbackURL when publicId is missing', () => {
    const template = handlebars.compile('{{permalink update url}}');
    const update = { title: 'Monthly update' };
    const url = `${config.host.website}/updates/monthly-update`;
    expect(template({ update, url })).to.equal(url);
  });

  it('prefers publicId over fallbackURL', () => {
    const template = handlebars.compile('{{permalink update url}}');
    const update = { publicId: 'upd_abc123', title: 'Monthly update' };
    const url = `${config.host.website}/updates/monthly-update`;
    expect(template({ update, url })).to.equal(`${config.host.website}/permalink/upd_abc123`);
  });

  it('throws when publicId and fallbackURL are missing', () => {
    const template = handlebars.compile('{{permalink expense}}');
    const expense = { description: 'Receipt' };
    expect(() => template({ expense })).to.throw('no publicId set, fallbackURL is required');
  });
});
