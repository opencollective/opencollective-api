import '../../../server/lib/emailTemplates'; // To make sure templates are loaded

import { expect } from 'chai';

import handlebars from '../../../server/lib/handlebars';

const template = handlebars.compile('{{> greeting}}');
const templateWithRecipient = handlebars.compile('{{> greeting recipient=recipient}}');

describe('templates/partials/greeting', () => {
  describe('base', () => {
    it('should render a generic greeting without a recipient', async () => {
      const result = template({});
      expect(result).to.eq(`Hi,\n`);
    });

    it('should render a collective name', async () => {
      const result = template({ recipientName: 'Test Collective' });
      expect(result).to.eq(`Hi Test Collective,\n`);
    });
  });

  describe('with a recipient', () => {
    it('should render a generic greeting without a recipient', async () => {
      const result = templateWithRecipient({});
      expect(result).to.eq(`Hi,\n`);
    });

    it('should render a collective name', async () => {
      const result = templateWithRecipient({ recipient: { name: 'Test Collective' } });
      expect(result).to.eq(`Hi Test Collective,\n`);
    });
  });
});
