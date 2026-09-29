/**
 * Refreshes the list of Cloudflare IP ranges that Express trusts as proxies (`server/lib/cloudflare-ips.json`),
 * from Cloudflare's public `GET /ips` endpoint. Runs at build time to refresh the copy in `dist/`; a failure only
 * logs a warning so the last known list is kept.
 */
import { writeFileSync } from 'fs';

import Cloudflare from 'cloudflare';

const output = process.argv[2] || 'server/lib/cloudflare-ips.json';

new Cloudflare().ips
  .list()
  .then(({ ipv4_cidrs: ipv4, ipv6_cidrs: ipv6 }) => {
    writeFileSync(output, `${JSON.stringify([...ipv4, ...ipv6], null, 2)}\n`);
    console.log(`Wrote ${ipv4.length + ipv6.length} Cloudflare IP ranges to ${output}`);
  })
  .catch(error => console.warn(`Could not refresh Cloudflare IP ranges, keeping ${output}: ${error.message}`));
