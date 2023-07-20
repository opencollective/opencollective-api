import { uniq } from 'lodash-es';

/**
 * Tags that should be transformed to another tag (only for common tags that refer to the same thing but with a different formatting)
 * The key is the tag to transform and the value is the tag to transform to
 */
//
const tagTransforms = {
  opensource: 'open source',
  'open-source': 'open source',
};

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
        throw new Error(`Tag ${tag} is too long, must be shorter than 32 characters`);
      }
    });
  }
};

/**
 * Sanitizes tags and remove duplicates.
 * Returns null if the list is or becomes empty.
 */
export const sanitizeTags = (tags: string[] | string | null): string[] | null => {
  if (!tags) {
    return null;
  } else if (typeof tags === 'string') {
    tags = [tags];
  }

  const sanitizedTags = tags
    .filter(Boolean) // Remove null values
    .flatMap(t => t.split(',')) // Split tags that contain commas
    .map(t => t.trim()) // Trim tags
    .map(t => t.toLowerCase()) // Lowercase
    .map(t => t.replace(/\s+/g, ' ')) // Replace multiple spaces with one
    .map(t => t.replace(/^#+/g, '')) // Remove # prefixes
    .map(t => t.trim()) // Trim again for empty tags with a # prefix
    .map(t => tagTransforms[t] || t) // Transform common formatting variations of popular tags
    .filter(t => t.length > 0); // Remove empty tags

  // Remove duplicates
  const uniqueTags = uniq(sanitizedTags);

  return uniqueTags.length > 0 ? uniqueTags : null;
};
