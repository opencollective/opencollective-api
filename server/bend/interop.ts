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

/** The largest natural number that code compiled from Bend handles: above it, it throws rather than lose precision */
export const MAX_BEND_NAT = 2 ** 48 - 1;

/** Checks a value handed to Bend as a `Nat`: a non-negative integer, as amounts in cents are */
export const toBendNat = (value: number, name: string): number => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_BEND_NAT) {
    throw new Error(`Bend interop: "${name}" must be an integer between 0 and 2^48-1, got ${value}`);
  }

  return value;
};

/**
 * Calls code compiled from Bend. It reports its own failures (a number growing past `MAX_BEND_NAT`) by throwing a
 * string, which we turn into an error.
 */
export const callBend = <T>(call: () => T): T => {
  try {
    return call();
  } catch (e) {
    throw e instanceof Error ? e : new Error(`Bend runtime: ${e}`);
  }
};
