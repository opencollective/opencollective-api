import fs from 'fs';

import { downloadFidoMetadata } from '../server/lib/two-factor-authentication/fido-metadata';

downloadFidoMetadata().then(metadata => {
  fs.writeFileSync('./server/lib/two-factor-authentication/cached-metadata.json', JSON.stringify(metadata));
});
