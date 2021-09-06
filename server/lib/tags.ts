import { uniq } from 'lodash';

/**
 * Throws if there are too many tags, of if some are too long/too short.
 */
export const validateTags = (tags: string[] | null, { maxNbTags = 30, maxTagLength = 32 } = {}): void => {
  if (tags) {
    // Limit to max 30 tags
    if (tags.length > maxNbTags) {
      throw new Error(
        `Sorry, you can't add more than ${maxNbTags} tags. Please remove ${maxNbTags - tags.length} tag(s).`,
      );
    }

    // Validate each individual tags
    tags.forEach(tag => {
      if (tag.length === 0) {
        throw new Error("Can't add empty tags");
      } else if (tag.length > maxTagLength) {
        throw new Error(`Tag ${tag} is too long, must me shorter than 32 characters`);
      }
    });
  }
};

/**
 * Trim and lowercase all tags, then remove empty tags and duplicates.
 */
export const sanitizeTags = (tags: string[] | null): string[] => {
  const cleanTag = tag => (!tag ? null : tag.trim().toLowerCase().replace(/\s+/g, ' '));
  const sanitizedTags = !tags ? [] : tags.map(cleanTag);
  const filteredTags = sanitizedTags.filter(Boolean);
  return uniq(filteredTags);
};
