/**
 * The small part of JSON Schema the companion's answer schemas use: `type`
 * (one name or a list), `enum`, `properties`, `required`,
 * `additionalProperties: false` and `items`. An agent's answer is checked
 * against its schema before the engine uses it. The type below admits only
 * these keywords, so a schema cannot ask for a check this validator would
 * silently skip.
 */
export interface JsonSchema {
  type?: JsonTypeName | JsonTypeName[];
  enum?: readonly unknown[];
  properties?: Record<string, JsonSchema>;
  required?: readonly string[];
  additionalProperties?: false;
  items?: JsonSchema;
  description?: string;
}

export type JsonTypeName = 'object' | 'array' | 'string' | 'integer' | 'number' | 'boolean' | 'null';

function typeOf(value: unknown): JsonTypeName {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value as JsonTypeName;
}

/**
 * Checks a value against a schema. Returns every problem found, each with
 * the JSON pointer of the value it is about; an empty list means valid.
 */
export function validateJson(value: unknown, schema: JsonSchema, pointer = ''): string[] {
  const where = pointer === '' ? 'the answer' : pointer;
  if (schema.type !== undefined) {
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = typeOf(value);
    const fits = allowed.includes(actual) || (actual === 'integer' && allowed.includes('number'));
    if (!fits) return [`${where} should be ${allowed.join(' or ')}, not ${actual}`];
  }
  if (schema.enum && !schema.enum.some((option) => option === value)) {
    return [`${where} should be one of ${schema.enum.map((option) => JSON.stringify(option)).join(', ')}`];
  }
  const problems: string[] = [];
  if (typeOf(value) === 'object') {
    const record = value as Record<string, unknown>;
    for (const name of schema.required ?? []) {
      if (!(name in record)) problems.push(`${where} is missing "${name}"`);
    }
    for (const [name, child] of Object.entries(record)) {
      const childSchema = schema.properties?.[name];
      if (childSchema) problems.push(...validateJson(child, childSchema, `${pointer}/${name}`));
      else if (schema.additionalProperties === false) problems.push(`${where} has an unexpected "${name}"`);
    }
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, index) => problems.push(...validateJson(item, schema.items!, `${pointer}/${index}`)));
  }
  return problems;
}
