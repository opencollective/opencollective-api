/**
 * Helper to make module exports stubbable with sinon when using tsx/esbuild.
 *
 * tsx/esbuild makes module exports non-configurable, which prevents sinon from stubbing them.
 * This helper makes the property configurable before stubbing.
 */
import type { SinonSandbox, SinonSpy, SinonStub } from 'sinon';

/**
 * Makes a module export configurable so it can be stubbed with sinon.
 * Call this before sandbox.stub() or sinon.stub().
 *
 * @example
 * import * as currency from '../../server/lib/currency';
 * import { makeExportConfigurable } from '../test-helpers/stub-helper';
 *
 * makeExportConfigurable(currency, 'getFxRate');
 * const stub = sandbox.stub(currency, 'getFxRate');
 */
export function makeExportConfigurable(module: Record<string, unknown>, propertyName: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(module, propertyName);
  if (descriptor && !descriptor.configurable) {
    const value = module[propertyName];
    Object.defineProperty(module, propertyName, {
      configurable: true,
      writable: true,
      enumerable: descriptor.enumerable,
      value,
    });
  }
}

/**
 * Stub a module export that may be non-configurable (tsx/esbuild).
 * Automatically makes the property configurable before stubbing.
 *
 * @example
 * import * as currency from '../../server/lib/currency';
 * import { stubExport } from '../test-helpers/stub-helper';
 *
 * const stub = stubExport(sandbox, currency, 'getFxRate');
 * stub.resolves(1.5);
 */
export function stubExport<T extends Record<string, unknown>>(
  sandbox: SinonSandbox,
  module: T,
  propertyName: keyof T & string,
): SinonStub {
  makeExportConfigurable(module, propertyName);
  return sandbox.stub(module, propertyName as keyof T);
}

/**
 * Spy on a module export that may be non-configurable (tsx/esbuild).
 * Automatically makes the property configurable before spying.
 *
 * @example
 * import * as ContributorsLib from '../../server/lib/contributors';
 * import { spyExport } from '../test-helpers/stub-helper';
 *
 * const spy = spyExport(sandbox, ContributorsLib, 'getContributorsForCollective');
 */
export function spyExport<T extends Record<string, unknown>>(
  sandbox: SinonSandbox,
  module: T,
  propertyName: keyof T & string,
): SinonSpy {
  makeExportConfigurable(module, propertyName);
  return sandbox.spy(module, propertyName as keyof T);
}
