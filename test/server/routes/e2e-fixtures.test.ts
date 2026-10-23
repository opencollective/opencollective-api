import { spawn } from 'child_process';
import { randomBytes } from 'crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import { expect } from 'chai';

// Boot a separate process so node-config reads the real startup environment.
// No mocks, recipe internals, DB resets or application writes are involved.
const spawnProbe = (environment: Record<string, string>, script: string) =>
  spawn(process.execPath, ['-r', './test/setup-babel.cjs', '-e', script], {
    cwd: path.resolve(__dirname, '../../..'),
    env: {
      ...process.env,
      BABEL_ENV: 'test-fast',
      NODE_ENV: 'test',
      OC_ENV: 'ci',
      NODE_CONFIG_ENV: 'ci',
      E2E_TEST: '1',
      PG_DATABASE: 'opencollective_pw_e2e_guard',
      ...environment,
    },
  });

// `withE2EHooks` mirrors what `server/e2e/index.ts` registers before starting the server.
const probe = (environment: Record<string, string>, { withE2EHooks }: { withE2EHooks: boolean }) =>
  new Promise<number>((resolve, reject) => {
    const script = `
    require('./server/env');
    ${withE2EHooks ? "require('./server/e2e/register');" : ''}
    const express = require('express');
    const { runBeforeRoutesHooks } = require('./server/lib/express-hooks');
    (async () => {
      const app = express();
      app.use(express.json());
      await runBeforeRoutesHooks(app);
      const server = app.listen(0, '127.0.0.1');
      await new Promise(resolve => server.once('listening', resolve));
      const response = await fetch('http://127.0.0.1:' + server.address().port + '/e2e/fixtures', {
        method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}'
      });
      console.log('PROBE_STATUS=' + response.status);
      server.close(() => process.exit(0));
    })().catch(() => process.exit(1));
  `;
    const child = spawnProbe(environment, script);
    let output = '';
    child.stdout.on('data', data => {
      output += data;
    });
    child.once('error', reject);
    child.once('exit', code => {
      const status = /PROBE_STATUS=(\d+)/.exec(output);
      if (code !== 0 || !status) {
        reject(new Error('Fixture startup probe failed before an HTTP response.'));
      } else {
        resolve(Number(status[1]));
      }
    });
  });

describe('E2E fixture HTTP startup guards', () => {
  let directory: string;
  let file: string;
  before(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'oc-fixture-guards-'));
    file = path.join(directory, 'owner.json');
    writeFileSync(
      file,
      JSON.stringify({
        ownerRunId: 'run-guard-test',
        database: 'opencollective_pw_e2e_guard',
        token: randomBytes(32).toString('hex'),
      }),
      { mode: 0o600 },
    );
  });
  after(() => rmSync(directory, { recursive: true, force: true }));

  it('normal startup never mounts fixtures, even when otherwise configured', async function () {
    this.timeout(60_000);
    expect(await probe({ E2E_FIXTURE_OWNER_FILE: file }, { withE2EHooks: false })).to.equal(404);
  });
  for (const env of ['production', 'staging', 'development']) {
    it(`rejects ${env} startup`, async function () {
      this.timeout(60_000);
      expect(
        await probe({ E2E_FIXTURE_OWNER_FILE: file, OC_ENV: env, NODE_CONFIG_ENV: env }, { withE2EHooks: true }),
      ).to.equal(404);
    });
  }
  it('rejects a missing ownership proof', async function () {
    this.timeout(60_000);
    expect(await probe({ E2E_FIXTURE_OWNER_FILE: '' }, { withE2EHooks: true })).to.equal(404);
  });
  it('rejects a non-owned database target', async function () {
    this.timeout(60_000);
    expect(
      await probe({ E2E_FIXTURE_OWNER_FILE: file, PG_DATABASE: 'opencollective_dvl' }, { withE2EHooks: true }),
    ).to.equal(404);
  });
});

describe('E2E entry point environment guard', () => {
  const runGuard = (env: string) =>
    new Promise<number>((resolve, reject) => {
      const child = spawnProbe({ OC_ENV: env, NODE_CONFIG_ENV: env }, "require('./server/e2e/guard');");
      child.once('error', reject);
      child.once('exit', resolve);
    });

  for (const env of ['production', 'staging']) {
    it(`refuses to boot with OC_ENV=${env}`, async function () {
      this.timeout(60_000);
      expect(await runGuard(env)).to.equal(1);
    });
  }
  it('lets the E2E environment boot', async function () {
    this.timeout(60_000);
    expect(await runGuard('e2e')).to.equal(0);
  });
});
