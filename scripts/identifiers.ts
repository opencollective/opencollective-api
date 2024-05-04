/**
 * Small helper to encode/decode GQLV2 identifiers with command-line.
 * The corresponding `HASHID_SALT` must be set in the environment (i.e. `.env.prod`, `.env` ...etc)
 */

import '../server/env';

import { Command, InvalidArgumentError } from 'commander';

import { idDecode, idEncode } from '../server/graphql/v2/identifiers';

const program = new Command();

program.command('decode <entity> <idStr> [env]').action(async (entity, id) => {
  console.log(idDecode(id, entity));
});

program.command('encode <entity> <idInteger> [env]').action(async (entity, id) => {
  const parsedValue = parseInt(id, 10);
  if (isNaN(parsedValue)) {
    throw new InvalidArgumentError('ID must be a number');
  }

  console.log(idEncode(parsedValue, entity));
});

program.addHelpText(
  'after',
  `

Example call:
  $ pnpm script scripts/identifiers.ts decode account bvrgbk35-7l4x96e7-y4apomew-a0jdyzn8 prod
  $ pnpm script scripts/identifiers.ts encode account 4242 staging
`,
);

program.parse();
