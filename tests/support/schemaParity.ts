import { readFileSync } from 'node:fs'
import { expect } from 'vitest'

// Grounds the runtime contracts in the committed JSON Schemas without a second validator:
// for every object the valid fixture reaches, the schema's property set must cover the
// fixture, each schema-required key must be required at runtime, and closed objects must
// reject unknown keys at runtime.

interface JsonSchema {
  readonly $ref?: string
  readonly properties?: Readonly<Record<string, JsonSchema>>
  readonly required?: readonly string[]
  readonly additionalProperties?: unknown
  readonly items?: JsonSchema
  readonly oneOf?: readonly JsonSchema[]
  readonly anyOf?: readonly JsonSchema[]
  readonly $defs?: Readonly<Record<string, JsonSchema>>
}

type Parse = (input: unknown) => { readonly ok: boolean }
type Path = readonly (string | number)[]

export function loadContractSchema(name: string): JsonSchema {
  const url = new URL(`../../specs/001-verify-debugging-fix/contracts/${name}.schema.json`, import.meta.url)
  return JSON.parse(readFileSync(url, 'utf8')) as JsonSchema
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function replaceAt(root: unknown, path: Path, replacement: unknown): unknown {
  if (path.length === 0) return replacement
  const [head, ...rest] = path
  if (Array.isArray(root)) return root.map((item, index) => (index === head ? replaceAt(item, rest, replacement) : item))
  const record = root as Record<string, unknown>
  return { ...record, [String(head)]: replaceAt(record[String(head)], rest, replacement) }
}

export function expectSchemaParity(parse: Parse, schema: JsonSchema, fixture: unknown): number {
  let checkedObjects = 0
  const resolve = (node: JsonSchema): JsonSchema => {
    if (!node.$ref) return node
    const name = node.$ref.replace('#/$defs/', '')
    const target = schema.$defs?.[name]
    if (!target) throw new Error(`Unresolvable schema reference ${node.$ref}`)
    return resolve(target)
  }

  const visit = (raw: JsonSchema, value: unknown, path: Path): void => {
    const node = resolve(raw)
    if (Array.isArray(value)) {
      if (node.items) value.forEach((item, index) => visit(node.items as JsonSchema, item, [...path, index]))
      return
    }
    if (!isRecord(value)) return
    const objectNode = node.properties
      ? node
      : [...(node.oneOf ?? []), ...(node.anyOf ?? [])].map(resolve).find((branch) => branch.properties)
    if (!objectNode?.properties) return
    const properties = objectNode.properties
    const label = path.join('.') || '(root)'
    checkedObjects += 1

    for (const key of Object.keys(value)) expect(Object.hasOwn(properties, key), `${label}.${key} is in the schema`).toBe(true)
    if (objectNode.additionalProperties === false) {
      expect(parse(replaceAt(fixture, path, { ...value, unexpected_field: true })).ok, `${label} is closed`).toBe(false)
    }
    for (const key of objectNode.required ?? []) {
      const { [key]: _omitted, ...rest } = value
      expect(parse(replaceAt(fixture, path, rest)).ok, `${label}.${key} is required`).toBe(false)
    }
    for (const [key, child] of Object.entries(properties)) {
      if (Object.hasOwn(value, key)) visit(child, value[key], [...path, key])
    }
  }

  expect(parse(fixture).ok, 'the fixture itself is valid').toBe(true)
  visit(schema, fixture, [])
  return checkedObjects
}
