'use strict';

import { cloneDeep, remove } from 'lodash';

const Sections = {
  TOP_FINANCIAL_CONTRIBUTORS: 'top-financial-contributors',
  CONNECTED_COLLECTIVES: 'connected-collectives',
  OUR_TEAM: 'our-team',
  GOALS: 'goals',
  UPDATES: 'updates',
  CONVERSATIONS: 'conversations',
  RECURRING_CONTRIBUTIONS: 'recurring-contributions',
  TICKETS: 'tickets',
  LOCATION: 'location',
  // Navigation v2 main sections
  // CONTRIBUTE/CONTRIBUTIONS
  CONTRIBUTE: 'contribute',
  CONTRIBUTIONS: 'contributions',
  // EVENTS/PROJECTS
  EVENTS: 'events',
  PROJECTS: 'projects',
  // BUDGET/TRANSACTIONS
  TRANSACTIONS: 'transactions',
  BUDGET: 'budget',
  // CONTRIBUTORS/PARTICIPANTS - is this a stand alone or in BUDGET as per Figma??
  CONTRIBUTORS: 'contributors',
  PARTICIPANTS: 'participants',
  // ABOUT
  ABOUT: 'about',
  // EMPTY for new collectives/no data in any category sections
  EMPTY: 'empty',
};

const NAVBAR_CATEGORIES = {
  ABOUT: 'ABOUT',
  BUDGET: 'BUDGET',
  CONNECT: 'CONNECT',
  CONTRIBUTE: 'CONTRIBUTE',
  CONTRIBUTIONS: 'CONTRIBUTIONS',
  EVENTS: 'EVENTS', // Events, projects, connected collectives
};

/**
 * Map sections to their categories. Any section that's not in this object will be considered
 * as a "Widget" (aka. a section without navbar category).
 */
const SECTIONS_CATEGORIES = {
  // About
  [Sections.OUR_TEAM]: NAVBAR_CATEGORIES.ABOUT,
  [Sections.ABOUT]: NAVBAR_CATEGORIES.ABOUT,
  [Sections.LOCATION]: NAVBAR_CATEGORIES.ABOUT,
  // Connect
  [Sections.CONVERSATIONS]: NAVBAR_CATEGORIES.CONNECT,
  [Sections.UPDATES]: NAVBAR_CATEGORIES.CONNECT,
  // Contribute
  [Sections.TICKETS]: NAVBAR_CATEGORIES.CONTRIBUTE,
  [Sections.CONTRIBUTE]: NAVBAR_CATEGORIES.CONTRIBUTE,
  [Sections.CONTRIBUTORS]: NAVBAR_CATEGORIES.CONTRIBUTE,
  [Sections.TOP_FINANCIAL_CONTRIBUTORS]: NAVBAR_CATEGORIES.CONTRIBUTE,
  // Contributions
  [Sections.CONTRIBUTIONS]: NAVBAR_CATEGORIES.CONTRIBUTIONS,
  [Sections.RECURRING_CONTRIBUTIONS]: NAVBAR_CATEGORIES.CONTRIBUTIONS,
  // Budget
  [Sections.BUDGET]: NAVBAR_CATEGORIES.BUDGET,
  // Events/Projects
  [Sections.EVENTS]: NAVBAR_CATEGORIES.CONTRIBUTE,
  [Sections.PROJECTS]: NAVBAR_CATEGORIES.CONTRIBUTE,
};

const normalizeLegacySection = section => {
  if (typeof section === 'string') {
    return { section, isEnabled: true };
  } else {
    return section;
  }
};

const convertSectionToNewFormat = ({ section, isEnabled, restrictedTo = null }) => ({
  type: 'SECTION',
  name: section,
  isEnabled,
  restrictedTo,
});

/**
 * Converts legacy sections to their new format
 */
const convertSectionsToNewFormat = (sections, collectiveType) => {
  const sectionsToConvert = sections.map(normalizeLegacySection);
  const convertedSections = [];

  if (!sectionsToConvert.length) {
    return [];
  }

  do {
    const section = sectionsToConvert[0];
    const category = SECTIONS_CATEGORIES[section.section];

    if (section.type) {
      // Already new format
      sectionsToConvert.shift();
    } else if (!category) {
      // Simple case: section is a widget (not part of any category)
      convertedSections.push(convertSectionToNewFormat(section));
      sectionsToConvert.shift();
    } else {
      // If part of a category, create it and store all alike sections
      const allCategorySections = remove(sectionsToConvert, s => SECTIONS_CATEGORIES[s.section] === category);
      const convertedSubSections = allCategorySections.map(convertSectionToNewFormat);

      if (category === NAVBAR_CATEGORIES.CONTRIBUTE) {
        // We want to make sure TOP_FINANCIAL_CONTRIBUTORS and EVENTS are inserted at the right place
        const contributeSectionIdx = convertedSubSections.findIndex(s => s.name === Sections.CONTRIBUTE);
        if (contributeSectionIdx !== -1) {
          const sectionsToAdd = [Sections.TOP_FINANCIAL_CONTRIBUTORS];
          if (collectiveType === 'COLLECTIVE') {
            sectionsToAdd.unshift(Sections.EVENTS, Sections.CONNECTED_COLLECTIVES);
          }

          remove(convertedSubSections, s => sectionsToAdd.includes(s.name));
          const convertedSubSectionsToAdd = sectionsToAdd.map(name => ({ type: 'SECTION', isEnabled: true, name }));
          convertedSubSections.splice(contributeSectionIdx + 1, 0, ...convertedSubSectionsToAdd);
        }

        // Contributors is replaced by "Our team" for organizations. We can remove it safely
        if (collectiveType === 'ORGANIZATION') {
          const contributorsIdx = convertedSubSections.findIndex(s => s.name === Sections.CONTRIBUTORS);
          if (contributorsIdx !== -1) {
            convertedSubSections.splice(contributorsIdx, 1);
          }
        }
      }

      convertedSections.push({
        type: 'CATEGORY',
        name: category || 'Other',
        sections: convertedSubSections,
        isEnabled: true,
      });
    }
  } while (sectionsToConvert.length > 0);

  return convertedSections;
};

/**
 * Migrate collective sections to the new format, saving a backup in `legacySectionsBackup`
 */
module.exports = {
  up: async queryInterface => {
    // Remove customization made so far with the new navbar to start from clean data (only affects staging & dev)
    await queryInterface.sequelize.query(`
      UPDATE "Collectives"
      SET settings = JSONB_SET(
        JSONB_SET(settings, '{collectivePage,sections}', 'null'),
        '{collectivePage,useNewSections}',
        'false'
      )
      WHERE settings -> 'collectivePage' -> 'sections' IS NOT NULL
      AND (settings -> 'collectivePage' ->> 'useNewSections')::boolean IS TRUE
    `);

    // Migrate all sections
    const [collectives] = await queryInterface.sequelize.query(`
      SELECT id, "type", settings
      FROM "Collectives" c
      WHERE settings -> 'collectivePage' -> 'sections' IS NOT NULL
      AND (settings -> 'collectivePage' ->> 'useNewSections')::boolean IS NOT TRUE
    `);

    for (const collective of collectives) {
      const settings = cloneDeep(collective.settings);
      if (!settings.collectivePage.sections) {
        continue;
      }

      settings.collectivePage.legacySectionsBackup = settings.collectivePage.sections;
      settings.collectivePage.sections = convertSectionsToNewFormat(settings.collectivePage.sections, collective.type);
      settings.collectivePage.useNewSections = true;

      await queryInterface.sequelize.query(`UPDATE "Collectives" SET settings = :settings WHERE id = :id`, {
        replacements: { settings: JSON.stringify(settings), id: collective.id },
      });
    }
  },

  down: async queryInterface => {
    await queryInterface.sequelize.query(`
      UPDATE "Collectives"
      SET settings = JSONB_SET(
        JSONB_SET(
          settings,
          '{collectivePage,sections}',
          settings -> 'collectivePage' -> 'legacySectionsBackup'
        ),
        '{collectivePage,useNewSections}',
        'false'
      )
      WHERE settings -> 'collectivePage' -> 'sections' IS NOT NULL
      AND settings -> 'collectivePage' -> 'legacySectionsBackup' IS NOT NULL
      AND (settings -> 'collectivePage' ->> 'useNewSections')::boolean IS TRUE
    `);
  },
};
