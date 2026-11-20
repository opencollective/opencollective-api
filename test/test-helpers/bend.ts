import fs from 'fs';
import path from 'path';

/**
 * Returns the constructor names of a datatype declared in a Bend source file of `server/bend/`, to check that
 * the names used on the TypeScript side of the boundary exist on the Bend side.
 */
export const getBendConstructorNames = (fileName: string, typeName: string): string[] => {
  const source = fs.readFileSync(path.join(__dirname, '../../server/bend', fileName), 'utf8');
  const lines = source.split('\n');
  const start = lines.findIndex(line => line.startsWith(`type ${typeName} is `));
  if (start === -1) {
    throw new Error(`Type ${typeName} not found in ${fileName}`);
  }

  const names = [];
  for (const line of lines.slice(start + 1)) {
    const constructor = line.match(/^ {2}(\w+)\{/);
    if (!constructor) {
      break;
    }
    names.push(constructor[1]);
  }

  return names;
};
