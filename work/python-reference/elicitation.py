"""Validation for ACP v1 form-mode elicitation schemas and responses.

Implements the flat primitive/enum subset documented by ACP's linked MCP
2026-07-28 elicitation schema: strings, numbers, integers, booleans, and
arrays of enum strings. Nested objects and general JSON Schema are rejected.
"""
from __future__ import annotations

import argparse
import datetime as _datetime
import math
import re
from urllib.parse import urlsplit

_MAX_SCHEMA_BYTES = 65536
_MAX_PROPERTIES = 100
_MAX_ENUM_VALUES = 256
_MAX_STRING_LENGTH = 100000
_FORMATS = {"email", "uri", "date", "date-time"}
_ROOT_KEYS = {"type", "title", "description", "properties", "required"}
_COMMON_KEYS = {"title", "description", "default", "writeOnly"}


def _fail(message: str) -> None:
    raise ValueError(message)


def _mapping(value, what):
    if not isinstance(value, dict) or any(not isinstance(k, str) for k in value):
        _fail(f"{what} must be an object")
    return value


def _bounded_text(value, what):
    if not isinstance(value, str):
        _fail(f"{what} must be a string")
    if len(value) > _MAX_STRING_LENGTH:
        _fail(f"{what} is too long")
    return value


def _unique_strings(value, what):
    if not isinstance(value, list) or any(not isinstance(x, str) for x in value):
        _fail(f"{what} must be an array of strings")
    if len(value) > _MAX_ENUM_VALUES or len(set(value)) != len(value):
        _fail(f"{what} is too large or contains duplicates")
    return value


def _enum_values(spec):
    has_enum, has_oneof = "enum" in spec, "oneOf" in spec
    if has_enum and has_oneof:
        _fail("enum and oneOf cannot be combined")
    if has_enum:
        vals = spec["enum"]
        if not isinstance(vals, list) or not vals or any(not isinstance(v, str) for v in vals):
            _fail("enum must be a non-empty array of strings")
    elif has_oneof:
        options = spec["oneOf"]
        if not isinstance(options, list) or not options:
            _fail("oneOf must be a non-empty array")
        vals = []
        for option in options:
            option = _mapping(option, "oneOf choice")
            if set(option) - {"const", "title", "description"} or "const" not in option:
                _fail("oneOf supports only {const, title, description} string choices")
            if not isinstance(option["const"], str):
                _fail("oneOf const choices must be strings")
            if "title" in option:
                _bounded_text(option["title"], "choice title")
            if "description" in option:
                _bounded_text(option["description"], "choice description")
            vals.append(option["const"])
    else:
        return None
    if len(vals) > _MAX_ENUM_VALUES or len(set(vals)) != len(vals):
        _fail("enum is too large or contains duplicates")
    return vals


def _check_common(spec):
    for key in ("title", "description"):
        if key in spec:
            _bounded_text(spec[key], key)
    if "writeOnly" in spec and not isinstance(spec["writeOnly"], bool):
        _fail("writeOnly must be boolean")
    if spec.get("writeOnly") is True or spec.get("format") == "password":
        _fail("secret/password fields are unsupported in form mode")


def _check_scalar_spec(spec, *, array_item=False):
    spec = _mapping(spec, "property schema")
    if "$ref" in spec:
        _fail("$ref is unsupported")
    _check_common(spec)
    typ = spec.get("type")
    if typ not in {"string", "number", "integer", "boolean"}:
        _fail("only string, number, integer, and boolean properties are supported")
    allowed = set(_COMMON_KEYS)
    if typ == "string":
        allowed |= {"type", "minLength", "maxLength", "format", "enum", "oneOf"}
        enum = _enum_values(spec)
        if "format" in spec:
            if spec["format"] not in _FORMATS:
                _fail("unsupported string format")
            if enum is not None:
                _fail("formatted strings cannot also be enums")
        for key in ("minLength", "maxLength"):
            if key in spec and (type(spec[key]) is not int or spec[key] < 0 or spec[key] > _MAX_STRING_LENGTH):
                _fail(f"{key} must be a bounded non-negative integer")
        if spec.get("minLength", 0) > spec.get("maxLength", _MAX_STRING_LENGTH):
            _fail("minLength exceeds maxLength")
    elif typ in {"number", "integer"}:
        allowed |= {"type", "minimum", "maximum"}
        if "minimum" in spec:
            _finite_number(spec["minimum"], "minimum")
        if "maximum" in spec:
            _finite_number(spec["maximum"], "maximum")
        if spec.get("minimum", -math.inf) > spec.get("maximum", math.inf):
            _fail("minimum exceeds maximum")
    else:
        allowed |= {"type"}
    unknown = set(spec) - allowed
    if unknown:
        _fail("unsupported schema keyword(s): " + ", ".join(sorted(unknown)))
    if "default" in spec:
        _validate_value(spec, spec["default"], "default")
    return spec


def _finite_number(value, what):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        _fail(f"{what} must be a finite number")


def validate_url(url):
    """Validate a URL-mode elicitation destination: absolute http(s), no credentials."""
    if not isinstance(url, str) or not url or len(url) > 2048:
        _fail("url must be a non-empty string of at most 2048 characters")
    if any(ord(ch) <= 32 or ord(ch) == 127 for ch in url):
        _fail("url cannot contain spaces or control characters")
    try:
        parts = urlsplit(url)
        host = parts.hostname
        parts.port
    except ValueError:
        _fail("url is malformed")
    if parts.scheme.lower() not in {"http", "https"}:
        _fail("only http and https URLs can be opened")
    if not host:
        _fail("url must include a host name")
    if parts.username is not None or parts.password is not None or "@" in parts.netloc:
        _fail("urls containing credentials are not allowed")
    return url


def validate_url_request(params):
    """Validate URL-mode elicitation params; returns the validated URL."""
    params = _mapping(params, "params")
    if "requestedSchema" in params:
        _fail("url-mode requests cannot include requestedSchema")
    eid = params.get("elicitationId")
    if not isinstance(eid, str) or not 1 <= len(eid) <= 256:
        _fail("url-mode requests require an elicitationId string")
    return validate_url(params.get("url"))


def validate_schema(schema):
    """Validate an ACP form requestedSchema, raising ValueError if unsupported."""
    schema = _mapping(schema, "schema")
    try:
        size = len(repr(schema).encode("utf-8"))
    except (UnicodeError, RecursionError):
        _fail("schema is malformed or too deeply nested")
    if size > _MAX_SCHEMA_BYTES:
        _fail("schema exceeds size limit")
    if "$ref" in schema:
        _fail("$ref is unsupported")
    if schema.get("type") != "object":
        _fail("form schema must have type object")
    if set(schema) - _ROOT_KEYS:
        _fail("unsupported root schema keyword(s)")
    if "title" in schema:
        _bounded_text(schema["title"], "title")
    if "description" in schema:
        _bounded_text(schema["description"], "description")
    props = _mapping(schema.get("properties"), "properties")
    if len(props) > _MAX_PROPERTIES:
        _fail("too many properties")
    for key, spec in props.items():
        _bounded_text(key, "property name")
        if not key:
            _fail("property names cannot be empty")
        if not isinstance(spec, dict):
            _fail("property schema must be an object")
        if spec.get("type") == "array":
            allowed = _COMMON_KEYS | {"type", "items", "minItems", "maxItems"}
            _check_common(spec)
            if set(spec) - allowed:
                _fail("unsupported array schema keyword(s)")
            item = _mapping(spec.get("items"), "array items")
            if item.get("type", "string" if "anyOf" in item else None) != "string":
                _fail("only arrays of enum strings are supported")
            if set(item) - {"type", "enum", "anyOf"}:
                _fail("unsupported enum item schema keyword(s)")
            if "enum" in item:
                vals = _enum_values({"enum": item["enum"]})
            elif "anyOf" in item:
                vals = _enum_values({"oneOf": item["anyOf"]})
            else:
                _fail("array items must define enum or named anyOf choices")
            for k in ("minItems", "maxItems"):
                if k in spec and (type(spec[k]) is not int or spec[k] < 0 or spec[k] > _MAX_ENUM_VALUES):
                    _fail(f"{k} must be a bounded non-negative integer")
            if spec.get("minItems", 0) > spec.get("maxItems", _MAX_ENUM_VALUES):
                _fail("minItems exceeds maxItems")
            if "default" in spec:
                _validate_array(spec, vals, spec["default"], "default")
        else:
            _check_scalar_spec(spec)
    required = schema.get("required", [])
    required = _unique_strings(required, "required")
    if any(name not in props for name in required):
        _fail("required names must exist in properties")
    return None


def _format_valid(fmt, value):
    if fmt == "email":
        return len(value) <= 254 and re.fullmatch(r"[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+", value) is not None
    if fmt == "uri":
        try:
            p = urlsplit(value)
            return bool(p.scheme) and (bool(p.netloc) if p.scheme in {"http", "https", "ftp"} else True)
        except ValueError:
            return False
    if fmt == "date":
        try:
            _datetime.date.fromisoformat(value)
            return True
        except ValueError:
            return False
    if fmt == "date-time":
        try:
            _datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
            return "T" in value and ("Z" in value or "+" in value[10:] or "-" in value[10:])
        except ValueError:
            return False
    return True


def _validate_array(spec, enum, value, label):
    if not isinstance(value, list):
        _fail(f"{label} must be an array")
    if len(value) < spec.get("minItems", 0) or len(value) > spec.get("maxItems", _MAX_ENUM_VALUES):
        _fail(f"{label} violates array item count constraints")
    if any(not isinstance(item, str) or item not in enum for item in value):
        _fail(f"{label} contains a value outside the allowed choices")
    if len(set(value)) != len(value):
        _fail(f"{label} cannot contain duplicate choices")


def _validate_value(spec, value, label):
    typ = spec["type"]
    if typ == "string":
        if not isinstance(value, str):
            _fail(f"{label} must be a string")
        if len(value) < spec.get("minLength", 0) or len(value) > spec.get("maxLength", _MAX_STRING_LENGTH):
            _fail(f"{label} violates string length constraints")
        enum = _enum_values(spec)
        if enum is not None and value not in enum:
            _fail(f"{label} is not an allowed choice")
        if "format" in spec and not _format_valid(spec["format"], value):
            _fail(f"{label} is not a valid {spec['format']}")
    elif typ in {"number", "integer"}:
        _finite_number(value, label)
        if typ == "integer" and not isinstance(value, int):
            _fail(f"{label} must be an integer")
        if value < spec.get("minimum", -math.inf) or value > spec.get("maximum", math.inf):
            _fail(f"{label} is outside its allowed range")
    elif typ == "boolean":
        if not isinstance(value, bool):
            _fail(f"{label} must be a boolean")
    else:
        _fail("unsupported value type")


def validate_content(schema, content):
    """Return a shallow copy of validated form content or raise ValueError."""
    validate_schema(schema)
    content = _mapping(content, "content")
    props = schema["properties"]
    unknown = set(content) - set(props)
    if unknown:
        _fail("unknown content field(s): " + ", ".join(sorted(unknown)))
    missing = set(schema.get("required", [])) - set(content)
    if missing:
        _fail("missing required field(s): " + ", ".join(sorted(missing)))
    result = dict(content)
    for name, value in result.items():
        spec = props[name]
        if spec["type"] == "array":
            item = spec["items"]
            enum = item.get("enum")
            if enum is None:
                enum = [x["const"] for x in item["anyOf"]]
            _validate_array(spec, enum, value, name)
        else:
            _validate_value(spec, value, name)
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--help-schema", action="store_true", help="show supported schema subset")
    args = parser.parse_args()
    if args.help_schema:
        print("ACP form mode: flat primitive properties and enum-string arrays; see module docstring.")
