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
 * )
 */
export const deepJSONBSet = (field: string, path: string[], value: string) => {
  return deepJSONBSetRecursive(field, path, value, 0);
};

const deepJSONBSetRecursive = (field: string, path: string[], value: string, level: number) => {
  if (level === path.length) {
    return value;
  }

  const currentPathStr = !level ? `"${field}"` : `"${field}"` + '->' + `'${path.slice(0, level).join(`'->'`)}'`;
  const subQuery = deepJSONBSetRecursive(field, path, value, level + 1);
  return `JSONB_SET(COALESCE(${currentPathStr}, '{}'), '{${path[level]}}', ${subQuery})`;
};
