import type { Application } from 'express';

type BeforeRoutesHook = (app: Application) => Promise<void> | void;

const beforeRoutesHooks: BeforeRoutesHook[] = [];

/**
 * Lets a dedicated entry point (e.g. `server/e2e/index.ts`) mount routes ahead of the regular ones.
 * Must be called before `server/index` is imported, since importing it starts the server.
 * The production entry point never registers any hook.
 */
export function registerBeforeRoutesHook(hook: BeforeRoutesHook): void {
  beforeRoutesHooks.push(hook);
}

export async function runBeforeRoutesHooks(app: Application): Promise<void> {
  for (const hook of beforeRoutesHooks) {
    await hook(app);
  }
}
