/**
 * Helpers to hand values to code compiled from Bend.
 *
 * The compiled code trusts what it is given: it reads a missing boolean as `false` and an unknown constructor as
 * "none of the cases". Either could silently turn a denial into an approval, so every value is checked here first,
 * and a bad one throws rather than reaching the decision.
 */

export const toBendBool = (value: boolean, name: string): boolean => {
  if (typeof value !== 'boolean') {
    throw new Error(`Bend interop: "${name}" must be a boolean, got ${value === null ? 'null' : typeof value}`);
  }

  return value;
};

/** Converts a value from one of our enums to the Bend constructor it maps to, as `{ $: 'Name' }` */
export const toBendConstructor = (names: Record<string, string>, value: string, description: string): { $: string } => {
  if (typeof value !== 'string' || !Object.prototype.hasOwnProperty.call(names, value)) {
    throw new Error(`Bend interop: unknown ${description} "${value}"`);
  }

  return { $: names[value] };
};
