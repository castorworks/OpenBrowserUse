import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

export const spec = JSON.parse(readFileSync(new URL('../../docs/openapi.json', import.meta.url)));
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
const defs = JSON.parse(JSON.stringify(spec.components.schemas).replaceAll('#/components/schemas/', '#/$defs/'));
const validators = Object.fromEntries(Object.keys(defs).map(name => [name, ajv.compile({ $defs: defs, $ref: `#/$defs/${name}` })]));
export function checkResponse(method, path, status, body) {
  const route = Object.entries(spec.paths).find(([template]) => new RegExp('^' + template.replace(/\{[^}]+\}/g, '[^/]+') + '$').test(path.split('?')[0]));
  if (status === 204) { assert.ok(route?.[1][method.toLowerCase()]?.responses['204']); assert.equal(body, undefined); return; }
  const schema = route?.[1][method.toLowerCase()]?.responses[status]?.content?.['application/json']?.schema;
  const name = status >= 400 ? 'Problem' : schema?.$ref?.split('/').at(-1);
  assert.ok(name, `No response contract for ${method} ${path} ${status}`);
  assert.ok(validators[name](body), `${method} ${path} ${status}: ${JSON.stringify(validators[name].errors)}`);
}
