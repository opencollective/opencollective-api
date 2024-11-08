import levenshtein from 'fast-levenshtein';

/**
 * Example: "crème brulée => "creme brulee"
 */
export const removeDiacritics = str => {
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
};

/**
 * Converts common number substitutions to their letter equivalent, concretely converting
 * 1773 speak to English.
 */
const convertCommonNumberSubstitutions = str => {
  return str
    .replace(/[@4]/g, 'a')
    .replace(/3/g, 'e')
    .replace(/1/g, 'i')
    .replace(/0/g, 'o')
    .replace(/5/g, 's')
    .replace(/7/g, 't')
    .replace(/8/g, 'b')
    .replace(/9/g, 'g');
};

export const containsProtectedBrandName = (str: string): boolean => {
  if (!str) {
    return false;
  }

  const sanitizedStr = [
    str => str.toLowerCase(),
    removeDiacritics, // é => e, ç => c...etc
    convertCommonNumberSubstitutions, // 0 => o, 1 => i...etc
    str => str.replace(/[^a-z0-9]/g, ''), // Remove special characters that haven't been replaced by the previous processors
  ].reduce((acc, processor) => processor(acc), str);

  const protectedBrandNames = ['opencollective', 'ofitech', 'ofico'];
  return protectedBrandNames.some(brand => {
    // If the brand is included in the name (e.g. "Super OpenCollective Foundation") return directly
    if (sanitizedStr.includes(brand)) {
      return true;
    }

    // Otherwise, compute the distance between the sanitized name and the brand
    const distance = levenshtein.get(sanitizedStr, brand);
    return distance <= 2;
  });
};
