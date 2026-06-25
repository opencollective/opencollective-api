import { CountryCode, getCountrySubdivisions, isValidCountrySubdivisionCode } from 'lib-address';

/**
 * Normalize a zone value (state/province/emirate) to a lib-address subdivision code.
 * Accepts ISO codes or full subdivision names (including latin variants).
 * Returns the original value when no match is found.
 */
export function normalizeZoneCode(country: string | null | undefined, zone: string | null | undefined): string | null {
  if (zone === null || zone === undefined) {
    return null;
  }

  const trimmedZone = zone.trim();
  if (!trimmedZone || !country) {
    return trimmedZone || null;
  }

  if (isValidCountrySubdivisionCode(country as CountryCode, trimmedZone)) {
    return trimmedZone;
  }

  const normalizedInput = trimmedZone.toLowerCase();

  for (const useLatin of [false, true]) {
    const subdivisions = getCountrySubdivisions(country as CountryCode, { useLatin });
    const match = subdivisions.find(
      subdivision =>
        subdivision.value.toLowerCase() === normalizedInput || subdivision.label.toLowerCase() === normalizedInput,
    );

    if (match) {
      return match.value;
    }
  }

  return trimmedZone;
}
