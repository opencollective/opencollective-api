import path from 'path';

import fs from 'fs-extra';

const rootDir = path.join(__dirname, '..', '..');
const sourceDir = path.join(rootDir, 'server');
const distDir = path.join(rootDir, 'dist');
const relativeFromRepo = (filePath: string) => path.relative(rootDir, filePath);

const excludedExtensions = new Set(['.ts', '.tsx', '.d.ts', '.js', '.jsx', '.md']);

const shouldCopy = (src: string): boolean => {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    return true;
  }

  const shouldInclude = !excludedExtensions.has(path.extname(src));
  if (shouldInclude) {
    console.log(`copy: ${relativeFromRepo(src)}`);
  }
  return shouldInclude;
};

fs.copySync(sourceDir, distDir, { filter: shouldCopy });
