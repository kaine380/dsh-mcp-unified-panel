// DSH cordis types
const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
export function credentialRef(value) {
    if (!CREDENTIAL_REF_PATTERN.test(value)) {
        throw new TypeError(`credential ref "${value}" must match ${String(CREDENTIAL_REF_PATTERN)}`);
    }
    return value;
}
const SCHEMA_KEYS = new Set([
    'type',
    'oneOf',
    'properties',
    'required',
    'additionalProperties',
    'items',
    'enum',
    'const',
    'description',
    'title',
    'default',
    'examples',
]);
export function assertSupportedJsonSchema(value) {
    if (!isSchema(value, new Set()))
        throw new TypeError('unsupported JSON schema');
}
function isSchema(value, seen) {
    if (!isRecord(value) || seen.has(value) || Object.keys(value).some(key => !SCHEMA_KEYS.has(key)))
        return false;
    seen.add(value);
    try {
        if (value.description !== undefined && typeof value.description !== 'string')
            return false;
        if (value.title !== undefined && typeof value.title !== 'string')
            return false;
        if (value.default !== undefined && !isJsonValue(value.default))
            return false;
        if (value.examples !== undefined && !isJsonValue(value.examples))
            return false;
        if (value.type === undefined) {
            if (value.oneOf === undefined)
                return !hasConstraintWithoutType(value);
            return !hasOneOfSiblingConstraint(value)
                && Array.isArray(value.oneOf) && value.oneOf.length >= 2
                && value.oneOf.every(item => isSchema(item, seen));
        }
        if (value.oneOf !== undefined || !isSchemaType(value.type))
            return false;
        if (value.type === 'object') {
            if (value.items !== undefined || value.enum !== undefined || value.const !== undefined)
                return false;
            if (value.properties !== undefined
                && (!isRecord(value.properties) || !Object.values(value.properties).every(item => isSchema(item, seen))))
                return false;
            if (value.required !== undefined
                && (!Array.isArray(value.required) || !value.required.every(key => typeof key === 'string'
                    && isRecord(value.properties) && Object.hasOwn(value.properties, key))))
                return false;
            return value.additionalProperties === undefined || typeof value.additionalProperties === 'boolean';
        }
        if (value.type === 'array') {
            if (value.properties !== undefined || value.required !== undefined
                || value.additionalProperties !== undefined || value.enum !== undefined || value.const !== undefined)
                return false;
            return value.items === undefined || isSchema(value.items, seen);
        }
        if (value.properties !== undefined || value.required !== undefined
            || value.additionalProperties !== undefined || value.items !== undefined)
            return false;
        return validScalarConstraint(value.type, value.enum, true)
            && validScalarConstraint(value.type, value.const, false);
    }
    finally {
        seen.delete(value);
    }
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function hasConstraintWithoutType(value) {
    return ['properties', 'required', 'additionalProperties', 'items', 'enum', 'const']
        .some(key => Object.hasOwn(value, key));
}
function hasOneOfSiblingConstraint(value) {
    return hasConstraintWithoutType(value);
}
function isSchemaType(value) {
    return ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(String(value));
}
function validScalarConstraint(type, value, array) {
    if (value === undefined)
        return true;
    const entries = array ? value : [value];
    if (!Array.isArray(entries) || entries.length === 0)
        return false;
    return entries.every(item => type === 'null' ? item === null
        : type === 'integer' ? typeof item === 'number' && Number.isInteger(item) && !Object.is(item, -0)
            : type === 'number' ? typeof item === 'number' && Number.isFinite(item) && !Object.is(item, -0)
                : typeof item === type);
}
function isJsonValue(value) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean')
        return true;
    if (typeof value === 'number')
        return Number.isFinite(value) && !Object.is(value, -0);
    if (Array.isArray(value))
        return value.every(isJsonValue);
    return isRecord(value) && Object.values(value).every(isJsonValue);
}
//# sourceMappingURL=dsh.js.map