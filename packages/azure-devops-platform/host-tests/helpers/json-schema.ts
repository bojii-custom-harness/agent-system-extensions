type Schema = {
  additionalProperties?: boolean | Schema;
  anyOf?: Schema[];
  enum?: unknown[];
  items?: Schema;
  maxItems?: number;
  maxLength?: number;
  maximum?: number;
  minItems?: number;
  minLength?: number;
  minimum?: number;
  pattern?: string;
  properties?: Record<string, Schema>;
  propertyNames?: Schema;
  required?: string[];
  type?: string;
};

export function jsonSchemaAccepts(schema: unknown, value: unknown): boolean {
  if (!isRecord(schema)) return false;
  const definition = schema as Schema;

  if (definition.enum && !definition.enum.some((candidate) => Object.is(candidate, value))) return false;
  if (definition.anyOf && !definition.anyOf.some((candidate) => jsonSchemaAccepts(candidate, value))) return false;

  if (definition.type === "string") {
    if (typeof value !== "string") return false;
    if (definition.minLength !== undefined && value.length < definition.minLength) return false;
    if (definition.maxLength !== undefined && value.length > definition.maxLength) return false;
    if (definition.pattern && !new RegExp(definition.pattern).test(value)) return false;
  } else if (definition.type === "integer") {
    if (typeof value !== "number" || !Number.isInteger(value)) return false;
    if (definition.minimum !== undefined && value < definition.minimum) return false;
    if (definition.maximum !== undefined && value > definition.maximum) return false;
  } else if (definition.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) return false;
    if (definition.minimum !== undefined && value < definition.minimum) return false;
    if (definition.maximum !== undefined && value > definition.maximum) return false;
  } else if (definition.type === "boolean") {
    if (typeof value !== "boolean") return false;
  } else if (definition.type === "array") {
    if (!Array.isArray(value)) return false;
    if (definition.minItems !== undefined && value.length < definition.minItems) return false;
    if (definition.maxItems !== undefined && value.length > definition.maxItems) return false;
    if (definition.items && !value.every((item) => jsonSchemaAccepts(definition.items, item))) return false;
  } else if (definition.type === "object") {
    if (!isRecord(value)) return false;
    const properties = definition.properties ?? {};
    if (definition.required?.some((key) => !(key in value))) return false;
    if (definition.propertyNames && Object.keys(value).some((key) => !jsonSchemaAccepts(definition.propertyNames, key))) return false;
    for (const [key, item] of Object.entries(value)) {
      const propertySchema = properties[key];
      if (propertySchema) {
        if (!jsonSchemaAccepts(propertySchema, item)) return false;
      } else if (definition.additionalProperties === false) {
        return false;
      } else if (isRecord(definition.additionalProperties)
        && !jsonSchemaAccepts(definition.additionalProperties, item)) {
        return false;
      }
    }
  }

  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
