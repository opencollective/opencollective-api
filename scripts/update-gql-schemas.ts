import * as fs from 'fs';
import * as path from 'path';

import { buildClientSchema } from 'graphql/utilities/buildClientSchema';
import { getIntrospectionQuery } from 'graphql/utilities/getIntrospectionQuery';
import { printSchema } from 'graphql/utilities/printSchema';
import fetch from 'node-fetch';

/**
 *
 * Fetch remote schema and turn it into string
 *
 * @param endpoint
 * @param options
 */
async function getRemoteSchema(
  endpoint: string,
): Promise<{ status: 'ok'; schema: string } | { status: 'err'; message: string }> {
  try {
    const introspectionQuery = getIntrospectionQuery({ inputValueDeprecation: true, schemaDescription: true });
    const { data, errors } = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: introspectionQuery }),
    }).then(res => res.json());

    if (errors) {
      return { status: 'err', message: JSON.stringify(errors, null, 2) };
    }

    const schema = buildClientSchema(data);
    return {
      status: 'ok',
      schema: printSchema(schema),
    };
  } catch (err) {
    return { status: 'err', message: err.message };
  }
}

/**
 *
 * Prints schema to file.
 *
 * @param dist
 * @param schema
 */
function printToFile(
  schema: string,
  filePath: string,
): { status: 'ok'; path: string } | { status: 'err'; message: string } {
  try {
    const output = path.resolve(process.cwd(), filePath);
    fs.writeFileSync(output, schema);
    return { status: 'ok', path: output };
  } catch (err) {
    console.error(err.message.slice(0, 100));
    return { status: 'err', message: err.message };
  }
}

async function main(endpoint, filePath): Promise<void> {
  /* Fetch schema */
  const schema = await getRemoteSchema(endpoint);

  if (schema.status === 'err') {
    console.error(schema.message);
  } else {
    printToFile(schema.schema, filePath);
  }
}

main(process.argv[2], process.argv[3]);
