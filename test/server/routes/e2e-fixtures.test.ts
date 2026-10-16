import { spawn } from 'child_process';
import { randomBytes } from 'crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import { expect } from 'chai';

// Boot a separate process so node-config reads the real startup environment.
// No mocks, recipe internals, DB resets or application writes are involved.
const probe = (environment: Record<string, string>, entrypoint: string) =>
  new Promise<number>((resolve, reject) => {
    const script = `
    process.argv[1] = ${JSON.stringify(entrypoint)};
    require('./server/env');
    const express = require('express');
    const { installE2EFixtures } = require('./server/e2e/fixtures');
    (async () => {
      const app = express();
      app.use(express.json());
      await installE2EFixtures(app);
      const server = app.listen(0, '127.0.0.1');
      await new Promise(resolve => server.once('listening', resolve));
      const response = await fetch('http://127.0.0.1:' + server.address().port + '/e2e/fixtures', {
        method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}'
      });
      console.log('PROBE_STATUS=' + response.status);
      server.close(() => process.exit(0));
    })().catch(() => process.exit(1));
  `;
    const child = spawn(process.execPath, ['-r', './test/setup-babel.cjs', '-e', script], {
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

  it('normal startup rejects even otherwise configured fixture activation', async function () {
    this.timeout(60_000);
    expect(await probe({ E2E_FIXTURE_OWNER_FILE: file }, 'dist/index.js')).to.equal(404);
  });
  for (const env of ['production', 'staging', 'development']) {
    it(`rejects ${env} startup`, async function () {
      this.timeout(60_000);
      expect(await probe({ E2E_FIXTURE_OWNER_FILE: file, OC_ENV: env, NODE_CONFIG_ENV: env }, 'dist/e2e.js')).to.equal(
        404,
      );
    });
  }
  it('rejects a missing ownership proof', async function () {
    this.timeout(60_000);
    expect(await probe({ E2E_FIXTURE_OWNER_FILE: '' }, 'dist/e2e.js')).to.equal(404);
  });
  it('rejects a non-owned database target', async function () {
    this.timeout(60_000);
    expect(await probe({ E2E_FIXTURE_OWNER_FILE: file, PG_DATABASE: 'opencollective_dvl' }, 'dist/e2e.js')).to.equal(
      404,
    );
  });
});
