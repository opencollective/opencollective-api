import { uniq } from 'lodash';

export const validateTags = (tags: string[]): void => {
  if (tags) {
    // Limit to max 30 tags
    if (tags.length > 30) {
      throw new Error(`Sorry, you can't add more than 30 tags. Please remove ${30 - tags.length} tag(s).`);
    }

    // Validate each individual tags
    tags.forEach(tag => {
      if (tag.length === 0) {
        throw new Error("Can't add empty tags");
      } else if (tag.length > 32) {
        throw new Error(`Tag ${tag} is too long, must me shorter than 32 characters`);
      }
    });
  }
};

export function setTags(tags?: string[]) {
  if (tags) {
    tags = uniq(
      tags
        .map(tag => {
          if (tag) {
            const upperCase = tag.toUpperCase();
            return upperCase.trim().replace(/\s+/g, ' ');
          }
        })
        .filter(tag => {
          return tag && tag.length > 0;
        }),
    );
  }

  if (!tags || tags.length === 0) {
    this.setDataValue('tags', null);
  } else if (tags) {
    this.setDataValue('tags', tags);
  }
}
