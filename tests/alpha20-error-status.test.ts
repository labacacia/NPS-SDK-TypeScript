import { conformanceFixture } from './conformance-fixtures.js';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { NCP_ERROR_CODES, NCP_ERROR_TO_NPS_STATUS } from '../src/ncp/ncp-error-codes.js';
import * as nwp from '../src/nwp/nwp-error-codes.js';
import * as nip from '../src/nip/error-codes.js';
import * as nop from '../src/nop/nop-error-codes.js';
import { toHttpStatus, type NpsStatusCode } from '../src/core/status-codes.js';
const corpus = JSON.parse(readFileSync(conformanceFixture('alpha20', 'error_status_vectors.json'), 'utf8'));
const maps: Record<string, Record<string, string>> = { NCP: NCP_ERROR_TO_NPS_STATUS, NWP: nwp.NWP_ERROR_TO_NPS_STATUS, NIP: nip.NIP_ERROR_TO_NPS_STATUS, NOP: nop.NOP_ERROR_TO_NPS_STATUS };
const constants: Record<string, object> = { NCP: NCP_ERROR_CODES, NWP: nwp, NIP: nip, NOP: nop };
it('contains all seventeen alpha20 mappings', () => expect(corpus.cases).toHaveLength(17));
for (const vector of corpus.cases) it(vector.code, () => {
  const protocol = vector.code.slice(0, 3);
  expect(Object.values(constants[protocol])).toContain(vector.code);
  expect(maps[protocol][vector.code]).toBe(vector.status);
  expect(toHttpStatus(maps[protocol][vector.code] as NpsStatusCode)).toBe(vector.http);
});
