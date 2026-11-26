/**
 * A helper that will set a value in a nested JSONB column, creating the full path if necessary.
 * Note: this does not support arrays.
 *
 * @param field The name of the JSONB column. Must be sanitized!
 * @param path The path to the value to set. Must be sanitized!
 * @param value The value to set. Must be sanitized!
 *
 * Example:
 * > deepJSONBSet('data', ['foo', 'bar', 'baz'], ':myValue')
 * JSONB_SET(
 *   COALESCE(data, '{}),
 *   '{foo}',
 *   JSONB_SET(
 *     COALESCE(data->'foo', '{}'),
 *     '{bar}',
 *     JSONB_SET(
 *       COALESCE(data->'foo'->'bar', '{}'),
 *       '{baz}',
 *       :myValue
 *     )
 *  )
 */
export const deepJSONBSet = (field: string, path: string[], value: string) => {
  return deepJSONBSetRecursive(field, path, value, 0);
};

const deepJSONBSetRecursive = (field: string, path: string[], value: string, level: number) => {
  if (level === path.length) {
    return value;
  }

  // The `#>>` operator makes sure we're decoding the value to properly detect `null`.
  const currentPathStr = !level ? `"${field}"` : `"${field}"#>>'{${path.slice(0, level).join(',')}}'`;
  const subQuery = deepJSONBSetRecursive(field, path, value, level + 1);

  // It's then re-encoded as JSONB with the `::JSONB`.
  return `JSONB_SET(COALESCE(${currentPathStr}, '{}')::JSONB, '{${path[level]}}', ${subQuery})`;
};

type WhereOperation = Record<string, unknown> & { deletedAt?: never };

/**
 * Recursively replaces Sequelize operators with their string representation
 */
export const stringifySequelizeOperators = (value: WhereOperation): string => {
  return JSON.stringify(_stringifySequelizeOperators(value));
};

const _stringifySequelizeOperators = (value: WhereOperation): unknown => {
  const result: Record<string, unknown> = {};

  if (typeof value === 'object') {
    for (const symbol of Object.getOwnPropertySymbols(value)) {
      const newKey = symbol.toString();
      const rawValue = value[symbol as unknown as string];
      if (rawValue && typeof rawValue === 'object') {
        result[newKey] = _stringifySequelizeOperators(rawValue as WhereOperation);
      } else {
        result[newKey] = rawValue;
      }
    }

    for (const [key, val] of Object.entries(value)) {
      if (val && typeof val === 'object') {
        result[key] = _stringifySequelizeOperators(val as WhereOperation);
      } else {
        result[key] = val;
      }
    }
  }

  return result;
};
