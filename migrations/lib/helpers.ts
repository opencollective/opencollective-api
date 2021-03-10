import { cloneDeep, remove } from 'lodash';

/**
 * Moves a section inside a category
 */
export const moveSection = (
  existingSettings: Record<string, unknown>,
  sectionName: string,
  newCategoryName: string,
): Record<string, unknown> => {
  if (!existingSettings?.collectivePage?.['sections']) {
    return existingSettings;
  }

  const settings = cloneDeep(existingSettings);
  const sections = settings.collectivePage['sections'];
  const [section] = remove(sections, s => s['name'] === sectionName);

  if (!section) {
    return existingSettings;
  }

  const category = sections.find(s => s.type === 'CATEGORY' && s.name === newCategoryName);
  if (category) {
    if (!category.sections) {
      category.sections = [section];
    } else if (!category.sections.find(s => s.name === sectionName)) {
      category.sections.push(section);
    }
  } else {
    sections.push({
      type: 'CATEGORY',
      name: newCategoryName,
      sections: [section],
    });
  }

  return settings;
};

/**
 * Update settings, removing the section
 */
export const removeSection = (
  existingSettings: Record<string, unknown>,
  sectionName: string,
): Record<string, unknown> => {
  if (!existingSettings?.collectivePage?.['sections']) {
    return existingSettings;
  }

  const settings = cloneDeep(existingSettings);
  const sections = settings.collectivePage['sections'];
  const [section] = remove(sections, s => s['name'] === sectionName);

  if (!section) {
    return existingSettings;
  } else {
    return settings;
  }
};
