import '../env';

// The E2E entry point stubs third-party services and can mount fixture routes:
// refuse to boot it anywhere but a test or development environment.
const ALLOWED_ENVS = ['ci', 'e2e', 'test', 'development'];

if (!ALLOWED_ENVS.includes(process.env.OC_ENV)) {
  // eslint-disable-next-line no-console
  console.error(`Refusing to start the E2E server with OC_ENV=${process.env.OC_ENV}.`);
  process.exit(1);
}
