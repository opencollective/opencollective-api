import { expect } from 'chai';

import { moveSection, removeSection } from '../../../migrations/lib/helpers';

describe('migrations/lib/helpers', () => {
  describe('moveSection', () => {
    it('Returns original settings if not supported by the collective', () => {
      const settings = {};
      expect(moveSection(settings, 'test', 'test')).to.eq(settings);
    });

    it('Returns original settings if no change', () => {
      const settings = { collectivePage: { sections: [{ type: 'CATEGORY', name: 'BUDGET', sections: [] }] } };
      expect(moveSection(settings, 'test', 'test')).to.eq(settings);
    });

    it('Moves the section in the right category', () => {
      const settings = {
        collectivePage: {
          sections: [
            { type: 'CATEGORY', name: 'BUDGET', sections: [{ type: 'SECTION', name: 'test' }] },
            { type: 'SECTION', name: 'newSection' },
          ],
        },
      };

      expect(moveSection(settings, 'newSection', 'BUDGET')).to.deep.eq({
        collectivePage: {
          sections: [
            {
              type: 'CATEGORY',
              name: 'BUDGET',
              sections: [
                { type: 'SECTION', name: 'test' },
                { type: 'SECTION', name: 'newSection' },
              ],
            },
          ],
        },
      });
    });

    it('Creates the category if it does not exist', () => {
      const settings = {
        collectivePage: {
          sections: [{ type: 'SECTION', name: 'newSection' }],
        },
      };

      expect(moveSection(settings, 'newSection', 'BUDGET')).to.deep.eq({
        collectivePage: {
          sections: [
            {
              type: 'CATEGORY',
              name: 'BUDGET',
              sections: [{ type: 'SECTION', name: 'newSection' }],
            },
          ],
        },
      });
    });
  });

  describe('removeSection', () => {
    it('Returns original settings if not supported by the collective', () => {
      const settings = {};
      expect(removeSection(settings, 'test')).to.eq(settings);
    });

    it('Returns original settings if no change', () => {
      const settings = { collectivePage: { sections: [{ type: 'CATEGORY', name: 'BUDGET', sections: [] }] } };
      expect(removeSection(settings, 'test')).to.eq(settings);
    });

    it('Returns original settings if no change in nested section', () => {
      const settings = {
        collectivePage: {
          sections: [
            {
              type: 'CATEGORY',
              name: 'BUDGET',
              sections: [{ type: 'SECTION', name: 'test' }],
            },
          ],
        },
      };
      expect(removeSection(settings, 'test')).to.eq(settings);
    });

    it('Removes the section', () => {
      const settings = {
        collectivePage: {
          sections: [
            { type: 'CATEGORY', name: 'BUDGET', sections: [{ type: 'SECTION', name: 'test' }] },
            { type: 'SECTION', name: 'newSection' },
          ],
        },
      };

      expect(removeSection(settings, 'newSection')).to.deep.eq({
        collectivePage: {
          sections: [{ type: 'CATEGORY', name: 'BUDGET', sections: [{ type: 'SECTION', name: 'test' }] }],
        },
      });
    });

    it('Removes the nested section', () => {
      const settings = {
        collectivePage: {
          sections: [
            { type: 'CATEGORY', name: 'BUDGET', sections: [{ type: 'SECTION', name: 'test' }] },
            { type: 'SECTION', name: 'newSection' },
          ],
        },
      };

      expect(removeSection(settings, 'test', 'BUDGET')).to.deep.eq({
        collectivePage: {
          sections: [
            { type: 'CATEGORY', name: 'BUDGET', sections: [] },
            { type: 'SECTION', name: 'newSection' },
          ],
        },
      });
    });
  });
});
