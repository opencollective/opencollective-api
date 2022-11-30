import '../../../server/lib/emailTemplates'; // To make sure templates are loaded

import { expect } from 'chai';

import handlebars from '../../../server/lib/handlebars';
import { fakeCollective } from '../../test-helpers/fake-data';

const template = handlebars.compile('{{> linkCollective collective=collective}}');

const DEFAULT_CONTEXT = { config: { host: { website: 'https://opencollective.com' } } };

describe('templates/partials/link-collective', () => {
  it('should render a link to a collective', async () => {
    const collective = (await fakeCollective({ name: 'Test Collective' })).activity;
    const result = template({ ...DEFAULT_CONTEXT, collective });
    expect(result).to.eq(`<a href="https://opencollective.com/${collective.slug}">Test Collective</a>`);
  });

  it('should render a link to a collective with a custom text', async () => {
    const collective = (await fakeCollective({ name: 'Test Collective' })).activity;
    const result = template({ ...DEFAULT_CONTEXT, collective, text: 'Hello World' });
    expect(result).to.eq(`<a href="https://opencollective.com/${collective.slug}">Hello World</a>`);
  });
});
