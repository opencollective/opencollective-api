import '../../../server/lib/emailTemplates'; // To make sure templates are loaded

import { expect } from 'chai';
import config from 'config';

import handlebars from '../../../server/lib/handlebars';
import { fakeCollective, fakeProject } from '../../test-helpers/fake-data';

const template = handlebars.compile('{{> linkCollective collective=collective}}');

describe('templates/partials/link-collective', () => {
  it('should render a link to a collective', async () => {
    const collective = (await fakeCollective({ name: 'Test Collective' })).activity;
    const result = template({ collective });
    expect(result).to.eq(`<a href="${config.host.website}/${collective.slug}">Test Collective</a>`);
  });

  it('should render a link to a collective with a custom text', async () => {
    const collective = (await fakeCollective({ name: 'Test Collective' })).activity;
    const result = template({ collective, text: 'Hello World' });
    expect(result).to.eq(`<a href="${config.host.website}/${collective.slug}">Hello World</a>`);
  });

  it('should render a link to a collective with a parent collective', async () => {
    const parentCollective = (await fakeCollective({ name: 'Parent Collective' })).activity;
    const project = (await fakeProject({ name: 'Test Project', ParentCollectiveId: parentCollective.id })).activity;
    const result = template({ collective: project, _parentCollective: parentCollective });
    expect(result).to.eq(
      `<a href="${config.host.website}/${parentCollective.slug}/projects/${project.slug}">Parent Collective → Test Project</a>`,
    );
  });
});
