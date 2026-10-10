import { timingSafeEqual } from 'crypto';
import { readFileSync, statSync } from 'fs';
import { basename } from 'path';

import config from 'config';
import type { Application } from 'express';

// Only the dedicated E2E entry point can activate this route. Environment flags
// alone must never expose fixture creation during ordinary application startup.
export async function installE2EFixtures(app: Application): Promise<void> {
  if (
    !/^e2e\.(js|ts)$/.test(basename(process.argv[1] || '')) ||
    process.env.NODE_ENV !== 'test' ||
    !['ci', 'e2e', 'test'].includes(config.env) ||
    !['ci', 'e2e', 'test'].includes(process.env.OC_ENV) ||
    process.env.E2E_TEST !== '1' ||
    !process.env.E2E_FIXTURE_OWNER_FILE
  ) {
    return;
  }

  let owner: { ownerRunId: string; database: string; token: string };
  try {
    const file = process.env.E2E_FIXTURE_OWNER_FILE;
    const stat = statSync(file);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()) {
      return;
    }
    owner = JSON.parse(readFileSync(file, 'utf8'));
    const { getDBConf } = await import('../lib/db.js');
    if (
      !/^run-[a-zA-Z0-9-]+$/.test(owner.ownerRunId) ||
      !/^opencollective_pw_e2e(?:_[a-z0-9_]+)?$/.test(owner.database) ||
      owner.database !== getDBConf('database').database ||
      !/^[a-f0-9]{64}$/.test(owner.token)
    ) {
      return;
    }
  } catch {
    return;
  }

  // Load recipes only after activation: the normal server has no factory/test
  // harness dependency and never creates the E2E receipt table.
  const { initializeFixtures, arrangeFixture } = await import('./recipes.js');
  await initializeFixtures(owner.database);
  app.post('/e2e/fixtures', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const token = req.get('Authorization')?.replace(/^Bearer /, '') || '';
    if (!/^[a-f0-9]{64}$/.test(token) || !timingSafeEqual(Buffer.from(token), Buffer.from(owner.token))) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Fixture authorization required.' } });
      return;
    }
    let disconnected = false;
    const onClose = () => {
      disconnected = true;
    };
    res.on('close', onClose);
    try {
      const result = await arrangeFixture(owner.ownerRunId, req.body, () => disconnected);
      res.json(result);
    } catch (error) {
      const status = error.status || 500;
      res.status(status).json({
        error: {
          code: error.code || 'FIXTURE_SETUP_FAILED',
          message:
            error.safeMessage ||
            'Fixture setup failed. Repeat the same request identity to recover any committed result; database writes are atomic.',
          requestId: typeof req.body?.requestId === 'string' ? req.body.requestId.slice(0, 100) : undefined,
        },
      });
    } finally {
      res.off('close', onClose);
    }
  });
}
