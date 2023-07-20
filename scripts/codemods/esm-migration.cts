const path = require('path');
const fs = require('fs');

const isLocalImport = node =>
  node.value.source.value.startsWith('./') ||
  node.value.source.value.startsWith('../') ||
  node.value.source.value === '.';

const importDoesNotHaveExtension = node => {
  return !['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts'].some(ext => {
    return node.value.source.value.endsWith(ext);
  });
};

const addExtensionToLocalImport = (j, sourcePath) => node => {
  const originalImportPath = node.value.source.value;
  const originalImportSpecifiers = node.value.specifiers;
  let updatedPath = originalImportPath;

  let ext = [
    '.js',
    '.mjs',
    '.cjs',
    '.ts',
    '.mts',
    '.cts',
    '/index.js',
    '/index.mjs',
    '/index.cjs',
    '/index.ts',
    '/index.mts',
    '/index.cts',
  ].find(ext => {
    return fs.existsSync(path.join(sourcePath, originalImportPath + ext));
  });

  if (ext) {
    if (ext.endsWith('.mts')) {
      ext = ext.replaceAll('.mts', '.js');
    } else if (ext.endsWith('.cts')) {
      ext = ext.replaceAll('.cts', '.js');
    } else if (ext.endsWith('.ts')) {
      ext = ext.replaceAll('.ts', '.js');
    } else if (ext.endsWith('.cjs')) {
      ext = ext.replaceAll('.cjs', '.js');
    } else if (ext.endsWith('.mjs')) {
      ext = ext.replaceAll('.mjs', '.js');
    }

    updatedPath += ext;
  }

  j(node).replaceWith(j.importDeclaration(originalImportSpecifiers, j.literal(updatedPath)));
};

const isPackageImportWithPath = node => {
  return !isLocalImport(node) && node.value.source.value.includes('/');
};

const addExtensionToPackageImport = j => node => {
  const originalImportPath = node.value.source.value;
  const originalImportSpecifiers = node.value.specifiers;

  const nodeModulesPath = './node_modules';

  const packageSourcePath = path.join(nodeModulesPath, originalImportPath);

  let ext = ['.mjs', '.cjs', '.js', '/index.mjs', '/index.cjs', '/index.js'].find(ext => {
    return fs.existsSync(packageSourcePath + ext);
  });

  if (ext) {
    j(node).replaceWith(j.importDeclaration(originalImportSpecifiers, j.literal(originalImportPath + ext)));
  }
};

const isLodashImport = node => {
  return node.value.source.value === 'lodash';
};

const updateLodashImport = j => node => {
  const originalImportSpecifiers = node.value.specifiers;
  j(node).replaceWith(j.importDeclaration(originalImportSpecifiers, j.literal('lodash-es')));
};

module.exports = function (fileInfo, api) {
  const sourcePath = path.dirname(path.resolve(fileInfo.path));
  const j = api.jscodeshift;
  const root = j(fileInfo.source);
  const body = root.find(j.Program).get('body');
  const imports = root.find(j.ImportDeclaration);

  imports.filter(isLocalImport).filter(importDoesNotHaveExtension).forEach(addExtensionToLocalImport(j, sourcePath));
  imports.filter(isPackageImportWithPath).filter(importDoesNotHaveExtension).forEach(addExtensionToPackageImport(j));
  imports.filter(isLodashImport).forEach(updateLodashImport(j));

  const hasCallsToRequire = root.find(j.CallExpression, { callee: { name: 'require' } });
  if (hasCallsToRequire.length > 0) {
    body.unshift(
      j.importDeclaration([j.importSpecifier(j.identifier('createRequire'))], j.literal('node:module')),
      j.variableDeclaration('const', [
        j.variableDeclarator(
          j.identifier('require'),
          j.callExpression(j.identifier('createRequire'), [j.identifier('import.meta.url')]),
        ),
      ]),
    );
  }

  const hasIdentifier__dirname = root.find(j.Identifier, { name: '__dirname' });
  if (hasIdentifier__dirname.length > 0) {
    const hasDeclaration__dirname = root.find(j.VariableDeclaration, {
      declarations: [
        {
          id: {
            type: 'Identifier',
            name: '__dirname',
          },
        },
      ],
    });

    // uses __dirname, but its not declared in the file so insert it
    if (hasDeclaration__dirname.length === 0) {
      body.unshift(
        j.importDeclaration([j.importDefaultSpecifier(j.identifier('url'))], j.literal('url')),
        j.variableDeclaration('const', [
          j.variableDeclarator(
            j.identifier('__dirname'),
            j.callExpression(j.identifier('url.fileURLToPath'), [
              j.newExpression(j.identifier('url.URL'), [j.literal('.'), j.identifier('import.meta.url')]),
            ]),
          ),
        ]),
      );
    }
  }

  return root.toSource({ quote: 'single' });
};
