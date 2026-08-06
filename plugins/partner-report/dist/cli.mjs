#!/usr/bin/env node
var __defProp = Object.defineProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/cli.ts
import { createHash as createHash2, randomBytes as randomBytes2, randomUUID } from "node:crypto";
import {
  chmodSync as chmodSync4,
  existsSync as existsSync5,
  mkdtempSync,
  readFileSync as readFileSync4,
  rmSync,
  unlinkSync as unlinkSync2,
  writeFileSync as writeFileSync4
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { basename as basename3, dirname as dirname3, relative as relative3, resolve as resolve5 } from "node:path";
import { isDeepStrictEqual } from "node:util";

// ../../packages/contracts/node_modules/zod/v3/external.js
var external_exports = {};
__export(external_exports, {
  BRAND: () => BRAND,
  DIRTY: () => DIRTY,
  EMPTY_PATH: () => EMPTY_PATH,
  INVALID: () => INVALID,
  NEVER: () => NEVER,
  OK: () => OK,
  ParseStatus: () => ParseStatus,
  Schema: () => ZodType,
  ZodAny: () => ZodAny,
  ZodArray: () => ZodArray,
  ZodBigInt: () => ZodBigInt,
  ZodBoolean: () => ZodBoolean,
  ZodBranded: () => ZodBranded,
  ZodCatch: () => ZodCatch,
  ZodDate: () => ZodDate,
  ZodDefault: () => ZodDefault,
  ZodDiscriminatedUnion: () => ZodDiscriminatedUnion,
  ZodEffects: () => ZodEffects,
  ZodEnum: () => ZodEnum,
  ZodError: () => ZodError,
  ZodFirstPartyTypeKind: () => ZodFirstPartyTypeKind,
  ZodFunction: () => ZodFunction,
  ZodIntersection: () => ZodIntersection,
  ZodIssueCode: () => ZodIssueCode,
  ZodLazy: () => ZodLazy,
  ZodLiteral: () => ZodLiteral,
  ZodMap: () => ZodMap,
  ZodNaN: () => ZodNaN,
  ZodNativeEnum: () => ZodNativeEnum,
  ZodNever: () => ZodNever,
  ZodNull: () => ZodNull,
  ZodNullable: () => ZodNullable,
  ZodNumber: () => ZodNumber,
  ZodObject: () => ZodObject,
  ZodOptional: () => ZodOptional,
  ZodParsedType: () => ZodParsedType,
  ZodPipeline: () => ZodPipeline,
  ZodPromise: () => ZodPromise,
  ZodReadonly: () => ZodReadonly,
  ZodRecord: () => ZodRecord,
  ZodSchema: () => ZodType,
  ZodSet: () => ZodSet,
  ZodString: () => ZodString,
  ZodSymbol: () => ZodSymbol,
  ZodTransformer: () => ZodEffects,
  ZodTuple: () => ZodTuple,
  ZodType: () => ZodType,
  ZodUndefined: () => ZodUndefined,
  ZodUnion: () => ZodUnion,
  ZodUnknown: () => ZodUnknown,
  ZodVoid: () => ZodVoid,
  addIssueToContext: () => addIssueToContext,
  any: () => anyType,
  array: () => arrayType,
  bigint: () => bigIntType,
  boolean: () => booleanType,
  coerce: () => coerce,
  custom: () => custom,
  date: () => dateType,
  datetimeRegex: () => datetimeRegex,
  defaultErrorMap: () => en_default,
  discriminatedUnion: () => discriminatedUnionType,
  effect: () => effectsType,
  enum: () => enumType,
  function: () => functionType,
  getErrorMap: () => getErrorMap,
  getParsedType: () => getParsedType,
  instanceof: () => instanceOfType,
  intersection: () => intersectionType,
  isAborted: () => isAborted,
  isAsync: () => isAsync,
  isDirty: () => isDirty,
  isValid: () => isValid,
  late: () => late,
  lazy: () => lazyType,
  literal: () => literalType,
  makeIssue: () => makeIssue,
  map: () => mapType,
  nan: () => nanType,
  nativeEnum: () => nativeEnumType,
  never: () => neverType,
  null: () => nullType,
  nullable: () => nullableType,
  number: () => numberType,
  object: () => objectType,
  objectUtil: () => objectUtil,
  oboolean: () => oboolean,
  onumber: () => onumber,
  optional: () => optionalType,
  ostring: () => ostring,
  pipeline: () => pipelineType,
  preprocess: () => preprocessType,
  promise: () => promiseType,
  quotelessJson: () => quotelessJson,
  record: () => recordType,
  set: () => setType,
  setErrorMap: () => setErrorMap,
  strictObject: () => strictObjectType,
  string: () => stringType,
  symbol: () => symbolType,
  transformer: () => effectsType,
  tuple: () => tupleType,
  undefined: () => undefinedType,
  union: () => unionType,
  unknown: () => unknownType,
  util: () => util,
  void: () => voidType
});

// ../../packages/contracts/node_modules/zod/v3/helpers/util.js
var util;
(function(util2) {
  util2.assertEqual = (_) => {
  };
  function assertIs(_arg) {
  }
  util2.assertIs = assertIs;
  function assertNever(_x) {
    throw new Error();
  }
  util2.assertNever = assertNever;
  util2.arrayToEnum = (items) => {
    const obj = {};
    for (const item of items) {
      obj[item] = item;
    }
    return obj;
  };
  util2.getValidEnumValues = (obj) => {
    const validKeys = util2.objectKeys(obj).filter((k) => typeof obj[obj[k]] !== "number");
    const filtered = {};
    for (const k of validKeys) {
      filtered[k] = obj[k];
    }
    return util2.objectValues(filtered);
  };
  util2.objectValues = (obj) => {
    return util2.objectKeys(obj).map(function(e) {
      return obj[e];
    });
  };
  util2.objectKeys = typeof Object.keys === "function" ? (obj) => Object.keys(obj) : (object) => {
    const keys = [];
    for (const key in object) {
      if (Object.prototype.hasOwnProperty.call(object, key)) {
        keys.push(key);
      }
    }
    return keys;
  };
  util2.find = (arr, checker) => {
    for (const item of arr) {
      if (checker(item))
        return item;
    }
    return void 0;
  };
  util2.isInteger = typeof Number.isInteger === "function" ? (val) => Number.isInteger(val) : (val) => typeof val === "number" && Number.isFinite(val) && Math.floor(val) === val;
  function joinValues(array, separator = " | ") {
    return array.map((val) => typeof val === "string" ? `'${val}'` : val).join(separator);
  }
  util2.joinValues = joinValues;
  util2.jsonStringifyReplacer = (_, value) => {
    if (typeof value === "bigint") {
      return value.toString();
    }
    return value;
  };
})(util || (util = {}));
var objectUtil;
(function(objectUtil2) {
  objectUtil2.mergeShapes = (first, second) => {
    return {
      ...first,
      ...second
      // second overwrites first
    };
  };
})(objectUtil || (objectUtil = {}));
var ZodParsedType = util.arrayToEnum([
  "string",
  "nan",
  "number",
  "integer",
  "float",
  "boolean",
  "date",
  "bigint",
  "symbol",
  "function",
  "undefined",
  "null",
  "array",
  "object",
  "unknown",
  "promise",
  "void",
  "never",
  "map",
  "set"
]);
var getParsedType = (data) => {
  const t = typeof data;
  switch (t) {
    case "undefined":
      return ZodParsedType.undefined;
    case "string":
      return ZodParsedType.string;
    case "number":
      return Number.isNaN(data) ? ZodParsedType.nan : ZodParsedType.number;
    case "boolean":
      return ZodParsedType.boolean;
    case "function":
      return ZodParsedType.function;
    case "bigint":
      return ZodParsedType.bigint;
    case "symbol":
      return ZodParsedType.symbol;
    case "object":
      if (Array.isArray(data)) {
        return ZodParsedType.array;
      }
      if (data === null) {
        return ZodParsedType.null;
      }
      if (data.then && typeof data.then === "function" && data.catch && typeof data.catch === "function") {
        return ZodParsedType.promise;
      }
      if (typeof Map !== "undefined" && data instanceof Map) {
        return ZodParsedType.map;
      }
      if (typeof Set !== "undefined" && data instanceof Set) {
        return ZodParsedType.set;
      }
      if (typeof Date !== "undefined" && data instanceof Date) {
        return ZodParsedType.date;
      }
      return ZodParsedType.object;
    default:
      return ZodParsedType.unknown;
  }
};

// ../../packages/contracts/node_modules/zod/v3/ZodError.js
var ZodIssueCode = util.arrayToEnum([
  "invalid_type",
  "invalid_literal",
  "custom",
  "invalid_union",
  "invalid_union_discriminator",
  "invalid_enum_value",
  "unrecognized_keys",
  "invalid_arguments",
  "invalid_return_type",
  "invalid_date",
  "invalid_string",
  "too_small",
  "too_big",
  "invalid_intersection_types",
  "not_multiple_of",
  "not_finite"
]);
var quotelessJson = (obj) => {
  const json = JSON.stringify(obj, null, 2);
  return json.replace(/"([^"]+)":/g, "$1:");
};
var ZodError = class _ZodError extends Error {
  get errors() {
    return this.issues;
  }
  constructor(issues) {
    super();
    this.issues = [];
    this.addIssue = (sub) => {
      this.issues = [...this.issues, sub];
    };
    this.addIssues = (subs = []) => {
      this.issues = [...this.issues, ...subs];
    };
    const actualProto = new.target.prototype;
    if (Object.setPrototypeOf) {
      Object.setPrototypeOf(this, actualProto);
    } else {
      this.__proto__ = actualProto;
    }
    this.name = "ZodError";
    this.issues = issues;
  }
  format(_mapper) {
    const mapper = _mapper || function(issue) {
      return issue.message;
    };
    const fieldErrors = { _errors: [] };
    const processError = (error) => {
      for (const issue of error.issues) {
        if (issue.code === "invalid_union") {
          issue.unionErrors.map(processError);
        } else if (issue.code === "invalid_return_type") {
          processError(issue.returnTypeError);
        } else if (issue.code === "invalid_arguments") {
          processError(issue.argumentsError);
        } else if (issue.path.length === 0) {
          fieldErrors._errors.push(mapper(issue));
        } else {
          let curr = fieldErrors;
          let i = 0;
          while (i < issue.path.length) {
            const el = issue.path[i];
            const terminal = i === issue.path.length - 1;
            if (!terminal) {
              curr[el] = curr[el] || { _errors: [] };
            } else {
              curr[el] = curr[el] || { _errors: [] };
              curr[el]._errors.push(mapper(issue));
            }
            curr = curr[el];
            i++;
          }
        }
      }
    };
    processError(this);
    return fieldErrors;
  }
  static assert(value) {
    if (!(value instanceof _ZodError)) {
      throw new Error(`Not a ZodError: ${value}`);
    }
  }
  toString() {
    return this.message;
  }
  get message() {
    return JSON.stringify(this.issues, util.jsonStringifyReplacer, 2);
  }
  get isEmpty() {
    return this.issues.length === 0;
  }
  flatten(mapper = (issue) => issue.message) {
    const fieldErrors = {};
    const formErrors = [];
    for (const sub of this.issues) {
      if (sub.path.length > 0) {
        const firstEl = sub.path[0];
        fieldErrors[firstEl] = fieldErrors[firstEl] || [];
        fieldErrors[firstEl].push(mapper(sub));
      } else {
        formErrors.push(mapper(sub));
      }
    }
    return { formErrors, fieldErrors };
  }
  get formErrors() {
    return this.flatten();
  }
};
ZodError.create = (issues) => {
  const error = new ZodError(issues);
  return error;
};

// ../../packages/contracts/node_modules/zod/v3/locales/en.js
var errorMap = (issue, _ctx) => {
  let message;
  switch (issue.code) {
    case ZodIssueCode.invalid_type:
      if (issue.received === ZodParsedType.undefined) {
        message = "Required";
      } else {
        message = `Expected ${issue.expected}, received ${issue.received}`;
      }
      break;
    case ZodIssueCode.invalid_literal:
      message = `Invalid literal value, expected ${JSON.stringify(issue.expected, util.jsonStringifyReplacer)}`;
      break;
    case ZodIssueCode.unrecognized_keys:
      message = `Unrecognized key(s) in object: ${util.joinValues(issue.keys, ", ")}`;
      break;
    case ZodIssueCode.invalid_union:
      message = `Invalid input`;
      break;
    case ZodIssueCode.invalid_union_discriminator:
      message = `Invalid discriminator value. Expected ${util.joinValues(issue.options)}`;
      break;
    case ZodIssueCode.invalid_enum_value:
      message = `Invalid enum value. Expected ${util.joinValues(issue.options)}, received '${issue.received}'`;
      break;
    case ZodIssueCode.invalid_arguments:
      message = `Invalid function arguments`;
      break;
    case ZodIssueCode.invalid_return_type:
      message = `Invalid function return type`;
      break;
    case ZodIssueCode.invalid_date:
      message = `Invalid date`;
      break;
    case ZodIssueCode.invalid_string:
      if (typeof issue.validation === "object") {
        if ("includes" in issue.validation) {
          message = `Invalid input: must include "${issue.validation.includes}"`;
          if (typeof issue.validation.position === "number") {
            message = `${message} at one or more positions greater than or equal to ${issue.validation.position}`;
          }
        } else if ("startsWith" in issue.validation) {
          message = `Invalid input: must start with "${issue.validation.startsWith}"`;
        } else if ("endsWith" in issue.validation) {
          message = `Invalid input: must end with "${issue.validation.endsWith}"`;
        } else {
          util.assertNever(issue.validation);
        }
      } else if (issue.validation !== "regex") {
        message = `Invalid ${issue.validation}`;
      } else {
        message = "Invalid";
      }
      break;
    case ZodIssueCode.too_small:
      if (issue.type === "array")
        message = `Array must contain ${issue.exact ? "exactly" : issue.inclusive ? `at least` : `more than`} ${issue.minimum} element(s)`;
      else if (issue.type === "string")
        message = `String must contain ${issue.exact ? "exactly" : issue.inclusive ? `at least` : `over`} ${issue.minimum} character(s)`;
      else if (issue.type === "number")
        message = `Number must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${issue.minimum}`;
      else if (issue.type === "bigint")
        message = `Number must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${issue.minimum}`;
      else if (issue.type === "date")
        message = `Date must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${new Date(Number(issue.minimum))}`;
      else
        message = "Invalid input";
      break;
    case ZodIssueCode.too_big:
      if (issue.type === "array")
        message = `Array must contain ${issue.exact ? `exactly` : issue.inclusive ? `at most` : `less than`} ${issue.maximum} element(s)`;
      else if (issue.type === "string")
        message = `String must contain ${issue.exact ? `exactly` : issue.inclusive ? `at most` : `under`} ${issue.maximum} character(s)`;
      else if (issue.type === "number")
        message = `Number must be ${issue.exact ? `exactly` : issue.inclusive ? `less than or equal to` : `less than`} ${issue.maximum}`;
      else if (issue.type === "bigint")
        message = `BigInt must be ${issue.exact ? `exactly` : issue.inclusive ? `less than or equal to` : `less than`} ${issue.maximum}`;
      else if (issue.type === "date")
        message = `Date must be ${issue.exact ? `exactly` : issue.inclusive ? `smaller than or equal to` : `smaller than`} ${new Date(Number(issue.maximum))}`;
      else
        message = "Invalid input";
      break;
    case ZodIssueCode.custom:
      message = `Invalid input`;
      break;
    case ZodIssueCode.invalid_intersection_types:
      message = `Intersection results could not be merged`;
      break;
    case ZodIssueCode.not_multiple_of:
      message = `Number must be a multiple of ${issue.multipleOf}`;
      break;
    case ZodIssueCode.not_finite:
      message = "Number must be finite";
      break;
    default:
      message = _ctx.defaultError;
      util.assertNever(issue);
  }
  return { message };
};
var en_default = errorMap;

// ../../packages/contracts/node_modules/zod/v3/errors.js
var overrideErrorMap = en_default;
function setErrorMap(map) {
  overrideErrorMap = map;
}
function getErrorMap() {
  return overrideErrorMap;
}

// ../../packages/contracts/node_modules/zod/v3/helpers/parseUtil.js
var makeIssue = (params) => {
  const { data, path, errorMaps, issueData } = params;
  const fullPath = [...path, ...issueData.path || []];
  const fullIssue = {
    ...issueData,
    path: fullPath
  };
  if (issueData.message !== void 0) {
    return {
      ...issueData,
      path: fullPath,
      message: issueData.message
    };
  }
  let errorMessage = "";
  const maps = errorMaps.filter((m) => !!m).slice().reverse();
  for (const map of maps) {
    errorMessage = map(fullIssue, { data, defaultError: errorMessage }).message;
  }
  return {
    ...issueData,
    path: fullPath,
    message: errorMessage
  };
};
var EMPTY_PATH = [];
function addIssueToContext(ctx, issueData) {
  const overrideMap = getErrorMap();
  const issue = makeIssue({
    issueData,
    data: ctx.data,
    path: ctx.path,
    errorMaps: [
      ctx.common.contextualErrorMap,
      // contextual error map is first priority
      ctx.schemaErrorMap,
      // then schema-bound map if available
      overrideMap,
      // then global override map
      overrideMap === en_default ? void 0 : en_default
      // then global default map
    ].filter((x) => !!x)
  });
  ctx.common.issues.push(issue);
}
var ParseStatus = class _ParseStatus {
  constructor() {
    this.value = "valid";
  }
  dirty() {
    if (this.value === "valid")
      this.value = "dirty";
  }
  abort() {
    if (this.value !== "aborted")
      this.value = "aborted";
  }
  static mergeArray(status2, results) {
    const arrayValue = [];
    for (const s of results) {
      if (s.status === "aborted")
        return INVALID;
      if (s.status === "dirty")
        status2.dirty();
      arrayValue.push(s.value);
    }
    return { status: status2.value, value: arrayValue };
  }
  static async mergeObjectAsync(status2, pairs) {
    const syncPairs = [];
    for (const pair of pairs) {
      const key = await pair.key;
      const value = await pair.value;
      syncPairs.push({
        key,
        value
      });
    }
    return _ParseStatus.mergeObjectSync(status2, syncPairs);
  }
  static mergeObjectSync(status2, pairs) {
    const finalObject = {};
    for (const pair of pairs) {
      const { key, value } = pair;
      if (key.status === "aborted")
        return INVALID;
      if (value.status === "aborted")
        return INVALID;
      if (key.status === "dirty")
        status2.dirty();
      if (value.status === "dirty")
        status2.dirty();
      if (key.value !== "__proto__" && (typeof value.value !== "undefined" || pair.alwaysSet)) {
        finalObject[key.value] = value.value;
      }
    }
    return { status: status2.value, value: finalObject };
  }
};
var INVALID = Object.freeze({
  status: "aborted"
});
var DIRTY = (value) => ({ status: "dirty", value });
var OK = (value) => ({ status: "valid", value });
var isAborted = (x) => x.status === "aborted";
var isDirty = (x) => x.status === "dirty";
var isValid = (x) => x.status === "valid";
var isAsync = (x) => typeof Promise !== "undefined" && x instanceof Promise;

// ../../packages/contracts/node_modules/zod/v3/helpers/errorUtil.js
var errorUtil;
(function(errorUtil2) {
  errorUtil2.errToObj = (message) => typeof message === "string" ? { message } : message || {};
  errorUtil2.toString = (message) => typeof message === "string" ? message : message?.message;
})(errorUtil || (errorUtil = {}));

// ../../packages/contracts/node_modules/zod/v3/types.js
var ParseInputLazyPath = class {
  constructor(parent, value, path, key) {
    this._cachedPath = [];
    this.parent = parent;
    this.data = value;
    this._path = path;
    this._key = key;
  }
  get path() {
    if (!this._cachedPath.length) {
      if (Array.isArray(this._key)) {
        this._cachedPath.push(...this._path, ...this._key);
      } else {
        this._cachedPath.push(...this._path, this._key);
      }
    }
    return this._cachedPath;
  }
};
var handleResult = (ctx, result) => {
  if (isValid(result)) {
    return { success: true, data: result.value };
  } else {
    if (!ctx.common.issues.length) {
      throw new Error("Validation failed but no issues detected.");
    }
    return {
      success: false,
      get error() {
        if (this._error)
          return this._error;
        const error = new ZodError(ctx.common.issues);
        this._error = error;
        return this._error;
      }
    };
  }
};
function processCreateParams(params) {
  if (!params)
    return {};
  const { errorMap: errorMap2, invalid_type_error, required_error, description } = params;
  if (errorMap2 && (invalid_type_error || required_error)) {
    throw new Error(`Can't use "invalid_type_error" or "required_error" in conjunction with custom error map.`);
  }
  if (errorMap2)
    return { errorMap: errorMap2, description };
  const customMap = (iss, ctx) => {
    const { message } = params;
    if (iss.code === "invalid_enum_value") {
      return { message: message ?? ctx.defaultError };
    }
    if (typeof ctx.data === "undefined") {
      return { message: message ?? required_error ?? ctx.defaultError };
    }
    if (iss.code !== "invalid_type")
      return { message: ctx.defaultError };
    return { message: message ?? invalid_type_error ?? ctx.defaultError };
  };
  return { errorMap: customMap, description };
}
var ZodType = class {
  get description() {
    return this._def.description;
  }
  _getType(input) {
    return getParsedType(input.data);
  }
  _getOrReturnCtx(input, ctx) {
    return ctx || {
      common: input.parent.common,
      data: input.data,
      parsedType: getParsedType(input.data),
      schemaErrorMap: this._def.errorMap,
      path: input.path,
      parent: input.parent
    };
  }
  _processInputParams(input) {
    return {
      status: new ParseStatus(),
      ctx: {
        common: input.parent.common,
        data: input.data,
        parsedType: getParsedType(input.data),
        schemaErrorMap: this._def.errorMap,
        path: input.path,
        parent: input.parent
      }
    };
  }
  _parseSync(input) {
    const result = this._parse(input);
    if (isAsync(result)) {
      throw new Error("Synchronous parse encountered promise.");
    }
    return result;
  }
  _parseAsync(input) {
    const result = this._parse(input);
    return Promise.resolve(result);
  }
  parse(data, params) {
    const result = this.safeParse(data, params);
    if (result.success)
      return result.data;
    throw result.error;
  }
  safeParse(data, params) {
    const ctx = {
      common: {
        issues: [],
        async: params?.async ?? false,
        contextualErrorMap: params?.errorMap
      },
      path: params?.path || [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data)
    };
    const result = this._parseSync({ data, path: ctx.path, parent: ctx });
    return handleResult(ctx, result);
  }
  "~validate"(data) {
    const ctx = {
      common: {
        issues: [],
        async: !!this["~standard"].async
      },
      path: [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data)
    };
    if (!this["~standard"].async) {
      try {
        const result = this._parseSync({ data, path: [], parent: ctx });
        return isValid(result) ? {
          value: result.value
        } : {
          issues: ctx.common.issues
        };
      } catch (err) {
        if (err?.message?.toLowerCase()?.includes("encountered")) {
          this["~standard"].async = true;
        }
        ctx.common = {
          issues: [],
          async: true
        };
      }
    }
    return this._parseAsync({ data, path: [], parent: ctx }).then((result) => isValid(result) ? {
      value: result.value
    } : {
      issues: ctx.common.issues
    });
  }
  async parseAsync(data, params) {
    const result = await this.safeParseAsync(data, params);
    if (result.success)
      return result.data;
    throw result.error;
  }
  async safeParseAsync(data, params) {
    const ctx = {
      common: {
        issues: [],
        contextualErrorMap: params?.errorMap,
        async: true
      },
      path: params?.path || [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data)
    };
    const maybeAsyncResult = this._parse({ data, path: ctx.path, parent: ctx });
    const result = await (isAsync(maybeAsyncResult) ? maybeAsyncResult : Promise.resolve(maybeAsyncResult));
    return handleResult(ctx, result);
  }
  refine(check, message) {
    const getIssueProperties = (val) => {
      if (typeof message === "string" || typeof message === "undefined") {
        return { message };
      } else if (typeof message === "function") {
        return message(val);
      } else {
        return message;
      }
    };
    return this._refinement((val, ctx) => {
      const result = check(val);
      const setError = () => ctx.addIssue({
        code: ZodIssueCode.custom,
        ...getIssueProperties(val)
      });
      if (typeof Promise !== "undefined" && result instanceof Promise) {
        return result.then((data) => {
          if (!data) {
            setError();
            return false;
          } else {
            return true;
          }
        });
      }
      if (!result) {
        setError();
        return false;
      } else {
        return true;
      }
    });
  }
  refinement(check, refinementData) {
    return this._refinement((val, ctx) => {
      if (!check(val)) {
        ctx.addIssue(typeof refinementData === "function" ? refinementData(val, ctx) : refinementData);
        return false;
      } else {
        return true;
      }
    });
  }
  _refinement(refinement) {
    return new ZodEffects({
      schema: this,
      typeName: ZodFirstPartyTypeKind.ZodEffects,
      effect: { type: "refinement", refinement }
    });
  }
  superRefine(refinement) {
    return this._refinement(refinement);
  }
  constructor(def) {
    this.spa = this.safeParseAsync;
    this._def = def;
    this.parse = this.parse.bind(this);
    this.safeParse = this.safeParse.bind(this);
    this.parseAsync = this.parseAsync.bind(this);
    this.safeParseAsync = this.safeParseAsync.bind(this);
    this.spa = this.spa.bind(this);
    this.refine = this.refine.bind(this);
    this.refinement = this.refinement.bind(this);
    this.superRefine = this.superRefine.bind(this);
    this.optional = this.optional.bind(this);
    this.nullable = this.nullable.bind(this);
    this.nullish = this.nullish.bind(this);
    this.array = this.array.bind(this);
    this.promise = this.promise.bind(this);
    this.or = this.or.bind(this);
    this.and = this.and.bind(this);
    this.transform = this.transform.bind(this);
    this.brand = this.brand.bind(this);
    this.default = this.default.bind(this);
    this.catch = this.catch.bind(this);
    this.describe = this.describe.bind(this);
    this.pipe = this.pipe.bind(this);
    this.readonly = this.readonly.bind(this);
    this.isNullable = this.isNullable.bind(this);
    this.isOptional = this.isOptional.bind(this);
    this["~standard"] = {
      version: 1,
      vendor: "zod",
      validate: (data) => this["~validate"](data)
    };
  }
  optional() {
    return ZodOptional.create(this, this._def);
  }
  nullable() {
    return ZodNullable.create(this, this._def);
  }
  nullish() {
    return this.nullable().optional();
  }
  array() {
    return ZodArray.create(this);
  }
  promise() {
    return ZodPromise.create(this, this._def);
  }
  or(option2) {
    return ZodUnion.create([this, option2], this._def);
  }
  and(incoming) {
    return ZodIntersection.create(this, incoming, this._def);
  }
  transform(transform) {
    return new ZodEffects({
      ...processCreateParams(this._def),
      schema: this,
      typeName: ZodFirstPartyTypeKind.ZodEffects,
      effect: { type: "transform", transform }
    });
  }
  default(def) {
    const defaultValueFunc = typeof def === "function" ? def : () => def;
    return new ZodDefault({
      ...processCreateParams(this._def),
      innerType: this,
      defaultValue: defaultValueFunc,
      typeName: ZodFirstPartyTypeKind.ZodDefault
    });
  }
  brand() {
    return new ZodBranded({
      typeName: ZodFirstPartyTypeKind.ZodBranded,
      type: this,
      ...processCreateParams(this._def)
    });
  }
  catch(def) {
    const catchValueFunc = typeof def === "function" ? def : () => def;
    return new ZodCatch({
      ...processCreateParams(this._def),
      innerType: this,
      catchValue: catchValueFunc,
      typeName: ZodFirstPartyTypeKind.ZodCatch
    });
  }
  describe(description) {
    const This = this.constructor;
    return new This({
      ...this._def,
      description
    });
  }
  pipe(target) {
    return ZodPipeline.create(this, target);
  }
  readonly() {
    return ZodReadonly.create(this);
  }
  isOptional() {
    return this.safeParse(void 0).success;
  }
  isNullable() {
    return this.safeParse(null).success;
  }
};
var cuidRegex = /^c[^\s-]{8,}$/i;
var cuid2Regex = /^[0-9a-z]+$/;
var ulidRegex = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
var uuidRegex = /^[0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12}$/i;
var nanoidRegex = /^[a-z0-9_-]{21}$/i;
var jwtRegex = /^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]*$/;
var durationRegex = /^[-+]?P(?!$)(?:(?:[-+]?\d+Y)|(?:[-+]?\d+[.,]\d+Y$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:(?:[-+]?\d+W)|(?:[-+]?\d+[.,]\d+W$))?(?:(?:[-+]?\d+D)|(?:[-+]?\d+[.,]\d+D$))?(?:T(?=[\d+-])(?:(?:[-+]?\d+H)|(?:[-+]?\d+[.,]\d+H$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:[-+]?\d+(?:[.,]\d+)?S)?)??$/;
var emailRegex = /^(?!\.)(?!.*\.\.)([A-Z0-9_'+\-\.]*)[A-Z0-9_+-]@([A-Z0-9][A-Z0-9\-]*\.)+[A-Z]{2,}$/i;
var _emojiRegex = `^(\\p{Extended_Pictographic}|\\p{Emoji_Component})+$`;
var emojiRegex;
var ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/;
var ipv4CidrRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\/(3[0-2]|[12]?[0-9])$/;
var ipv6Regex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))$/;
var ipv6CidrRegex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))\/(12[0-8]|1[01][0-9]|[1-9]?[0-9])$/;
var base64Regex = /^([0-9a-zA-Z+/]{4})*(([0-9a-zA-Z+/]{2}==)|([0-9a-zA-Z+/]{3}=))?$/;
var base64urlRegex = /^([0-9a-zA-Z-_]{4})*(([0-9a-zA-Z-_]{2}(==)?)|([0-9a-zA-Z-_]{3}(=)?))?$/;
var dateRegexSource = `((\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-((0[13578]|1[02])-(0[1-9]|[12]\\d|3[01])|(0[469]|11)-(0[1-9]|[12]\\d|30)|(02)-(0[1-9]|1\\d|2[0-8])))`;
var dateRegex = new RegExp(`^${dateRegexSource}$`);
function timeRegexSource(args) {
  let secondsRegexSource = `[0-5]\\d`;
  if (args.precision) {
    secondsRegexSource = `${secondsRegexSource}\\.\\d{${args.precision}}`;
  } else if (args.precision == null) {
    secondsRegexSource = `${secondsRegexSource}(\\.\\d+)?`;
  }
  const secondsQuantifier = args.precision ? "+" : "?";
  return `([01]\\d|2[0-3]):[0-5]\\d(:${secondsRegexSource})${secondsQuantifier}`;
}
function timeRegex(args) {
  return new RegExp(`^${timeRegexSource(args)}$`);
}
function datetimeRegex(args) {
  let regex = `${dateRegexSource}T${timeRegexSource(args)}`;
  const opts = [];
  opts.push(args.local ? `Z?` : `Z`);
  if (args.offset)
    opts.push(`([+-]\\d{2}:?\\d{2})`);
  regex = `${regex}(${opts.join("|")})`;
  return new RegExp(`^${regex}$`);
}
function isValidIP(ip, version) {
  if ((version === "v4" || !version) && ipv4Regex.test(ip)) {
    return true;
  }
  if ((version === "v6" || !version) && ipv6Regex.test(ip)) {
    return true;
  }
  return false;
}
function isValidJWT(jwt, alg) {
  if (!jwtRegex.test(jwt))
    return false;
  try {
    const [header] = jwt.split(".");
    if (!header)
      return false;
    const base64 = header.replace(/-/g, "+").replace(/_/g, "/").padEnd(header.length + (4 - header.length % 4) % 4, "=");
    const decoded = JSON.parse(atob(base64));
    if (typeof decoded !== "object" || decoded === null)
      return false;
    if ("typ" in decoded && decoded?.typ !== "JWT")
      return false;
    if (!decoded.alg)
      return false;
    if (alg && decoded.alg !== alg)
      return false;
    return true;
  } catch {
    return false;
  }
}
function isValidCidr(ip, version) {
  if ((version === "v4" || !version) && ipv4CidrRegex.test(ip)) {
    return true;
  }
  if ((version === "v6" || !version) && ipv6CidrRegex.test(ip)) {
    return true;
  }
  return false;
}
var ZodString = class _ZodString extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = String(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.string) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.string,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    const status2 = new ParseStatus();
    let ctx = void 0;
    for (const check of this._def.checks) {
      if (check.kind === "min") {
        if (input.data.length < check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            minimum: check.value,
            type: "string",
            inclusive: true,
            exact: false,
            message: check.message
          });
          status2.dirty();
        }
      } else if (check.kind === "max") {
        if (input.data.length > check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            maximum: check.value,
            type: "string",
            inclusive: true,
            exact: false,
            message: check.message
          });
          status2.dirty();
        }
      } else if (check.kind === "length") {
        const tooBig = input.data.length > check.value;
        const tooSmall = input.data.length < check.value;
        if (tooBig || tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          if (tooBig) {
            addIssueToContext(ctx, {
              code: ZodIssueCode.too_big,
              maximum: check.value,
              type: "string",
              inclusive: true,
              exact: true,
              message: check.message
            });
          } else if (tooSmall) {
            addIssueToContext(ctx, {
              code: ZodIssueCode.too_small,
              minimum: check.value,
              type: "string",
              inclusive: true,
              exact: true,
              message: check.message
            });
          }
          status2.dirty();
        }
      } else if (check.kind === "email") {
        if (!emailRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "email",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status2.dirty();
        }
      } else if (check.kind === "emoji") {
        if (!emojiRegex) {
          emojiRegex = new RegExp(_emojiRegex, "u");
        }
        if (!emojiRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "emoji",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status2.dirty();
        }
      } else if (check.kind === "uuid") {
        if (!uuidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "uuid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status2.dirty();
        }
      } else if (check.kind === "nanoid") {
        if (!nanoidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "nanoid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status2.dirty();
        }
      } else if (check.kind === "cuid") {
        if (!cuidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cuid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status2.dirty();
        }
      } else if (check.kind === "cuid2") {
        if (!cuid2Regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cuid2",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status2.dirty();
        }
      } else if (check.kind === "ulid") {
        if (!ulidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "ulid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status2.dirty();
        }
      } else if (check.kind === "url") {
        try {
          new URL(input.data);
        } catch {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "url",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status2.dirty();
        }
      } else if (check.kind === "regex") {
        check.regex.lastIndex = 0;
        const testResult = check.regex.test(input.data);
        if (!testResult) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "regex",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status2.dirty();
        }
      } else if (check.kind === "trim") {
        input.data = input.data.trim();
      } else if (check.kind === "includes") {
        if (!input.data.includes(check.value, check.position)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { includes: check.value, position: check.position },
            message: check.message
          });
          status2.dirty();
        }
      } else if (check.kind === "toLowerCase") {
        input.data = input.data.toLowerCase();
      } else if (check.kind === "toUpperCase") {
        input.data = input.data.toUpperCase();
      } else if (check.kind === "startsWith") {
        if (!input.data.startsWith(check.value)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { startsWith: check.value },
            message: check.message
          });
          status2.dirty();
        }
      } else if (check.kind === "endsWith") {
        if (!input.data.endsWith(check.value)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { endsWith: check.value },
            message: check.message
          });
          status2.dirty();
        }
      } else if (check.kind === "datetime") {
        const regex = datetimeRegex(check);
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: "datetime",
            message: check.message
          });
          status2.dirty();
        }
      } else if (check.kind === "date") {
        const regex = dateRegex;
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: "date",
            message: check.message
          });
          status2.dirty();
        }
      } else if (check.kind === "time") {
        const regex = timeRegex(check);
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: "time",
            message: check.message
          });
          status2.dirty();
        }
      } else if (check.kind === "duration") {
        if (!durationRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "duration",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status2.dirty();
        }
      } else if (check.kind === "ip") {
        if (!isValidIP(input.data, check.version)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "ip",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status2.dirty();
        }
      } else if (check.kind === "jwt") {
        if (!isValidJWT(input.data, check.alg)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "jwt",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status2.dirty();
        }
      } else if (check.kind === "cidr") {
        if (!isValidCidr(input.data, check.version)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cidr",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status2.dirty();
        }
      } else if (check.kind === "base64") {
        if (!base64Regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "base64",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status2.dirty();
        }
      } else if (check.kind === "base64url") {
        if (!base64urlRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "base64url",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status2.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return { status: status2.value, value: input.data };
  }
  _regex(regex, validation, message) {
    return this.refinement((data) => regex.test(data), {
      validation,
      code: ZodIssueCode.invalid_string,
      ...errorUtil.errToObj(message)
    });
  }
  _addCheck(check) {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  email(message) {
    return this._addCheck({ kind: "email", ...errorUtil.errToObj(message) });
  }
  url(message) {
    return this._addCheck({ kind: "url", ...errorUtil.errToObj(message) });
  }
  emoji(message) {
    return this._addCheck({ kind: "emoji", ...errorUtil.errToObj(message) });
  }
  uuid(message) {
    return this._addCheck({ kind: "uuid", ...errorUtil.errToObj(message) });
  }
  nanoid(message) {
    return this._addCheck({ kind: "nanoid", ...errorUtil.errToObj(message) });
  }
  cuid(message) {
    return this._addCheck({ kind: "cuid", ...errorUtil.errToObj(message) });
  }
  cuid2(message) {
    return this._addCheck({ kind: "cuid2", ...errorUtil.errToObj(message) });
  }
  ulid(message) {
    return this._addCheck({ kind: "ulid", ...errorUtil.errToObj(message) });
  }
  base64(message) {
    return this._addCheck({ kind: "base64", ...errorUtil.errToObj(message) });
  }
  base64url(message) {
    return this._addCheck({
      kind: "base64url",
      ...errorUtil.errToObj(message)
    });
  }
  jwt(options) {
    return this._addCheck({ kind: "jwt", ...errorUtil.errToObj(options) });
  }
  ip(options) {
    return this._addCheck({ kind: "ip", ...errorUtil.errToObj(options) });
  }
  cidr(options) {
    return this._addCheck({ kind: "cidr", ...errorUtil.errToObj(options) });
  }
  datetime(options) {
    if (typeof options === "string") {
      return this._addCheck({
        kind: "datetime",
        precision: null,
        offset: false,
        local: false,
        message: options
      });
    }
    return this._addCheck({
      kind: "datetime",
      precision: typeof options?.precision === "undefined" ? null : options?.precision,
      offset: options?.offset ?? false,
      local: options?.local ?? false,
      ...errorUtil.errToObj(options?.message)
    });
  }
  date(message) {
    return this._addCheck({ kind: "date", message });
  }
  time(options) {
    if (typeof options === "string") {
      return this._addCheck({
        kind: "time",
        precision: null,
        message: options
      });
    }
    return this._addCheck({
      kind: "time",
      precision: typeof options?.precision === "undefined" ? null : options?.precision,
      ...errorUtil.errToObj(options?.message)
    });
  }
  duration(message) {
    return this._addCheck({ kind: "duration", ...errorUtil.errToObj(message) });
  }
  regex(regex, message) {
    return this._addCheck({
      kind: "regex",
      regex,
      ...errorUtil.errToObj(message)
    });
  }
  includes(value, options) {
    return this._addCheck({
      kind: "includes",
      value,
      position: options?.position,
      ...errorUtil.errToObj(options?.message)
    });
  }
  startsWith(value, message) {
    return this._addCheck({
      kind: "startsWith",
      value,
      ...errorUtil.errToObj(message)
    });
  }
  endsWith(value, message) {
    return this._addCheck({
      kind: "endsWith",
      value,
      ...errorUtil.errToObj(message)
    });
  }
  min(minLength, message) {
    return this._addCheck({
      kind: "min",
      value: minLength,
      ...errorUtil.errToObj(message)
    });
  }
  max(maxLength, message) {
    return this._addCheck({
      kind: "max",
      value: maxLength,
      ...errorUtil.errToObj(message)
    });
  }
  length(len, message) {
    return this._addCheck({
      kind: "length",
      value: len,
      ...errorUtil.errToObj(message)
    });
  }
  /**
   * Equivalent to `.min(1)`
   */
  nonempty(message) {
    return this.min(1, errorUtil.errToObj(message));
  }
  trim() {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: "trim" }]
    });
  }
  toLowerCase() {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: "toLowerCase" }]
    });
  }
  toUpperCase() {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: "toUpperCase" }]
    });
  }
  get isDatetime() {
    return !!this._def.checks.find((ch) => ch.kind === "datetime");
  }
  get isDate() {
    return !!this._def.checks.find((ch) => ch.kind === "date");
  }
  get isTime() {
    return !!this._def.checks.find((ch) => ch.kind === "time");
  }
  get isDuration() {
    return !!this._def.checks.find((ch) => ch.kind === "duration");
  }
  get isEmail() {
    return !!this._def.checks.find((ch) => ch.kind === "email");
  }
  get isURL() {
    return !!this._def.checks.find((ch) => ch.kind === "url");
  }
  get isEmoji() {
    return !!this._def.checks.find((ch) => ch.kind === "emoji");
  }
  get isUUID() {
    return !!this._def.checks.find((ch) => ch.kind === "uuid");
  }
  get isNANOID() {
    return !!this._def.checks.find((ch) => ch.kind === "nanoid");
  }
  get isCUID() {
    return !!this._def.checks.find((ch) => ch.kind === "cuid");
  }
  get isCUID2() {
    return !!this._def.checks.find((ch) => ch.kind === "cuid2");
  }
  get isULID() {
    return !!this._def.checks.find((ch) => ch.kind === "ulid");
  }
  get isIP() {
    return !!this._def.checks.find((ch) => ch.kind === "ip");
  }
  get isCIDR() {
    return !!this._def.checks.find((ch) => ch.kind === "cidr");
  }
  get isBase64() {
    return !!this._def.checks.find((ch) => ch.kind === "base64");
  }
  get isBase64url() {
    return !!this._def.checks.find((ch) => ch.kind === "base64url");
  }
  get minLength() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min;
  }
  get maxLength() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max;
  }
};
ZodString.create = (params) => {
  return new ZodString({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodString,
    coerce: params?.coerce ?? false,
    ...processCreateParams(params)
  });
};
function floatSafeRemainder(val, step) {
  const valDecCount = (val.toString().split(".")[1] || "").length;
  const stepDecCount = (step.toString().split(".")[1] || "").length;
  const decCount = valDecCount > stepDecCount ? valDecCount : stepDecCount;
  const valInt = Number.parseInt(val.toFixed(decCount).replace(".", ""));
  const stepInt = Number.parseInt(step.toFixed(decCount).replace(".", ""));
  return valInt % stepInt / 10 ** decCount;
}
var ZodNumber = class _ZodNumber extends ZodType {
  constructor() {
    super(...arguments);
    this.min = this.gte;
    this.max = this.lte;
    this.step = this.multipleOf;
  }
  _parse(input) {
    if (this._def.coerce) {
      input.data = Number(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.number) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.number,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    let ctx = void 0;
    const status2 = new ParseStatus();
    for (const check of this._def.checks) {
      if (check.kind === "int") {
        if (!util.isInteger(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_type,
            expected: "integer",
            received: "float",
            message: check.message
          });
          status2.dirty();
        }
      } else if (check.kind === "min") {
        const tooSmall = check.inclusive ? input.data < check.value : input.data <= check.value;
        if (tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            minimum: check.value,
            type: "number",
            inclusive: check.inclusive,
            exact: false,
            message: check.message
          });
          status2.dirty();
        }
      } else if (check.kind === "max") {
        const tooBig = check.inclusive ? input.data > check.value : input.data >= check.value;
        if (tooBig) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            maximum: check.value,
            type: "number",
            inclusive: check.inclusive,
            exact: false,
            message: check.message
          });
          status2.dirty();
        }
      } else if (check.kind === "multipleOf") {
        if (floatSafeRemainder(input.data, check.value) !== 0) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_multiple_of,
            multipleOf: check.value,
            message: check.message
          });
          status2.dirty();
        }
      } else if (check.kind === "finite") {
        if (!Number.isFinite(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_finite,
            message: check.message
          });
          status2.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return { status: status2.value, value: input.data };
  }
  gte(value, message) {
    return this.setLimit("min", value, true, errorUtil.toString(message));
  }
  gt(value, message) {
    return this.setLimit("min", value, false, errorUtil.toString(message));
  }
  lte(value, message) {
    return this.setLimit("max", value, true, errorUtil.toString(message));
  }
  lt(value, message) {
    return this.setLimit("max", value, false, errorUtil.toString(message));
  }
  setLimit(kind, value, inclusive, message) {
    return new _ZodNumber({
      ...this._def,
      checks: [
        ...this._def.checks,
        {
          kind,
          value,
          inclusive,
          message: errorUtil.toString(message)
        }
      ]
    });
  }
  _addCheck(check) {
    return new _ZodNumber({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  int(message) {
    return this._addCheck({
      kind: "int",
      message: errorUtil.toString(message)
    });
  }
  positive(message) {
    return this._addCheck({
      kind: "min",
      value: 0,
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  negative(message) {
    return this._addCheck({
      kind: "max",
      value: 0,
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  nonpositive(message) {
    return this._addCheck({
      kind: "max",
      value: 0,
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  nonnegative(message) {
    return this._addCheck({
      kind: "min",
      value: 0,
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  multipleOf(value, message) {
    return this._addCheck({
      kind: "multipleOf",
      value,
      message: errorUtil.toString(message)
    });
  }
  finite(message) {
    return this._addCheck({
      kind: "finite",
      message: errorUtil.toString(message)
    });
  }
  safe(message) {
    return this._addCheck({
      kind: "min",
      inclusive: true,
      value: Number.MIN_SAFE_INTEGER,
      message: errorUtil.toString(message)
    })._addCheck({
      kind: "max",
      inclusive: true,
      value: Number.MAX_SAFE_INTEGER,
      message: errorUtil.toString(message)
    });
  }
  get minValue() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min;
  }
  get maxValue() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max;
  }
  get isInt() {
    return !!this._def.checks.find((ch) => ch.kind === "int" || ch.kind === "multipleOf" && util.isInteger(ch.value));
  }
  get isFinite() {
    let max = null;
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "finite" || ch.kind === "int" || ch.kind === "multipleOf") {
        return true;
      } else if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      } else if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return Number.isFinite(min) && Number.isFinite(max);
  }
};
ZodNumber.create = (params) => {
  return new ZodNumber({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodNumber,
    coerce: params?.coerce || false,
    ...processCreateParams(params)
  });
};
var ZodBigInt = class _ZodBigInt extends ZodType {
  constructor() {
    super(...arguments);
    this.min = this.gte;
    this.max = this.lte;
  }
  _parse(input) {
    if (this._def.coerce) {
      try {
        input.data = BigInt(input.data);
      } catch {
        return this._getInvalidInput(input);
      }
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.bigint) {
      return this._getInvalidInput(input);
    }
    let ctx = void 0;
    const status2 = new ParseStatus();
    for (const check of this._def.checks) {
      if (check.kind === "min") {
        const tooSmall = check.inclusive ? input.data < check.value : input.data <= check.value;
        if (tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            type: "bigint",
            minimum: check.value,
            inclusive: check.inclusive,
            message: check.message
          });
          status2.dirty();
        }
      } else if (check.kind === "max") {
        const tooBig = check.inclusive ? input.data > check.value : input.data >= check.value;
        if (tooBig) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            type: "bigint",
            maximum: check.value,
            inclusive: check.inclusive,
            message: check.message
          });
          status2.dirty();
        }
      } else if (check.kind === "multipleOf") {
        if (input.data % check.value !== BigInt(0)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_multiple_of,
            multipleOf: check.value,
            message: check.message
          });
          status2.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return { status: status2.value, value: input.data };
  }
  _getInvalidInput(input) {
    const ctx = this._getOrReturnCtx(input);
    addIssueToContext(ctx, {
      code: ZodIssueCode.invalid_type,
      expected: ZodParsedType.bigint,
      received: ctx.parsedType
    });
    return INVALID;
  }
  gte(value, message) {
    return this.setLimit("min", value, true, errorUtil.toString(message));
  }
  gt(value, message) {
    return this.setLimit("min", value, false, errorUtil.toString(message));
  }
  lte(value, message) {
    return this.setLimit("max", value, true, errorUtil.toString(message));
  }
  lt(value, message) {
    return this.setLimit("max", value, false, errorUtil.toString(message));
  }
  setLimit(kind, value, inclusive, message) {
    return new _ZodBigInt({
      ...this._def,
      checks: [
        ...this._def.checks,
        {
          kind,
          value,
          inclusive,
          message: errorUtil.toString(message)
        }
      ]
    });
  }
  _addCheck(check) {
    return new _ZodBigInt({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  positive(message) {
    return this._addCheck({
      kind: "min",
      value: BigInt(0),
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  negative(message) {
    return this._addCheck({
      kind: "max",
      value: BigInt(0),
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  nonpositive(message) {
    return this._addCheck({
      kind: "max",
      value: BigInt(0),
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  nonnegative(message) {
    return this._addCheck({
      kind: "min",
      value: BigInt(0),
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  multipleOf(value, message) {
    return this._addCheck({
      kind: "multipleOf",
      value,
      message: errorUtil.toString(message)
    });
  }
  get minValue() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min;
  }
  get maxValue() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max;
  }
};
ZodBigInt.create = (params) => {
  return new ZodBigInt({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodBigInt,
    coerce: params?.coerce ?? false,
    ...processCreateParams(params)
  });
};
var ZodBoolean = class extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = Boolean(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.boolean) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.boolean,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodBoolean.create = (params) => {
  return new ZodBoolean({
    typeName: ZodFirstPartyTypeKind.ZodBoolean,
    coerce: params?.coerce || false,
    ...processCreateParams(params)
  });
};
var ZodDate = class _ZodDate extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = new Date(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.date) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.date,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    if (Number.isNaN(input.data.getTime())) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_date
      });
      return INVALID;
    }
    const status2 = new ParseStatus();
    let ctx = void 0;
    for (const check of this._def.checks) {
      if (check.kind === "min") {
        if (input.data.getTime() < check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            message: check.message,
            inclusive: true,
            exact: false,
            minimum: check.value,
            type: "date"
          });
          status2.dirty();
        }
      } else if (check.kind === "max") {
        if (input.data.getTime() > check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            message: check.message,
            inclusive: true,
            exact: false,
            maximum: check.value,
            type: "date"
          });
          status2.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return {
      status: status2.value,
      value: new Date(input.data.getTime())
    };
  }
  _addCheck(check) {
    return new _ZodDate({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  min(minDate, message) {
    return this._addCheck({
      kind: "min",
      value: minDate.getTime(),
      message: errorUtil.toString(message)
    });
  }
  max(maxDate, message) {
    return this._addCheck({
      kind: "max",
      value: maxDate.getTime(),
      message: errorUtil.toString(message)
    });
  }
  get minDate() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min != null ? new Date(min) : null;
  }
  get maxDate() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max != null ? new Date(max) : null;
  }
};
ZodDate.create = (params) => {
  return new ZodDate({
    checks: [],
    coerce: params?.coerce || false,
    typeName: ZodFirstPartyTypeKind.ZodDate,
    ...processCreateParams(params)
  });
};
var ZodSymbol = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.symbol) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.symbol,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodSymbol.create = (params) => {
  return new ZodSymbol({
    typeName: ZodFirstPartyTypeKind.ZodSymbol,
    ...processCreateParams(params)
  });
};
var ZodUndefined = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.undefined) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.undefined,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodUndefined.create = (params) => {
  return new ZodUndefined({
    typeName: ZodFirstPartyTypeKind.ZodUndefined,
    ...processCreateParams(params)
  });
};
var ZodNull = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.null) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.null,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodNull.create = (params) => {
  return new ZodNull({
    typeName: ZodFirstPartyTypeKind.ZodNull,
    ...processCreateParams(params)
  });
};
var ZodAny = class extends ZodType {
  constructor() {
    super(...arguments);
    this._any = true;
  }
  _parse(input) {
    return OK(input.data);
  }
};
ZodAny.create = (params) => {
  return new ZodAny({
    typeName: ZodFirstPartyTypeKind.ZodAny,
    ...processCreateParams(params)
  });
};
var ZodUnknown = class extends ZodType {
  constructor() {
    super(...arguments);
    this._unknown = true;
  }
  _parse(input) {
    return OK(input.data);
  }
};
ZodUnknown.create = (params) => {
  return new ZodUnknown({
    typeName: ZodFirstPartyTypeKind.ZodUnknown,
    ...processCreateParams(params)
  });
};
var ZodNever = class extends ZodType {
  _parse(input) {
    const ctx = this._getOrReturnCtx(input);
    addIssueToContext(ctx, {
      code: ZodIssueCode.invalid_type,
      expected: ZodParsedType.never,
      received: ctx.parsedType
    });
    return INVALID;
  }
};
ZodNever.create = (params) => {
  return new ZodNever({
    typeName: ZodFirstPartyTypeKind.ZodNever,
    ...processCreateParams(params)
  });
};
var ZodVoid = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.undefined) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.void,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodVoid.create = (params) => {
  return new ZodVoid({
    typeName: ZodFirstPartyTypeKind.ZodVoid,
    ...processCreateParams(params)
  });
};
var ZodArray = class _ZodArray extends ZodType {
  _parse(input) {
    const { ctx, status: status2 } = this._processInputParams(input);
    const def = this._def;
    if (ctx.parsedType !== ZodParsedType.array) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.array,
        received: ctx.parsedType
      });
      return INVALID;
    }
    if (def.exactLength !== null) {
      const tooBig = ctx.data.length > def.exactLength.value;
      const tooSmall = ctx.data.length < def.exactLength.value;
      if (tooBig || tooSmall) {
        addIssueToContext(ctx, {
          code: tooBig ? ZodIssueCode.too_big : ZodIssueCode.too_small,
          minimum: tooSmall ? def.exactLength.value : void 0,
          maximum: tooBig ? def.exactLength.value : void 0,
          type: "array",
          inclusive: true,
          exact: true,
          message: def.exactLength.message
        });
        status2.dirty();
      }
    }
    if (def.minLength !== null) {
      if (ctx.data.length < def.minLength.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_small,
          minimum: def.minLength.value,
          type: "array",
          inclusive: true,
          exact: false,
          message: def.minLength.message
        });
        status2.dirty();
      }
    }
    if (def.maxLength !== null) {
      if (ctx.data.length > def.maxLength.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_big,
          maximum: def.maxLength.value,
          type: "array",
          inclusive: true,
          exact: false,
          message: def.maxLength.message
        });
        status2.dirty();
      }
    }
    if (ctx.common.async) {
      return Promise.all([...ctx.data].map((item, i) => {
        return def.type._parseAsync(new ParseInputLazyPath(ctx, item, ctx.path, i));
      })).then((result2) => {
        return ParseStatus.mergeArray(status2, result2);
      });
    }
    const result = [...ctx.data].map((item, i) => {
      return def.type._parseSync(new ParseInputLazyPath(ctx, item, ctx.path, i));
    });
    return ParseStatus.mergeArray(status2, result);
  }
  get element() {
    return this._def.type;
  }
  min(minLength, message) {
    return new _ZodArray({
      ...this._def,
      minLength: { value: minLength, message: errorUtil.toString(message) }
    });
  }
  max(maxLength, message) {
    return new _ZodArray({
      ...this._def,
      maxLength: { value: maxLength, message: errorUtil.toString(message) }
    });
  }
  length(len, message) {
    return new _ZodArray({
      ...this._def,
      exactLength: { value: len, message: errorUtil.toString(message) }
    });
  }
  nonempty(message) {
    return this.min(1, message);
  }
};
ZodArray.create = (schema, params) => {
  return new ZodArray({
    type: schema,
    minLength: null,
    maxLength: null,
    exactLength: null,
    typeName: ZodFirstPartyTypeKind.ZodArray,
    ...processCreateParams(params)
  });
};
function deepPartialify(schema) {
  if (schema instanceof ZodObject) {
    const newShape = {};
    for (const key in schema.shape) {
      const fieldSchema = schema.shape[key];
      newShape[key] = ZodOptional.create(deepPartialify(fieldSchema));
    }
    return new ZodObject({
      ...schema._def,
      shape: () => newShape
    });
  } else if (schema instanceof ZodArray) {
    return new ZodArray({
      ...schema._def,
      type: deepPartialify(schema.element)
    });
  } else if (schema instanceof ZodOptional) {
    return ZodOptional.create(deepPartialify(schema.unwrap()));
  } else if (schema instanceof ZodNullable) {
    return ZodNullable.create(deepPartialify(schema.unwrap()));
  } else if (schema instanceof ZodTuple) {
    return ZodTuple.create(schema.items.map((item) => deepPartialify(item)));
  } else {
    return schema;
  }
}
var ZodObject = class _ZodObject extends ZodType {
  constructor() {
    super(...arguments);
    this._cached = null;
    this.nonstrict = this.passthrough;
    this.augment = this.extend;
  }
  _getCached() {
    if (this._cached !== null)
      return this._cached;
    const shape = this._def.shape();
    const keys = util.objectKeys(shape);
    this._cached = { shape, keys };
    return this._cached;
  }
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.object) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    const { status: status2, ctx } = this._processInputParams(input);
    const { shape, keys: shapeKeys } = this._getCached();
    const extraKeys = [];
    if (!(this._def.catchall instanceof ZodNever && this._def.unknownKeys === "strip")) {
      for (const key in ctx.data) {
        if (!shapeKeys.includes(key)) {
          extraKeys.push(key);
        }
      }
    }
    const pairs = [];
    for (const key of shapeKeys) {
      const keyValidator = shape[key];
      const value = ctx.data[key];
      pairs.push({
        key: { status: "valid", value: key },
        value: keyValidator._parse(new ParseInputLazyPath(ctx, value, ctx.path, key)),
        alwaysSet: key in ctx.data
      });
    }
    if (this._def.catchall instanceof ZodNever) {
      const unknownKeys = this._def.unknownKeys;
      if (unknownKeys === "passthrough") {
        for (const key of extraKeys) {
          pairs.push({
            key: { status: "valid", value: key },
            value: { status: "valid", value: ctx.data[key] }
          });
        }
      } else if (unknownKeys === "strict") {
        if (extraKeys.length > 0) {
          addIssueToContext(ctx, {
            code: ZodIssueCode.unrecognized_keys,
            keys: extraKeys
          });
          status2.dirty();
        }
      } else if (unknownKeys === "strip") {
      } else {
        throw new Error(`Internal ZodObject error: invalid unknownKeys value.`);
      }
    } else {
      const catchall = this._def.catchall;
      for (const key of extraKeys) {
        const value = ctx.data[key];
        pairs.push({
          key: { status: "valid", value: key },
          value: catchall._parse(
            new ParseInputLazyPath(ctx, value, ctx.path, key)
            //, ctx.child(key), value, getParsedType(value)
          ),
          alwaysSet: key in ctx.data
        });
      }
    }
    if (ctx.common.async) {
      return Promise.resolve().then(async () => {
        const syncPairs = [];
        for (const pair of pairs) {
          const key = await pair.key;
          const value = await pair.value;
          syncPairs.push({
            key,
            value,
            alwaysSet: pair.alwaysSet
          });
        }
        return syncPairs;
      }).then((syncPairs) => {
        return ParseStatus.mergeObjectSync(status2, syncPairs);
      });
    } else {
      return ParseStatus.mergeObjectSync(status2, pairs);
    }
  }
  get shape() {
    return this._def.shape();
  }
  strict(message) {
    errorUtil.errToObj;
    return new _ZodObject({
      ...this._def,
      unknownKeys: "strict",
      ...message !== void 0 ? {
        errorMap: (issue, ctx) => {
          const defaultError = this._def.errorMap?.(issue, ctx).message ?? ctx.defaultError;
          if (issue.code === "unrecognized_keys")
            return {
              message: errorUtil.errToObj(message).message ?? defaultError
            };
          return {
            message: defaultError
          };
        }
      } : {}
    });
  }
  strip() {
    return new _ZodObject({
      ...this._def,
      unknownKeys: "strip"
    });
  }
  passthrough() {
    return new _ZodObject({
      ...this._def,
      unknownKeys: "passthrough"
    });
  }
  // const AugmentFactory =
  //   <Def extends ZodObjectDef>(def: Def) =>
  //   <Augmentation extends ZodRawShape>(
  //     augmentation: Augmentation
  //   ): ZodObject<
  //     extendShape<ReturnType<Def["shape"]>, Augmentation>,
  //     Def["unknownKeys"],
  //     Def["catchall"]
  //   > => {
  //     return new ZodObject({
  //       ...def,
  //       shape: () => ({
  //         ...def.shape(),
  //         ...augmentation,
  //       }),
  //     }) as any;
  //   };
  extend(augmentation) {
    return new _ZodObject({
      ...this._def,
      shape: () => ({
        ...this._def.shape(),
        ...augmentation
      })
    });
  }
  /**
   * Prior to zod@1.0.12 there was a bug in the
   * inferred type of merged objects. Please
   * upgrade if you are experiencing issues.
   */
  merge(merging) {
    const merged = new _ZodObject({
      unknownKeys: merging._def.unknownKeys,
      catchall: merging._def.catchall,
      shape: () => ({
        ...this._def.shape(),
        ...merging._def.shape()
      }),
      typeName: ZodFirstPartyTypeKind.ZodObject
    });
    return merged;
  }
  // merge<
  //   Incoming extends AnyZodObject,
  //   Augmentation extends Incoming["shape"],
  //   NewOutput extends {
  //     [k in keyof Augmentation | keyof Output]: k extends keyof Augmentation
  //       ? Augmentation[k]["_output"]
  //       : k extends keyof Output
  //       ? Output[k]
  //       : never;
  //   },
  //   NewInput extends {
  //     [k in keyof Augmentation | keyof Input]: k extends keyof Augmentation
  //       ? Augmentation[k]["_input"]
  //       : k extends keyof Input
  //       ? Input[k]
  //       : never;
  //   }
  // >(
  //   merging: Incoming
  // ): ZodObject<
  //   extendShape<T, ReturnType<Incoming["_def"]["shape"]>>,
  //   Incoming["_def"]["unknownKeys"],
  //   Incoming["_def"]["catchall"],
  //   NewOutput,
  //   NewInput
  // > {
  //   const merged: any = new ZodObject({
  //     unknownKeys: merging._def.unknownKeys,
  //     catchall: merging._def.catchall,
  //     shape: () =>
  //       objectUtil.mergeShapes(this._def.shape(), merging._def.shape()),
  //     typeName: ZodFirstPartyTypeKind.ZodObject,
  //   }) as any;
  //   return merged;
  // }
  setKey(key, schema) {
    return this.augment({ [key]: schema });
  }
  // merge<Incoming extends AnyZodObject>(
  //   merging: Incoming
  // ): //ZodObject<T & Incoming["_shape"], UnknownKeys, Catchall> = (merging) => {
  // ZodObject<
  //   extendShape<T, ReturnType<Incoming["_def"]["shape"]>>,
  //   Incoming["_def"]["unknownKeys"],
  //   Incoming["_def"]["catchall"]
  // > {
  //   // const mergedShape = objectUtil.mergeShapes(
  //   //   this._def.shape(),
  //   //   merging._def.shape()
  //   // );
  //   const merged: any = new ZodObject({
  //     unknownKeys: merging._def.unknownKeys,
  //     catchall: merging._def.catchall,
  //     shape: () =>
  //       objectUtil.mergeShapes(this._def.shape(), merging._def.shape()),
  //     typeName: ZodFirstPartyTypeKind.ZodObject,
  //   }) as any;
  //   return merged;
  // }
  catchall(index) {
    return new _ZodObject({
      ...this._def,
      catchall: index
    });
  }
  pick(mask) {
    const shape = {};
    for (const key of util.objectKeys(mask)) {
      if (mask[key] && this.shape[key]) {
        shape[key] = this.shape[key];
      }
    }
    return new _ZodObject({
      ...this._def,
      shape: () => shape
    });
  }
  omit(mask) {
    const shape = {};
    for (const key of util.objectKeys(this.shape)) {
      if (!mask[key]) {
        shape[key] = this.shape[key];
      }
    }
    return new _ZodObject({
      ...this._def,
      shape: () => shape
    });
  }
  /**
   * @deprecated
   */
  deepPartial() {
    return deepPartialify(this);
  }
  partial(mask) {
    const newShape = {};
    for (const key of util.objectKeys(this.shape)) {
      const fieldSchema = this.shape[key];
      if (mask && !mask[key]) {
        newShape[key] = fieldSchema;
      } else {
        newShape[key] = fieldSchema.optional();
      }
    }
    return new _ZodObject({
      ...this._def,
      shape: () => newShape
    });
  }
  required(mask) {
    const newShape = {};
    for (const key of util.objectKeys(this.shape)) {
      if (mask && !mask[key]) {
        newShape[key] = this.shape[key];
      } else {
        const fieldSchema = this.shape[key];
        let newField = fieldSchema;
        while (newField instanceof ZodOptional) {
          newField = newField._def.innerType;
        }
        newShape[key] = newField;
      }
    }
    return new _ZodObject({
      ...this._def,
      shape: () => newShape
    });
  }
  keyof() {
    return createZodEnum(util.objectKeys(this.shape));
  }
};
ZodObject.create = (shape, params) => {
  return new ZodObject({
    shape: () => shape,
    unknownKeys: "strip",
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params)
  });
};
ZodObject.strictCreate = (shape, params) => {
  return new ZodObject({
    shape: () => shape,
    unknownKeys: "strict",
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params)
  });
};
ZodObject.lazycreate = (shape, params) => {
  return new ZodObject({
    shape,
    unknownKeys: "strip",
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params)
  });
};
var ZodUnion = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const options = this._def.options;
    function handleResults(results) {
      for (const result of results) {
        if (result.result.status === "valid") {
          return result.result;
        }
      }
      for (const result of results) {
        if (result.result.status === "dirty") {
          ctx.common.issues.push(...result.ctx.common.issues);
          return result.result;
        }
      }
      const unionErrors = results.map((result) => new ZodError(result.ctx.common.issues));
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_union,
        unionErrors
      });
      return INVALID;
    }
    if (ctx.common.async) {
      return Promise.all(options.map(async (option2) => {
        const childCtx = {
          ...ctx,
          common: {
            ...ctx.common,
            issues: []
          },
          parent: null
        };
        return {
          result: await option2._parseAsync({
            data: ctx.data,
            path: ctx.path,
            parent: childCtx
          }),
          ctx: childCtx
        };
      })).then(handleResults);
    } else {
      let dirty = void 0;
      const issues = [];
      for (const option2 of options) {
        const childCtx = {
          ...ctx,
          common: {
            ...ctx.common,
            issues: []
          },
          parent: null
        };
        const result = option2._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: childCtx
        });
        if (result.status === "valid") {
          return result;
        } else if (result.status === "dirty" && !dirty) {
          dirty = { result, ctx: childCtx };
        }
        if (childCtx.common.issues.length) {
          issues.push(childCtx.common.issues);
        }
      }
      if (dirty) {
        ctx.common.issues.push(...dirty.ctx.common.issues);
        return dirty.result;
      }
      const unionErrors = issues.map((issues2) => new ZodError(issues2));
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_union,
        unionErrors
      });
      return INVALID;
    }
  }
  get options() {
    return this._def.options;
  }
};
ZodUnion.create = (types, params) => {
  return new ZodUnion({
    options: types,
    typeName: ZodFirstPartyTypeKind.ZodUnion,
    ...processCreateParams(params)
  });
};
var getDiscriminator = (type) => {
  if (type instanceof ZodLazy) {
    return getDiscriminator(type.schema);
  } else if (type instanceof ZodEffects) {
    return getDiscriminator(type.innerType());
  } else if (type instanceof ZodLiteral) {
    return [type.value];
  } else if (type instanceof ZodEnum) {
    return type.options;
  } else if (type instanceof ZodNativeEnum) {
    return util.objectValues(type.enum);
  } else if (type instanceof ZodDefault) {
    return getDiscriminator(type._def.innerType);
  } else if (type instanceof ZodUndefined) {
    return [void 0];
  } else if (type instanceof ZodNull) {
    return [null];
  } else if (type instanceof ZodOptional) {
    return [void 0, ...getDiscriminator(type.unwrap())];
  } else if (type instanceof ZodNullable) {
    return [null, ...getDiscriminator(type.unwrap())];
  } else if (type instanceof ZodBranded) {
    return getDiscriminator(type.unwrap());
  } else if (type instanceof ZodReadonly) {
    return getDiscriminator(type.unwrap());
  } else if (type instanceof ZodCatch) {
    return getDiscriminator(type._def.innerType);
  } else {
    return [];
  }
};
var ZodDiscriminatedUnion = class _ZodDiscriminatedUnion extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.object) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const discriminator = this.discriminator;
    const discriminatorValue = ctx.data[discriminator];
    const option2 = this.optionsMap.get(discriminatorValue);
    if (!option2) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_union_discriminator,
        options: Array.from(this.optionsMap.keys()),
        path: [discriminator]
      });
      return INVALID;
    }
    if (ctx.common.async) {
      return option2._parseAsync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      });
    } else {
      return option2._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      });
    }
  }
  get discriminator() {
    return this._def.discriminator;
  }
  get options() {
    return this._def.options;
  }
  get optionsMap() {
    return this._def.optionsMap;
  }
  /**
   * The constructor of the discriminated union schema. Its behaviour is very similar to that of the normal z.union() constructor.
   * However, it only allows a union of objects, all of which need to share a discriminator property. This property must
   * have a different value for each object in the union.
   * @param discriminator the name of the discriminator property
   * @param types an array of object schemas
   * @param params
   */
  static create(discriminator, options, params) {
    const optionsMap = /* @__PURE__ */ new Map();
    for (const type of options) {
      const discriminatorValues = getDiscriminator(type.shape[discriminator]);
      if (!discriminatorValues.length) {
        throw new Error(`A discriminator value for key \`${discriminator}\` could not be extracted from all schema options`);
      }
      for (const value of discriminatorValues) {
        if (optionsMap.has(value)) {
          throw new Error(`Discriminator property ${String(discriminator)} has duplicate value ${String(value)}`);
        }
        optionsMap.set(value, type);
      }
    }
    return new _ZodDiscriminatedUnion({
      typeName: ZodFirstPartyTypeKind.ZodDiscriminatedUnion,
      discriminator,
      options,
      optionsMap,
      ...processCreateParams(params)
    });
  }
};
function mergeValues(a, b) {
  const aType = getParsedType(a);
  const bType = getParsedType(b);
  if (a === b) {
    return { valid: true, data: a };
  } else if (aType === ZodParsedType.object && bType === ZodParsedType.object) {
    const bKeys = util.objectKeys(b);
    const sharedKeys = util.objectKeys(a).filter((key) => bKeys.indexOf(key) !== -1);
    const newObj = { ...a, ...b };
    for (const key of sharedKeys) {
      const sharedValue = mergeValues(a[key], b[key]);
      if (!sharedValue.valid) {
        return { valid: false };
      }
      newObj[key] = sharedValue.data;
    }
    return { valid: true, data: newObj };
  } else if (aType === ZodParsedType.array && bType === ZodParsedType.array) {
    if (a.length !== b.length) {
      return { valid: false };
    }
    const newArray = [];
    for (let index = 0; index < a.length; index++) {
      const itemA = a[index];
      const itemB = b[index];
      const sharedValue = mergeValues(itemA, itemB);
      if (!sharedValue.valid) {
        return { valid: false };
      }
      newArray.push(sharedValue.data);
    }
    return { valid: true, data: newArray };
  } else if (aType === ZodParsedType.date && bType === ZodParsedType.date && +a === +b) {
    return { valid: true, data: a };
  } else {
    return { valid: false };
  }
}
var ZodIntersection = class extends ZodType {
  _parse(input) {
    const { status: status2, ctx } = this._processInputParams(input);
    const handleParsed = (parsedLeft, parsedRight) => {
      if (isAborted(parsedLeft) || isAborted(parsedRight)) {
        return INVALID;
      }
      const merged = mergeValues(parsedLeft.value, parsedRight.value);
      if (!merged.valid) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.invalid_intersection_types
        });
        return INVALID;
      }
      if (isDirty(parsedLeft) || isDirty(parsedRight)) {
        status2.dirty();
      }
      return { status: status2.value, value: merged.data };
    };
    if (ctx.common.async) {
      return Promise.all([
        this._def.left._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        }),
        this._def.right._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        })
      ]).then(([left, right]) => handleParsed(left, right));
    } else {
      return handleParsed(this._def.left._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      }), this._def.right._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      }));
    }
  }
};
ZodIntersection.create = (left, right, params) => {
  return new ZodIntersection({
    left,
    right,
    typeName: ZodFirstPartyTypeKind.ZodIntersection,
    ...processCreateParams(params)
  });
};
var ZodTuple = class _ZodTuple extends ZodType {
  _parse(input) {
    const { status: status2, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.array) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.array,
        received: ctx.parsedType
      });
      return INVALID;
    }
    if (ctx.data.length < this._def.items.length) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.too_small,
        minimum: this._def.items.length,
        inclusive: true,
        exact: false,
        type: "array"
      });
      return INVALID;
    }
    const rest = this._def.rest;
    if (!rest && ctx.data.length > this._def.items.length) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.too_big,
        maximum: this._def.items.length,
        inclusive: true,
        exact: false,
        type: "array"
      });
      status2.dirty();
    }
    const items = [...ctx.data].map((item, itemIndex) => {
      const schema = this._def.items[itemIndex] || this._def.rest;
      if (!schema)
        return null;
      return schema._parse(new ParseInputLazyPath(ctx, item, ctx.path, itemIndex));
    }).filter((x) => !!x);
    if (ctx.common.async) {
      return Promise.all(items).then((results) => {
        return ParseStatus.mergeArray(status2, results);
      });
    } else {
      return ParseStatus.mergeArray(status2, items);
    }
  }
  get items() {
    return this._def.items;
  }
  rest(rest) {
    return new _ZodTuple({
      ...this._def,
      rest
    });
  }
};
ZodTuple.create = (schemas, params) => {
  if (!Array.isArray(schemas)) {
    throw new Error("You must pass an array of schemas to z.tuple([ ... ])");
  }
  return new ZodTuple({
    items: schemas,
    typeName: ZodFirstPartyTypeKind.ZodTuple,
    rest: null,
    ...processCreateParams(params)
  });
};
var ZodRecord = class _ZodRecord extends ZodType {
  get keySchema() {
    return this._def.keyType;
  }
  get valueSchema() {
    return this._def.valueType;
  }
  _parse(input) {
    const { status: status2, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.object) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const pairs = [];
    const keyType = this._def.keyType;
    const valueType = this._def.valueType;
    for (const key in ctx.data) {
      pairs.push({
        key: keyType._parse(new ParseInputLazyPath(ctx, key, ctx.path, key)),
        value: valueType._parse(new ParseInputLazyPath(ctx, ctx.data[key], ctx.path, key)),
        alwaysSet: key in ctx.data
      });
    }
    if (ctx.common.async) {
      return ParseStatus.mergeObjectAsync(status2, pairs);
    } else {
      return ParseStatus.mergeObjectSync(status2, pairs);
    }
  }
  get element() {
    return this._def.valueType;
  }
  static create(first, second, third) {
    if (second instanceof ZodType) {
      return new _ZodRecord({
        keyType: first,
        valueType: second,
        typeName: ZodFirstPartyTypeKind.ZodRecord,
        ...processCreateParams(third)
      });
    }
    return new _ZodRecord({
      keyType: ZodString.create(),
      valueType: first,
      typeName: ZodFirstPartyTypeKind.ZodRecord,
      ...processCreateParams(second)
    });
  }
};
var ZodMap = class extends ZodType {
  get keySchema() {
    return this._def.keyType;
  }
  get valueSchema() {
    return this._def.valueType;
  }
  _parse(input) {
    const { status: status2, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.map) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.map,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const keyType = this._def.keyType;
    const valueType = this._def.valueType;
    const pairs = [...ctx.data.entries()].map(([key, value], index) => {
      return {
        key: keyType._parse(new ParseInputLazyPath(ctx, key, ctx.path, [index, "key"])),
        value: valueType._parse(new ParseInputLazyPath(ctx, value, ctx.path, [index, "value"]))
      };
    });
    if (ctx.common.async) {
      const finalMap = /* @__PURE__ */ new Map();
      return Promise.resolve().then(async () => {
        for (const pair of pairs) {
          const key = await pair.key;
          const value = await pair.value;
          if (key.status === "aborted" || value.status === "aborted") {
            return INVALID;
          }
          if (key.status === "dirty" || value.status === "dirty") {
            status2.dirty();
          }
          finalMap.set(key.value, value.value);
        }
        return { status: status2.value, value: finalMap };
      });
    } else {
      const finalMap = /* @__PURE__ */ new Map();
      for (const pair of pairs) {
        const key = pair.key;
        const value = pair.value;
        if (key.status === "aborted" || value.status === "aborted") {
          return INVALID;
        }
        if (key.status === "dirty" || value.status === "dirty") {
          status2.dirty();
        }
        finalMap.set(key.value, value.value);
      }
      return { status: status2.value, value: finalMap };
    }
  }
};
ZodMap.create = (keyType, valueType, params) => {
  return new ZodMap({
    valueType,
    keyType,
    typeName: ZodFirstPartyTypeKind.ZodMap,
    ...processCreateParams(params)
  });
};
var ZodSet = class _ZodSet extends ZodType {
  _parse(input) {
    const { status: status2, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.set) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.set,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const def = this._def;
    if (def.minSize !== null) {
      if (ctx.data.size < def.minSize.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_small,
          minimum: def.minSize.value,
          type: "set",
          inclusive: true,
          exact: false,
          message: def.minSize.message
        });
        status2.dirty();
      }
    }
    if (def.maxSize !== null) {
      if (ctx.data.size > def.maxSize.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_big,
          maximum: def.maxSize.value,
          type: "set",
          inclusive: true,
          exact: false,
          message: def.maxSize.message
        });
        status2.dirty();
      }
    }
    const valueType = this._def.valueType;
    function finalizeSet(elements2) {
      const parsedSet = /* @__PURE__ */ new Set();
      for (const element of elements2) {
        if (element.status === "aborted")
          return INVALID;
        if (element.status === "dirty")
          status2.dirty();
        parsedSet.add(element.value);
      }
      return { status: status2.value, value: parsedSet };
    }
    const elements = [...ctx.data.values()].map((item, i) => valueType._parse(new ParseInputLazyPath(ctx, item, ctx.path, i)));
    if (ctx.common.async) {
      return Promise.all(elements).then((elements2) => finalizeSet(elements2));
    } else {
      return finalizeSet(elements);
    }
  }
  min(minSize, message) {
    return new _ZodSet({
      ...this._def,
      minSize: { value: minSize, message: errorUtil.toString(message) }
    });
  }
  max(maxSize, message) {
    return new _ZodSet({
      ...this._def,
      maxSize: { value: maxSize, message: errorUtil.toString(message) }
    });
  }
  size(size, message) {
    return this.min(size, message).max(size, message);
  }
  nonempty(message) {
    return this.min(1, message);
  }
};
ZodSet.create = (valueType, params) => {
  return new ZodSet({
    valueType,
    minSize: null,
    maxSize: null,
    typeName: ZodFirstPartyTypeKind.ZodSet,
    ...processCreateParams(params)
  });
};
var ZodFunction = class _ZodFunction extends ZodType {
  constructor() {
    super(...arguments);
    this.validate = this.implement;
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.function) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.function,
        received: ctx.parsedType
      });
      return INVALID;
    }
    function makeArgsIssue(args, error) {
      return makeIssue({
        data: args,
        path: ctx.path,
        errorMaps: [ctx.common.contextualErrorMap, ctx.schemaErrorMap, getErrorMap(), en_default].filter((x) => !!x),
        issueData: {
          code: ZodIssueCode.invalid_arguments,
          argumentsError: error
        }
      });
    }
    function makeReturnsIssue(returns, error) {
      return makeIssue({
        data: returns,
        path: ctx.path,
        errorMaps: [ctx.common.contextualErrorMap, ctx.schemaErrorMap, getErrorMap(), en_default].filter((x) => !!x),
        issueData: {
          code: ZodIssueCode.invalid_return_type,
          returnTypeError: error
        }
      });
    }
    const params = { errorMap: ctx.common.contextualErrorMap };
    const fn = ctx.data;
    if (this._def.returns instanceof ZodPromise) {
      const me = this;
      return OK(async function(...args) {
        const error = new ZodError([]);
        const parsedArgs = await me._def.args.parseAsync(args, params).catch((e) => {
          error.addIssue(makeArgsIssue(args, e));
          throw error;
        });
        const result = await Reflect.apply(fn, this, parsedArgs);
        const parsedReturns = await me._def.returns._def.type.parseAsync(result, params).catch((e) => {
          error.addIssue(makeReturnsIssue(result, e));
          throw error;
        });
        return parsedReturns;
      });
    } else {
      const me = this;
      return OK(function(...args) {
        const parsedArgs = me._def.args.safeParse(args, params);
        if (!parsedArgs.success) {
          throw new ZodError([makeArgsIssue(args, parsedArgs.error)]);
        }
        const result = Reflect.apply(fn, this, parsedArgs.data);
        const parsedReturns = me._def.returns.safeParse(result, params);
        if (!parsedReturns.success) {
          throw new ZodError([makeReturnsIssue(result, parsedReturns.error)]);
        }
        return parsedReturns.data;
      });
    }
  }
  parameters() {
    return this._def.args;
  }
  returnType() {
    return this._def.returns;
  }
  args(...items) {
    return new _ZodFunction({
      ...this._def,
      args: ZodTuple.create(items).rest(ZodUnknown.create())
    });
  }
  returns(returnType) {
    return new _ZodFunction({
      ...this._def,
      returns: returnType
    });
  }
  implement(func) {
    const validatedFunc = this.parse(func);
    return validatedFunc;
  }
  strictImplement(func) {
    const validatedFunc = this.parse(func);
    return validatedFunc;
  }
  static create(args, returns, params) {
    return new _ZodFunction({
      args: args ? args : ZodTuple.create([]).rest(ZodUnknown.create()),
      returns: returns || ZodUnknown.create(),
      typeName: ZodFirstPartyTypeKind.ZodFunction,
      ...processCreateParams(params)
    });
  }
};
var ZodLazy = class extends ZodType {
  get schema() {
    return this._def.getter();
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const lazySchema = this._def.getter();
    return lazySchema._parse({ data: ctx.data, path: ctx.path, parent: ctx });
  }
};
ZodLazy.create = (getter, params) => {
  return new ZodLazy({
    getter,
    typeName: ZodFirstPartyTypeKind.ZodLazy,
    ...processCreateParams(params)
  });
};
var ZodLiteral = class extends ZodType {
  _parse(input) {
    if (input.data !== this._def.value) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_literal,
        expected: this._def.value
      });
      return INVALID;
    }
    return { status: "valid", value: input.data };
  }
  get value() {
    return this._def.value;
  }
};
ZodLiteral.create = (value, params) => {
  return new ZodLiteral({
    value,
    typeName: ZodFirstPartyTypeKind.ZodLiteral,
    ...processCreateParams(params)
  });
};
function createZodEnum(values, params) {
  return new ZodEnum({
    values,
    typeName: ZodFirstPartyTypeKind.ZodEnum,
    ...processCreateParams(params)
  });
}
var ZodEnum = class _ZodEnum extends ZodType {
  _parse(input) {
    if (typeof input.data !== "string") {
      const ctx = this._getOrReturnCtx(input);
      const expectedValues = this._def.values;
      addIssueToContext(ctx, {
        expected: util.joinValues(expectedValues),
        received: ctx.parsedType,
        code: ZodIssueCode.invalid_type
      });
      return INVALID;
    }
    if (!this._cache) {
      this._cache = new Set(this._def.values);
    }
    if (!this._cache.has(input.data)) {
      const ctx = this._getOrReturnCtx(input);
      const expectedValues = this._def.values;
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_enum_value,
        options: expectedValues
      });
      return INVALID;
    }
    return OK(input.data);
  }
  get options() {
    return this._def.values;
  }
  get enum() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  get Values() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  get Enum() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  extract(values, newDef = this._def) {
    return _ZodEnum.create(values, {
      ...this._def,
      ...newDef
    });
  }
  exclude(values, newDef = this._def) {
    return _ZodEnum.create(this.options.filter((opt) => !values.includes(opt)), {
      ...this._def,
      ...newDef
    });
  }
};
ZodEnum.create = createZodEnum;
var ZodNativeEnum = class extends ZodType {
  _parse(input) {
    const nativeEnumValues = util.getValidEnumValues(this._def.values);
    const ctx = this._getOrReturnCtx(input);
    if (ctx.parsedType !== ZodParsedType.string && ctx.parsedType !== ZodParsedType.number) {
      const expectedValues = util.objectValues(nativeEnumValues);
      addIssueToContext(ctx, {
        expected: util.joinValues(expectedValues),
        received: ctx.parsedType,
        code: ZodIssueCode.invalid_type
      });
      return INVALID;
    }
    if (!this._cache) {
      this._cache = new Set(util.getValidEnumValues(this._def.values));
    }
    if (!this._cache.has(input.data)) {
      const expectedValues = util.objectValues(nativeEnumValues);
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_enum_value,
        options: expectedValues
      });
      return INVALID;
    }
    return OK(input.data);
  }
  get enum() {
    return this._def.values;
  }
};
ZodNativeEnum.create = (values, params) => {
  return new ZodNativeEnum({
    values,
    typeName: ZodFirstPartyTypeKind.ZodNativeEnum,
    ...processCreateParams(params)
  });
};
var ZodPromise = class extends ZodType {
  unwrap() {
    return this._def.type;
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.promise && ctx.common.async === false) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.promise,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const promisified = ctx.parsedType === ZodParsedType.promise ? ctx.data : Promise.resolve(ctx.data);
    return OK(promisified.then((data) => {
      return this._def.type.parseAsync(data, {
        path: ctx.path,
        errorMap: ctx.common.contextualErrorMap
      });
    }));
  }
};
ZodPromise.create = (schema, params) => {
  return new ZodPromise({
    type: schema,
    typeName: ZodFirstPartyTypeKind.ZodPromise,
    ...processCreateParams(params)
  });
};
var ZodEffects = class extends ZodType {
  innerType() {
    return this._def.schema;
  }
  sourceType() {
    return this._def.schema._def.typeName === ZodFirstPartyTypeKind.ZodEffects ? this._def.schema.sourceType() : this._def.schema;
  }
  _parse(input) {
    const { status: status2, ctx } = this._processInputParams(input);
    const effect = this._def.effect || null;
    const checkCtx = {
      addIssue: (arg) => {
        addIssueToContext(ctx, arg);
        if (arg.fatal) {
          status2.abort();
        } else {
          status2.dirty();
        }
      },
      get path() {
        return ctx.path;
      }
    };
    checkCtx.addIssue = checkCtx.addIssue.bind(checkCtx);
    if (effect.type === "preprocess") {
      const processed = effect.transform(ctx.data, checkCtx);
      if (ctx.common.async) {
        return Promise.resolve(processed).then(async (processed2) => {
          if (status2.value === "aborted")
            return INVALID;
          const result = await this._def.schema._parseAsync({
            data: processed2,
            path: ctx.path,
            parent: ctx
          });
          if (result.status === "aborted")
            return INVALID;
          if (result.status === "dirty")
            return DIRTY(result.value);
          if (status2.value === "dirty")
            return DIRTY(result.value);
          return result;
        });
      } else {
        if (status2.value === "aborted")
          return INVALID;
        const result = this._def.schema._parseSync({
          data: processed,
          path: ctx.path,
          parent: ctx
        });
        if (result.status === "aborted")
          return INVALID;
        if (result.status === "dirty")
          return DIRTY(result.value);
        if (status2.value === "dirty")
          return DIRTY(result.value);
        return result;
      }
    }
    if (effect.type === "refinement") {
      const executeRefinement = (acc) => {
        const result = effect.refinement(acc, checkCtx);
        if (ctx.common.async) {
          return Promise.resolve(result);
        }
        if (result instanceof Promise) {
          throw new Error("Async refinement encountered during synchronous parse operation. Use .parseAsync instead.");
        }
        return acc;
      };
      if (ctx.common.async === false) {
        const inner = this._def.schema._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (inner.status === "aborted")
          return INVALID;
        if (inner.status === "dirty")
          status2.dirty();
        executeRefinement(inner.value);
        return { status: status2.value, value: inner.value };
      } else {
        return this._def.schema._parseAsync({ data: ctx.data, path: ctx.path, parent: ctx }).then((inner) => {
          if (inner.status === "aborted")
            return INVALID;
          if (inner.status === "dirty")
            status2.dirty();
          return executeRefinement(inner.value).then(() => {
            return { status: status2.value, value: inner.value };
          });
        });
      }
    }
    if (effect.type === "transform") {
      if (ctx.common.async === false) {
        const base = this._def.schema._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (!isValid(base))
          return INVALID;
        const result = effect.transform(base.value, checkCtx);
        if (result instanceof Promise) {
          throw new Error(`Asynchronous transform encountered during synchronous parse operation. Use .parseAsync instead.`);
        }
        return { status: status2.value, value: result };
      } else {
        return this._def.schema._parseAsync({ data: ctx.data, path: ctx.path, parent: ctx }).then((base) => {
          if (!isValid(base))
            return INVALID;
          return Promise.resolve(effect.transform(base.value, checkCtx)).then((result) => ({
            status: status2.value,
            value: result
          }));
        });
      }
    }
    util.assertNever(effect);
  }
};
ZodEffects.create = (schema, effect, params) => {
  return new ZodEffects({
    schema,
    typeName: ZodFirstPartyTypeKind.ZodEffects,
    effect,
    ...processCreateParams(params)
  });
};
ZodEffects.createWithPreprocess = (preprocess, schema, params) => {
  return new ZodEffects({
    schema,
    effect: { type: "preprocess", transform: preprocess },
    typeName: ZodFirstPartyTypeKind.ZodEffects,
    ...processCreateParams(params)
  });
};
var ZodOptional = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType === ZodParsedType.undefined) {
      return OK(void 0);
    }
    return this._def.innerType._parse(input);
  }
  unwrap() {
    return this._def.innerType;
  }
};
ZodOptional.create = (type, params) => {
  return new ZodOptional({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodOptional,
    ...processCreateParams(params)
  });
};
var ZodNullable = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType === ZodParsedType.null) {
      return OK(null);
    }
    return this._def.innerType._parse(input);
  }
  unwrap() {
    return this._def.innerType;
  }
};
ZodNullable.create = (type, params) => {
  return new ZodNullable({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodNullable,
    ...processCreateParams(params)
  });
};
var ZodDefault = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    let data = ctx.data;
    if (ctx.parsedType === ZodParsedType.undefined) {
      data = this._def.defaultValue();
    }
    return this._def.innerType._parse({
      data,
      path: ctx.path,
      parent: ctx
    });
  }
  removeDefault() {
    return this._def.innerType;
  }
};
ZodDefault.create = (type, params) => {
  return new ZodDefault({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodDefault,
    defaultValue: typeof params.default === "function" ? params.default : () => params.default,
    ...processCreateParams(params)
  });
};
var ZodCatch = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const newCtx = {
      ...ctx,
      common: {
        ...ctx.common,
        issues: []
      }
    };
    const result = this._def.innerType._parse({
      data: newCtx.data,
      path: newCtx.path,
      parent: {
        ...newCtx
      }
    });
    if (isAsync(result)) {
      return result.then((result2) => {
        return {
          status: "valid",
          value: result2.status === "valid" ? result2.value : this._def.catchValue({
            get error() {
              return new ZodError(newCtx.common.issues);
            },
            input: newCtx.data
          })
        };
      });
    } else {
      return {
        status: "valid",
        value: result.status === "valid" ? result.value : this._def.catchValue({
          get error() {
            return new ZodError(newCtx.common.issues);
          },
          input: newCtx.data
        })
      };
    }
  }
  removeCatch() {
    return this._def.innerType;
  }
};
ZodCatch.create = (type, params) => {
  return new ZodCatch({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodCatch,
    catchValue: typeof params.catch === "function" ? params.catch : () => params.catch,
    ...processCreateParams(params)
  });
};
var ZodNaN = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.nan) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.nan,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return { status: "valid", value: input.data };
  }
};
ZodNaN.create = (params) => {
  return new ZodNaN({
    typeName: ZodFirstPartyTypeKind.ZodNaN,
    ...processCreateParams(params)
  });
};
var BRAND = Symbol("zod_brand");
var ZodBranded = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const data = ctx.data;
    return this._def.type._parse({
      data,
      path: ctx.path,
      parent: ctx
    });
  }
  unwrap() {
    return this._def.type;
  }
};
var ZodPipeline = class _ZodPipeline extends ZodType {
  _parse(input) {
    const { status: status2, ctx } = this._processInputParams(input);
    if (ctx.common.async) {
      const handleAsync = async () => {
        const inResult = await this._def.in._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (inResult.status === "aborted")
          return INVALID;
        if (inResult.status === "dirty") {
          status2.dirty();
          return DIRTY(inResult.value);
        } else {
          return this._def.out._parseAsync({
            data: inResult.value,
            path: ctx.path,
            parent: ctx
          });
        }
      };
      return handleAsync();
    } else {
      const inResult = this._def.in._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      });
      if (inResult.status === "aborted")
        return INVALID;
      if (inResult.status === "dirty") {
        status2.dirty();
        return {
          status: "dirty",
          value: inResult.value
        };
      } else {
        return this._def.out._parseSync({
          data: inResult.value,
          path: ctx.path,
          parent: ctx
        });
      }
    }
  }
  static create(a, b) {
    return new _ZodPipeline({
      in: a,
      out: b,
      typeName: ZodFirstPartyTypeKind.ZodPipeline
    });
  }
};
var ZodReadonly = class extends ZodType {
  _parse(input) {
    const result = this._def.innerType._parse(input);
    const freeze = (data) => {
      if (isValid(data)) {
        data.value = Object.freeze(data.value);
      }
      return data;
    };
    return isAsync(result) ? result.then((data) => freeze(data)) : freeze(result);
  }
  unwrap() {
    return this._def.innerType;
  }
};
ZodReadonly.create = (type, params) => {
  return new ZodReadonly({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodReadonly,
    ...processCreateParams(params)
  });
};
function cleanParams(params, data) {
  const p = typeof params === "function" ? params(data) : typeof params === "string" ? { message: params } : params;
  const p2 = typeof p === "string" ? { message: p } : p;
  return p2;
}
function custom(check, _params = {}, fatal) {
  if (check)
    return ZodAny.create().superRefine((data, ctx) => {
      const r = check(data);
      if (r instanceof Promise) {
        return r.then((r2) => {
          if (!r2) {
            const params = cleanParams(_params, data);
            const _fatal = params.fatal ?? fatal ?? true;
            ctx.addIssue({ code: "custom", ...params, fatal: _fatal });
          }
        });
      }
      if (!r) {
        const params = cleanParams(_params, data);
        const _fatal = params.fatal ?? fatal ?? true;
        ctx.addIssue({ code: "custom", ...params, fatal: _fatal });
      }
      return;
    });
  return ZodAny.create();
}
var late = {
  object: ZodObject.lazycreate
};
var ZodFirstPartyTypeKind;
(function(ZodFirstPartyTypeKind2) {
  ZodFirstPartyTypeKind2["ZodString"] = "ZodString";
  ZodFirstPartyTypeKind2["ZodNumber"] = "ZodNumber";
  ZodFirstPartyTypeKind2["ZodNaN"] = "ZodNaN";
  ZodFirstPartyTypeKind2["ZodBigInt"] = "ZodBigInt";
  ZodFirstPartyTypeKind2["ZodBoolean"] = "ZodBoolean";
  ZodFirstPartyTypeKind2["ZodDate"] = "ZodDate";
  ZodFirstPartyTypeKind2["ZodSymbol"] = "ZodSymbol";
  ZodFirstPartyTypeKind2["ZodUndefined"] = "ZodUndefined";
  ZodFirstPartyTypeKind2["ZodNull"] = "ZodNull";
  ZodFirstPartyTypeKind2["ZodAny"] = "ZodAny";
  ZodFirstPartyTypeKind2["ZodUnknown"] = "ZodUnknown";
  ZodFirstPartyTypeKind2["ZodNever"] = "ZodNever";
  ZodFirstPartyTypeKind2["ZodVoid"] = "ZodVoid";
  ZodFirstPartyTypeKind2["ZodArray"] = "ZodArray";
  ZodFirstPartyTypeKind2["ZodObject"] = "ZodObject";
  ZodFirstPartyTypeKind2["ZodUnion"] = "ZodUnion";
  ZodFirstPartyTypeKind2["ZodDiscriminatedUnion"] = "ZodDiscriminatedUnion";
  ZodFirstPartyTypeKind2["ZodIntersection"] = "ZodIntersection";
  ZodFirstPartyTypeKind2["ZodTuple"] = "ZodTuple";
  ZodFirstPartyTypeKind2["ZodRecord"] = "ZodRecord";
  ZodFirstPartyTypeKind2["ZodMap"] = "ZodMap";
  ZodFirstPartyTypeKind2["ZodSet"] = "ZodSet";
  ZodFirstPartyTypeKind2["ZodFunction"] = "ZodFunction";
  ZodFirstPartyTypeKind2["ZodLazy"] = "ZodLazy";
  ZodFirstPartyTypeKind2["ZodLiteral"] = "ZodLiteral";
  ZodFirstPartyTypeKind2["ZodEnum"] = "ZodEnum";
  ZodFirstPartyTypeKind2["ZodEffects"] = "ZodEffects";
  ZodFirstPartyTypeKind2["ZodNativeEnum"] = "ZodNativeEnum";
  ZodFirstPartyTypeKind2["ZodOptional"] = "ZodOptional";
  ZodFirstPartyTypeKind2["ZodNullable"] = "ZodNullable";
  ZodFirstPartyTypeKind2["ZodDefault"] = "ZodDefault";
  ZodFirstPartyTypeKind2["ZodCatch"] = "ZodCatch";
  ZodFirstPartyTypeKind2["ZodPromise"] = "ZodPromise";
  ZodFirstPartyTypeKind2["ZodBranded"] = "ZodBranded";
  ZodFirstPartyTypeKind2["ZodPipeline"] = "ZodPipeline";
  ZodFirstPartyTypeKind2["ZodReadonly"] = "ZodReadonly";
})(ZodFirstPartyTypeKind || (ZodFirstPartyTypeKind = {}));
var instanceOfType = (cls, params = {
  message: `Input not instance of ${cls.name}`
}) => custom((data) => data instanceof cls, params);
var stringType = ZodString.create;
var numberType = ZodNumber.create;
var nanType = ZodNaN.create;
var bigIntType = ZodBigInt.create;
var booleanType = ZodBoolean.create;
var dateType = ZodDate.create;
var symbolType = ZodSymbol.create;
var undefinedType = ZodUndefined.create;
var nullType = ZodNull.create;
var anyType = ZodAny.create;
var unknownType = ZodUnknown.create;
var neverType = ZodNever.create;
var voidType = ZodVoid.create;
var arrayType = ZodArray.create;
var objectType = ZodObject.create;
var strictObjectType = ZodObject.strictCreate;
var unionType = ZodUnion.create;
var discriminatedUnionType = ZodDiscriminatedUnion.create;
var intersectionType = ZodIntersection.create;
var tupleType = ZodTuple.create;
var recordType = ZodRecord.create;
var mapType = ZodMap.create;
var setType = ZodSet.create;
var functionType = ZodFunction.create;
var lazyType = ZodLazy.create;
var literalType = ZodLiteral.create;
var enumType = ZodEnum.create;
var nativeEnumType = ZodNativeEnum.create;
var promiseType = ZodPromise.create;
var effectsType = ZodEffects.create;
var optionalType = ZodOptional.create;
var nullableType = ZodNullable.create;
var preprocessType = ZodEffects.createWithPreprocess;
var pipelineType = ZodPipeline.create;
var ostring = () => stringType().optional();
var onumber = () => numberType().optional();
var oboolean = () => booleanType().optional();
var coerce = {
  string: ((arg) => ZodString.create({ ...arg, coerce: true })),
  number: ((arg) => ZodNumber.create({ ...arg, coerce: true })),
  boolean: ((arg) => ZodBoolean.create({
    ...arg,
    coerce: true
  })),
  bigint: ((arg) => ZodBigInt.create({ ...arg, coerce: true })),
  date: ((arg) => ZodDate.create({ ...arg, coerce: true }))
};
var NEVER = INVALID;

// ../../packages/contracts/src/index.ts
var idSchema = external_exports.string().uuid();
var isoDateTimeSchema = external_exports.string().datetime({ offset: true });
var workStatusSchema = external_exports.enum([
  "discussion",
  "planned",
  "in_progress",
  "awaiting_validation",
  "completed",
  "blocked",
  "cancelled"
]);
var productionMetadataSchema = external_exports.object({
  skillVersion: external_exports.enum([
    "partner-report-sync/0.2.0",
    "partner-report-sync/0.3.0",
    "partner-report-sync/0.4.0",
    "partner-report-sync/0.4.1",
    "partner-report-platform/0.2.0",
    "partner-report-platform/0.3.0"
  ]),
  promptVersion: external_exports.string().min(1).max(80),
  schemaVersion: external_exports.literal("1.0"),
  producer: external_exports.enum(["codex-skill", "data-platform"]),
  modelVersion: external_exports.string().min(1).optional()
});
var projectIdentitySchema = external_exports.object({
  id: idSchema.nullable(),
  name: external_exports.string().min(1).max(120),
  matchMethod: external_exports.enum([
    "exact_root",
    "descendant_path",
    "path_discovered",
    "unassigned"
  ]),
  rootFingerprint: external_exports.string().regex(/^[a-f0-9]{64}$/),
  rootName: external_exports.string().min(1).max(120).optional()
}).strict().superRefine((project, context) => {
  if (project.matchMethod === "path_discovered" && !project.rootName) {
    context.addIssue({
      code: external_exports.ZodIssueCode.custom,
      path: ["rootName"],
      message: "path_discovered project requires rootName"
    });
  }
});
var contributionKindSchema = external_exports.enum([
  "outcome",
  "progress",
  "decision",
  "blocker",
  "next_step"
]);
var contributionItemSchema = external_exports.object({
  kind: contributionKindSchema,
  text: external_exports.string().min(1).max(600),
  confidence: external_exports.enum(["high", "medium", "low"])
}).strict();
var sessionContributionSchema = external_exports.object({
  schemaVersion: external_exports.literal("1.0"),
  periodKey: external_exports.string().min(1).max(80),
  sessionKey: external_exports.string().regex(/^[a-f0-9]{64}$/),
  contentHash: external_exports.string().regex(/^[a-f0-9]{64}$/),
  project: projectIdentitySchema,
  activity: external_exports.object({
    startedAt: isoDateTimeSchema,
    endedAt: isoDateTimeSchema
  }).strict(),
  title: external_exports.string().min(1).max(200),
  summary: external_exports.string().min(1).max(1600),
  status: workStatusSchema,
  contributions: external_exports.array(contributionItemSchema).min(1).max(40),
  observedAt: isoDateTimeSchema,
  production: productionMetadataSchema
}).strict().superRefine((contribution, context) => {
  if (new Date(contribution.activity.startedAt).getTime() > new Date(contribution.activity.endedAt).getTime()) {
    context.addIssue({
      code: external_exports.ZodIssueCode.custom,
      path: ["activity", "endedAt"],
      message: "activity.endedAt must not precede activity.startedAt"
    });
  }
});
var sessionExtractionResultSchema = external_exports.discriminatedUnion(
  "decision",
  [
    external_exports.object({
      schemaVersion: external_exports.literal("1.0"),
      decision: external_exports.literal("ignore"),
      reason: external_exports.enum([
        "casual_conversation",
        "unrelated_to_project",
        "no_meaningful_contribution",
        "insufficient_context"
      ])
    }).strict(),
    external_exports.object({
      schemaVersion: external_exports.literal("1.0"),
      decision: external_exports.literal("include"),
      contribution: sessionContributionSchema
    }).strict()
  ]
);
var sessionContributionStateQuerySchema = external_exports.object({
  periodKey: external_exports.string().min(1).max(80)
}).strict();
var coverageSchema = external_exports.object({
  discovered: external_exports.number().int().nonnegative(),
  eligible: external_exports.number().int().nonnegative().default(0),
  readable: external_exports.number().int().nonnegative(),
  extracted: external_exports.number().int().nonnegative(),
  deferred: external_exports.number().int().nonnegative().default(0),
  failedRead: external_exports.number().int().nonnegative(),
  failedExtract: external_exports.number().int().nonnegative(),
  excluded: external_exports.number().int().nonnegative(),
  pendingSync: external_exports.number().int().nonnegative(),
  activeAtCutoff: external_exports.number().int().nonnegative(),
  hookMissed: external_exports.number().int().nonnegative(),
  warnings: external_exports.array(external_exports.string()).default([]),
  lastSyncAt: isoDateTimeSchema.optional()
});
var aggregationGroupSchema = external_exports.object({
  projectKey: external_exports.string().min(1).max(160),
  status: workStatusSchema,
  overview: external_exports.string().min(1).max(1600),
  dailyProgress: external_exports.array(
    external_exports.object({
      date: external_exports.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      summary: external_exports.string().min(1).max(1200)
    }).strict()
  ).min(1)
}).strict();
var aggregationResultSchema = external_exports.object({
  schemaVersion: external_exports.literal("1.0"),
  groups: external_exports.array(aggregationGroupSchema),
  qualityWarnings: external_exports.array(external_exports.string()).default([]),
  production: productionMetadataSchema
});
var reportClaimSchema = external_exports.object({
  claim: external_exports.string().min(1).max(800),
  workItemIds: external_exports.array(idSchema).min(1)
});
var reportSectionSchema = external_exports.object({
  key: external_exports.enum([
    "summary",
    "achievements",
    "project_progress",
    "risks",
    "next_priorities",
    "coordination",
    "coverage"
  ]),
  title: external_exports.string().min(1).max(100),
  markdown: external_exports.string().max(12e3),
  claims: external_exports.array(reportClaimSchema).default([])
});
var individualReportResultSchema = external_exports.object({
  schemaVersion: external_exports.literal("1.0"),
  title: external_exports.string().min(1).max(200),
  summary: external_exports.string().min(1).max(1200),
  sections: external_exports.array(reportSectionSchema).length(7),
  markdown: external_exports.string().min(1).max(6e4),
  qualityWarnings: external_exports.array(external_exports.string()).default([]),
  production: productionMetadataSchema
});
var teamReportClaimSchema = external_exports.object({
  claim: external_exports.string().min(1).max(1e3),
  individualReportIds: external_exports.array(idSchema).min(1)
});
var teamReportSectionSchema = external_exports.object({
  key: external_exports.enum(["summary", "project_progress", "risks"]),
  title: external_exports.string().min(1).max(100),
  markdown: external_exports.string().max(16e3),
  claims: external_exports.array(teamReportClaimSchema).default([])
});
var teamReportResultSchema = external_exports.object({
  schemaVersion: external_exports.literal("1.0"),
  title: external_exports.string().min(1).max(200),
  summary: external_exports.string().min(1).max(1600),
  sections: external_exports.array(teamReportSectionSchema).length(3),
  markdown: external_exports.string().min(1).max(8e4),
  missingPartnerIds: external_exports.array(idSchema).default([]),
  qualityWarnings: external_exports.array(external_exports.string()).default([]),
  production: productionMetadataSchema
});
var agentJobTypeSchema = external_exports.enum([
  "AGGREGATE_WORK_ITEMS",
  "GENERATE_INDIVIDUAL_REPORT",
  "REGENERATE_INDIVIDUAL_REPORT",
  "GENERATE_TEAM_REPORT",
  "REGENERATE_TEAM_REPORT",
  "REANALYZE_SESSIONS",
  "RESCAN_SESSIONS"
]);
var reviewOperationSchema = external_exports.enum([
  "approve",
  "exclude",
  "restore",
  "update_fact",
  "add_fact",
  "set_emphasis",
  "assign_project",
  "update_status",
  "merge",
  "split",
  "change_period"
]);
var reviewChangeRequestSchema = external_exports.object({
  workItemIds: external_exports.array(idSchema).min(1),
  baseVersion: external_exports.number().int().positive(),
  operation: reviewOperationSchema,
  value: external_exports.unknown().optional(),
  source: external_exports.enum(["web", "feishu"]).default("web")
});
var heartbeatSchema = external_exports.object({
  pluginVersion: external_exports.string().min(1),
  deviceName: external_exports.string().min(1).max(120),
  runnerState: external_exports.enum(["starting", "idle", "working", "delayed", "error"]).default("idle"),
  lastHookAt: isoDateTimeSchema.optional(),
  lastRunnerAt: isoDateTimeSchema.optional(),
  lastScanAt: isoDateTimeSchema.optional(),
  lastSyncAt: isoDateTimeSchema.optional(),
  nextDueAt: isoDateTimeSchema.optional(),
  dirtySessions: external_exports.number().int().nonnegative().default(0),
  extractingSessions: external_exports.number().int().nonnegative().default(0),
  pendingLocalJobs: external_exports.number().int().nonnegative(),
  retryCount: external_exports.number().int().nonnegative(),
  lastErrorCode: external_exports.string().max(120).optional(),
  coverage: coverageSchema.optional()
});
var collectionStatusSchema = external_exports.object({
  pluginVersion: external_exports.string().min(1),
  deviceName: external_exports.string().min(1).max(120),
  phase: external_exports.enum(["started", "completed", "failed"]),
  periodKey: external_exports.string().min(1).max(80),
  sessionCount: external_exports.number().int().nonnegative().default(0),
  factCount: external_exports.number().int().nonnegative().default(0),
  pendingLocalJobs: external_exports.number().int().nonnegative().default(0),
  discoveredCount: external_exports.number().int().nonnegative().default(0),
  eligibleCount: external_exports.number().int().nonnegative().default(0),
  deferredCount: external_exports.number().int().nonnegative().default(0),
  excludedCount: external_exports.number().int().nonnegative().default(0),
  lastScanAt: isoDateTimeSchema.optional(),
  lastSyncAt: isoDateTimeSchema.optional(),
  errorCode: external_exports.string().max(120).optional(),
  coverage: coverageSchema.optional()
});
var connectivityCapabilityVersionSchema = external_exports.literal("1.0");
var connectivityTestSchema = external_exports.object({
  challenge: external_exports.string().min(20).max(200),
  pluginVersion: external_exports.string().min(1).max(40),
  clientTime: isoDateTimeSchema,
  capabilityVersion: connectivityCapabilityVersionSchema
}).strict();
var diagnosticStageSchema = external_exports.enum([
  "binding",
  "connectivity",
  "task_setup",
  "scan",
  "extract",
  "sync"
]);
var diagnosticErrorCodeSchema = external_exports.enum([
  "DNS_FAILED",
  "TLS_FAILED",
  "CONNECTION_REFUSED",
  "CONNECTIVITY_TIMEOUT",
  "AUTH_FAILED",
  "VERSION_BLOCKED",
  "CHALLENGE_INVALID",
  "CHALLENGE_EXPIRED",
  "CLIENT_CLOCK_SKEW",
  "REQUEST_INVALID",
  "TASK_SETUP_FAILED",
  "SCAN_FAILED",
  "EXTRACT_FAILED",
  "SYNC_FAILED",
  "LOCAL_STORAGE_FAILED",
  "LOCAL_AGENT_FAILED",
  "SENSITIVE_EGRESS_REJECTED"
]);
var pluginDiagnosticEventSchema = external_exports.object({
  eventId: external_exports.string().uuid(),
  stage: diagnosticStageSchema,
  errorCode: diagnosticErrorCodeSchema,
  occurredAt: isoDateTimeSchema,
  retryable: external_exports.boolean(),
  requestId: external_exports.string().min(1).max(120).optional()
}).strict();
var pluginDiagnosticBatchSchema = external_exports.object({
  events: external_exports.array(pluginDiagnosticEventSchema).min(1).max(20)
}).strict();

// src/config.ts
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
var PLUGIN_VERSION = "0.4.3";
var DATA_DIRECTORY_SERVICE = "partner-report:data-directory";
var BOOTSTRAP_CONFIG_SERVICE = "partner-report:bootstrap-config";
var PERSISTENT_DATA_FILES = [
  "config.json",
  "collection-state.json",
  "project-scope.json",
  "secrets.json"
];
function normalizeServerUrl(value, allowInsecureHttp = false) {
  const raw = value.trim();
  if (!raw) throw new Error("\u6570\u636E\u4E2D\u53F0\u5730\u5740\u4E0D\u80FD\u4E3A\u7A7A\u3002");
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("\u6570\u636E\u4E2D\u53F0\u5730\u5740\u4E0D\u662F\u6709\u6548 URL\u3002");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("\u6570\u636E\u4E2D\u53F0\u5730\u5740\u53EA\u652F\u6301 http:// \u6216 https://\u3002");
  }
  if (url.username || url.password) {
    throw new Error("\u6570\u636E\u4E2D\u53F0\u5730\u5740\u4E0D\u80FD\u5305\u542B\u7528\u6237\u540D\u6216\u5BC6\u7801\u3002");
  }
  if (url.search || url.hash) {
    throw new Error("\u6570\u636E\u4E2D\u53F0\u5730\u5740\u4E0D\u80FD\u5305\u542B\u67E5\u8BE2\u53C2\u6570\u6216\u951A\u70B9\u3002");
  }
  const loopbackHosts = /* @__PURE__ */ new Set(["127.0.0.1", "localhost", "::1"]);
  if (url.protocol === "http:" && !loopbackHosts.has(url.hostname) && !allowInsecureHttp) {
    throw new Error(
      "\u8FDC\u7A0B\u6570\u636E\u4E2D\u53F0\u5FC5\u987B\u4F7F\u7528 HTTPS\u3002\u4EC5\u672C\u673A\u5730\u5740\u53EF\u76F4\u63A5\u4F7F\u7528 HTTP\uFF1B\u6D4B\u8BD5\u5185\u7F51 HTTP \u65F6\u663E\u5F0F\u6DFB\u52A0 --allow-insecure-http\u3002"
    );
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}
function useKeychain() {
  return process.platform === "darwin" && process.env.PARTNER_REPORT_ALLOW_FILE_TOKENS !== "1";
}
function readKeychainValue(service) {
  if (!useKeychain()) return null;
  try {
    return execFileSync(
      "security",
      ["find-generic-password", "-a", "partner-report", "-s", service, "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    ).trim() || null;
  } catch {
    return null;
  }
}
function saveKeychainValue(service, value) {
  execFileSync(
    "security",
    [
      "add-generic-password",
      "-a",
      "partner-report",
      "-s",
      service,
      "-w",
      value,
      "-U"
    ],
    { stdio: "ignore" }
  );
}
function migratePersistentDataDirectory(source, target) {
  const sourceDirectory = resolve(source);
  const targetDirectory = resolve(target);
  if (sourceDirectory === targetDirectory || !existsSync(sourceDirectory))
    return;
  mkdirSync(targetDirectory, { recursive: true, mode: 448 });
  for (const filename of PERSISTENT_DATA_FILES) {
    const sourcePath = resolve(sourceDirectory, filename);
    const targetPath = resolve(targetDirectory, filename);
    if (!existsSync(sourcePath) || existsSync(targetPath)) continue;
    copyFileSync(sourcePath, targetPath);
    chmodSync(targetPath, 384);
  }
}
function dataDirectory() {
  const runtimeDirectory = process.env.PLUGIN_DATA ?? process.env.CLAUDE_PLUGIN_DATA;
  const explicitDirectory = process.env.PARTNER_REPORT_DATA;
  const stableDirectory = resolve(homedir(), ".partner-report-data");
  const rememberedDirectory = useKeychain() ? readKeychainValue(DATA_DIRECTORY_SERVICE) : null;
  const location = resolve(explicitDirectory ?? stableDirectory);
  mkdirSync(location, { recursive: true, mode: 448 });
  if (!explicitDirectory) {
    for (const legacyDirectory of [rememberedDirectory, runtimeDirectory]) {
      if (legacyDirectory)
        migratePersistentDataDirectory(legacyDirectory, location);
    }
  }
  return location;
}
function configPath() {
  return resolve(dataDirectory(), "config.json");
}
function fallbackSecretsPath() {
  return resolve(dataDirectory(), "secrets.json");
}
function loadConfig(required = true) {
  const path = configPath();
  if (!existsSync(path)) {
    const bootstrap = readKeychainValue(BOOTSTRAP_CONFIG_SERVICE);
    if (bootstrap) {
      const config = JSON.parse(bootstrap);
      writeFileSync(path, `${JSON.stringify(config, null, 2)}
`, {
        mode: 384
      });
      chmodSync(path, 384);
      return config;
    }
    if (required)
      throw new Error("Plugin \u5C1A\u672A\u8FDE\u63A5\u3002\u8BF7\u5148\u8FD0\u884C partner-report connect\u3002");
    return null;
  }
  return JSON.parse(readFileSync(path, "utf8"));
}
function saveConfig(config) {
  const directory = dataDirectory();
  const path = resolve(directory, "config.json");
  writeFileSync(path, `${JSON.stringify(config, null, 2)}
`, { mode: 384 });
  chmodSync(path, 384);
  if (useKeychain()) {
    saveKeychainValue(DATA_DIRECTORY_SERVICE, directory);
    saveKeychainValue(BOOTSTRAP_CONFIG_SERVICE, JSON.stringify(config));
  }
}
function keychainService(instanceId, kind) {
  return `partner-report:${instanceId}:${kind}`;
}
function mayUseFileSecrets() {
  return process.env.PARTNER_REPORT_ALLOW_FILE_TOKENS === "1" || process.platform !== "darwin";
}
function saveFileSecret(instanceId, kind, value) {
  if (!mayUseFileSecrets())
    throw new Error("macOS Keychain \u4E0D\u53EF\u7528\uFF0C\u4E14\u672A\u5141\u8BB8\u6587\u4EF6 Token fallback\u3002");
  const path = fallbackSecretsPath();
  const existing = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  existing[`${instanceId}:${kind}`] = value;
  writeFileSync(path, `${JSON.stringify(existing)}
`, { mode: 384 });
  chmodSync(path, 384);
}
function saveSecret(instanceId, kind, value) {
  if (process.platform === "darwin" && process.env.PARTNER_REPORT_ALLOW_FILE_TOKENS !== "1") {
    try {
      execFileSync(
        "security",
        [
          "add-generic-password",
          "-a",
          "partner-report",
          "-s",
          keychainService(instanceId, kind),
          "-w",
          value,
          "-U"
        ],
        { stdio: "ignore" }
      );
      return;
    } catch {
    }
  }
  saveFileSecret(instanceId, kind, value);
}
function loadSecret(instanceId, kind) {
  if (process.platform === "darwin" && process.env.PARTNER_REPORT_ALLOW_FILE_TOKENS !== "1") {
    try {
      return execFileSync(
        "security",
        [
          "find-generic-password",
          "-a",
          "partner-report",
          "-s",
          keychainService(instanceId, kind),
          "-w"
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
      ).trim();
    } catch {
      throw Object.assign(
        new Error(`\u65E0\u6CD5\u4ECE macOS Keychain \u8BFB\u53D6 ${kind} Token\u3002`),
        { code: "KEYCHAIN_ACCESS_REQUIRED" }
      );
    }
  }
  const path = fallbackSecretsPath();
  if (!existsSync(path)) throw new Error("Plugin Token \u4E0D\u5B58\u5728\uFF0C\u8BF7\u91CD\u65B0\u8FDE\u63A5\u3002");
  const secrets = JSON.parse(readFileSync(path, "utf8"));
  const value = secrets[`${instanceId}:${kind}`];
  if (!value) throw new Error(`Plugin ${kind} Token \u4E0D\u5B58\u5728\uFF0C\u8BF7\u91CD\u65B0\u8FDE\u63A5\u3002`);
  return value;
}
function removeSecrets(instanceId) {
  if (process.platform === "darwin" && process.env.PARTNER_REPORT_ALLOW_FILE_TOKENS !== "1") {
    for (const kind of ["access", "refresh", "recovery"]) {
      try {
        execFileSync(
          "security",
          [
            "delete-generic-password",
            "-a",
            "partner-report",
            "-s",
            keychainService(instanceId, kind)
          ],
          { stdio: "ignore" }
        );
      } catch {
      }
    }
    return;
  }
  const path = fallbackSecretsPath();
  if (!existsSync(path)) return;
  const secrets = JSON.parse(readFileSync(path, "utf8"));
  delete secrets[`${instanceId}:access`];
  delete secrets[`${instanceId}:refresh`];
  delete secrets[`${instanceId}:recovery`];
  writeFileSync(path, `${JSON.stringify(secrets)}
`, { mode: 384 });
}
function removeSecret(instanceId, kind) {
  if (process.platform === "darwin" && process.env.PARTNER_REPORT_ALLOW_FILE_TOKENS !== "1") {
    try {
      execFileSync(
        "security",
        [
          "delete-generic-password",
          "-a",
          "partner-report",
          "-s",
          keychainService(instanceId, kind)
        ],
        { stdio: "ignore" }
      );
    } catch {
    }
    return;
  }
  const path = fallbackSecretsPath();
  if (!existsSync(path)) return;
  const secrets = JSON.parse(readFileSync(path, "utf8"));
  delete secrets[`${instanceId}:${kind}`];
  writeFileSync(path, `${JSON.stringify(secrets)}
`, { mode: 384 });
}

// src/http.ts
var HttpError = class extends Error {
  constructor(status2, code, message, details, requestId) {
    super(message);
    this.status = status2;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
  }
};
async function rawRequest(serverUrl, path, init = {}, accessToken) {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type"))
    headers.set("content-type", "application/json");
  if (accessToken) headers.set("authorization", `Bearer ${accessToken}`);
  const response = await fetch(`${serverUrl.replace(/\/$/, "")}${path}`, {
    ...init,
    headers
  });
  const body = await response.json().catch(() => null);
  if (!response.ok)
    throw new HttpError(
      response.status,
      body?.code ?? "HTTP_ERROR",
      body?.message ?? response.statusText,
      body?.details,
      body?.requestId
    );
  return body;
}
async function publicRequest(serverUrl, path, init = {}) {
  return rawRequest(serverUrl, path, init);
}
async function refresh(config) {
  const refreshToken = loadSecret(config.pluginInstanceId, "refresh");
  const tokens = await rawRequest(config.serverUrl, "/v1/plugin-bindings/refresh", {
    method: "POST",
    body: JSON.stringify({ refreshToken })
  });
  if (tokens.pluginInstanceId !== config.pluginInstanceId)
    throw new Error("\u5237\u65B0\u54CD\u5E94\u7684 Plugin Instance \u4E0D\u5339\u914D\u3002");
  saveSecret(config.pluginInstanceId, "access", tokens.accessToken);
  saveSecret(config.pluginInstanceId, "refresh", tokens.refreshToken);
  const next = { ...config, accessExpiresAt: tokens.expiresAt };
  saveConfig(next);
  return next;
}
var refreshes = /* @__PURE__ */ new Map();
function refreshOnce(config) {
  const existing = refreshes.get(config.pluginInstanceId);
  if (existing) return existing;
  const pending = refresh(config).finally(() => {
    if (refreshes.get(config.pluginInstanceId) === pending) {
      refreshes.delete(config.pluginInstanceId);
    }
  });
  refreshes.set(config.pluginInstanceId, pending);
  return pending;
}
async function authenticatedRequest(path, init = {}) {
  let config = loadConfig();
  if (new Date(config.accessExpiresAt).getTime() < Date.now() + 6e4)
    config = await refreshOnce(config);
  try {
    return await rawRequest(
      config.serverUrl,
      path,
      init,
      loadSecret(config.pluginInstanceId, "access")
    );
  } catch (error) {
    if (!(error instanceof HttpError) || error.status !== 401) throw error;
    config = await refreshOnce(config);
    return rawRequest(
      config.serverUrl,
      path,
      init,
      loadSecret(config.pluginInstanceId, "access")
    );
  }
}

// src/collection-config.ts
var DEFAULT_COLLECTION_MODEL = "gpt-5.5";
var DEFAULT_COLLECTION_REASONING_EFFORT = "low";
var SCHEDULED_COLLECTION_PROMPT = [
  "\u4F7F\u7528 $partner-report-sync \u91C7\u96C6\u5F53\u524D Partner Report \u5468\u671F\u5185\u7B26\u5408\u6761\u4EF6\u7684 Codex Session\u3002",
  "\u672C\u4EFB\u52A1\u5FC5\u987B\u5B8C\u6574\u6267\u884C\u91C7\u96C6\u548C\u7EC8\u6001\u5BA1\u67E5\u4E24\u4E2A\u9636\u6BB5\uFF0C\u4EFB\u4F55\u9636\u6BB5\u90FD\u4E0D\u5F97\u63D0\u524D\u6536\u5C3E\u3002",
  "\u4E25\u683C\u6309\u7167 Skill \u8C03\u7528\u63D2\u4EF6 CLI\uFF0C\u6BCF\u6B21\u53EA\u8BFB\u53D6\u548C\u5904\u7406\u4E00\u4E2A Session\u3002",
  "\u9996\u6B21\u8FD0\u884C\u53EA\u91C7\u96C6\u6700\u8FD1 1 \u5929\uFF1B\u540E\u7EED\u7531\u63D2\u4EF6\u672C\u5730\u6210\u529F\u6E38\u6807\u3001\u91CD\u53E0\u7A97\u53E3\u548C\u5185\u5BB9\u54C8\u5E0C\u81EA\u52A8\u786E\u5B9A\u589E\u91CF\u8303\u56F4\u3002",
  "\u672C\u5730\u9879\u76EE\u6743\u9650\u6587\u4EF6\u7F3A\u5931\u3001\u635F\u574F\u6216\u4E0D\u5C5E\u4E8E\u5F53\u524D\u63D2\u4EF6\u5B9E\u4F8B\u65F6\uFF0Ccollect-start \u5FC5\u987B\u6839\u636E\u5F53\u524D\u5468\u671F\u7684 Session \u5143\u6570\u636E\u91CD\u65B0\u53D1\u8D77\u98DE\u4E66\u9879\u76EE\u5BA1\u6279\uFF0C\u5E76\u5728\u8BFB\u53D6\u4EFB\u4F55 Session \u5185\u5BB9\u524D\u7ED3\u675F\u672C\u6B21\u8FD0\u884C\uFF1B\u7528\u6237\u5BA1\u6279\u540E\u7531\u4E0B\u4E00\u6B21\u5B9A\u65F6\u8FD0\u884C\u6216\u624B\u52A8\u7EE7\u7EED\u91C7\u96C6\u3002",
  "\u5148\u5224\u65AD\u6574\u4E2A Session \u662F\u5426\u5305\u542B\u5BF9\u6620\u5C04\u9879\u76EE\u6709\u610F\u4E49\u7684\u5B9E\u9645\u5DE5\u4F5C\uFF1B\u820D\u5F03\u95F2\u804A\u3001\u65E0\u5173\u8BDD\u9898\u3001\u4F4E\u4EF7\u503C\u5F80\u8FD4\uFF0C\u4EE5\u53CA\u6CA1\u6709\u660E\u786E\u6210\u679C\u3001\u8FDB\u5C55\u3001\u51B3\u7B56\u3001\u963B\u585E\u6216\u4E0B\u4E00\u6B65\u7684 Session\u3002",
  "\u6240\u6709\u63D0\u53D6\u6307\u4EE4\u4EE5\u53CA\u4E0A\u4F20\u7684\u6807\u9898\u3001\u6458\u8981\u548C\u8D21\u732E\u6B63\u6587\u5FC5\u987B\u4F7F\u7528\u4E2D\u6587\u3002",
  "\u53EA\u5199\u5165 Skill \u8981\u6C42\u4E14\u901A\u8FC7\u6821\u9A8C\u7684 SessionExtractionResult\uFF0C\u5E76\u53EA\u4E0A\u4F20 SessionContribution\u3002",
  "\u4E0D\u5F97\u4E0A\u4F20\u539F\u59CB\u5BF9\u8BDD\u3001\u7EDD\u5BF9\u8DEF\u5F84\u3001Codex Session \u539F\u59CB\u6807\u8BC6\u3001\u63A8\u7406\u3001\u5DE5\u5177\u8C03\u7528\u3001\u547D\u4EE4\u3001\u6587\u4EF6\u6539\u52A8\u6216\u51ED\u636E\u3002",
  "automation memory \u53EA\u8BB0\u5F55\u8FD0\u884C\u65F6\u95F4\u3001\u5B8C\u6210\u6216\u5931\u8D25\u72B6\u6001\u3001\u805A\u5408\u8BA1\u6570\u548C\u5B89\u5168\u9519\u8BEF\u7801\uFF1B\u4E0D\u5F97\u8BB0\u5F55 Session \u5185\u5BB9\u3001Fact\u3001\u8BC1\u636E\u3001\u7AEF\u70B9\u6216\u6807\u8BC6\uFF0C\u9632\u91CD\u4EE5\u7A33\u5B9A\u7528\u6237\u76EE\u5F55\u4E2D\u7684\u672C\u5730 accepted/ignored \u54C8\u5E0C\u8BB0\u5F55\u548C\u4E2D\u53F0\u54C8\u5E0C\u4E3A\u51C6\u3002",
  "CLI \u8FD4\u56DE started\u3001job\u3001uploaded\u3001ignored\u3001skipped\u3001review_required \u6216\u4EFB\u4F55 nextCommand \u65F6\u90FD\u5C5E\u4E8E\u975E\u7EC8\u6001\uFF0C\u5FC5\u987B\u7ACB\u5373\u6267\u884C\u5BF9\u5E94\u7684\u4E0B\u4E00\u6B65\uFF0C\u4E0D\u5F97\u603B\u7ED3\u3001\u6807\u8BB0\u5B8C\u6210\u6216\u7ED3\u675F\u4EFB\u52A1\u3002",
  "CLI \u8FD4\u56DE feishu_identity_confirmation_required \u6216 project_scope_approval_required \u4E14\u6CA1\u6709 nextCommand \u65F6\u5C5E\u4E8E\u6B63\u5E38\u7B49\u5F85\u7EC8\u6001\uFF0C\u53EA\u62A5\u544A\u9700\u8981\u5904\u7406\u98DE\u4E66\u5361\u7247\uFF0C\u4E0D\u5F97\u5728\u5F53\u524D\u8FD0\u884C\u4E2D\u8F6E\u8BE2\u6216\u7ED5\u8FC7\u6743\u9650\u3002",
  "\u961F\u5217\u6E05\u7A7A\u540E\u5FC5\u987B\u6267\u884C collect-review\uFF1B\u53EA\u6709\u8BE5\u5BA1\u67E5\u547D\u4EE4\u8FD4\u56DE completed \u4E14\u6CA1\u6709 nextCommand \u65F6\u624D\u5141\u8BB8\u6536\u5C3E\u3002",
  "\u6536\u5C3E\u524D\u518D\u6B21\u6838\u5BF9\u6700\u540E\u4E00\u6B21 CLI \u7ED3\u679C\uFF1AcheckpointAdvanced \u4E3A true \u624D\u8BB0\u5F55\u6210\u529F\uFF1B\u4E3A false \u65F6\u8BB0\u5F55\u5931\u8D25\u6216\u90E8\u5206\u8FD0\u884C\u5E76\u4FDD\u7559\u91CD\u8BD5\u8B66\u544A\uFF0C\u7EDD\u4E0D\u80FD\u8BB0\u5F55\u6210\u529F\u3002",
  "\u6700\u7EC8\u53EA\u8FD4\u56DE\u5B89\u5168\u7684\u4E2D\u6587\u805A\u5408\u6458\u8981\u3002"
].join(" ");
var SCHEDULED_COLLECTION_TASK = {
  name: "Partner Report daily collection",
  destination: "new_chat",
  project: null,
  schedule: {
    rrule: "RRULE:FREQ=DAILY;BYHOUR=14;BYMINUTE=30",
    timezone: "Asia/Shanghai"
  },
  model: DEFAULT_COLLECTION_MODEL,
  reasoningEffort: DEFAULT_COLLECTION_REASONING_EFFORT,
  notifications: "all_runs",
  prompt: SCHEDULED_COLLECTION_PROMPT
};

// src/collection-dedup.ts
function knownContentHashes(known) {
  return [
    .../* @__PURE__ */ new Set([...known.contentHashes ?? [], known.contentHash])
  ].filter((value) => Boolean(value));
}
function mergeKnownSession(sessions, sessionKey, contentHash, decision, override = false) {
  const existing = sessions[sessionKey];
  sessions[sessionKey] = !override && existing?.decision === decision ? {
    decision,
    contentHashes: [
      .../* @__PURE__ */ new Set([...knownContentHashes(existing), contentHash])
    ]
  } : { decision, contentHashes: [contentHash] };
}
function buildKnownSessionIndex(input) {
  const sessions = {};
  for (const session of input.remoteAccepted) {
    mergeKnownSession(
      sessions,
      session.sessionKey,
      session.contentHash,
      "accepted"
    );
  }
  for (const [sessionKey, accepted] of Object.entries(input.localAccepted)) {
    mergeKnownSession(sessions, sessionKey, accepted.contentHash, "accepted");
  }
  for (const [sessionKey, ignored] of Object.entries(input.localIgnored)) {
    mergeKnownSession(
      sessions,
      sessionKey,
      ignored.contentHash,
      "ignored",
      true
    );
  }
  return sessions;
}
function matchingKnownDecision(known, candidateHashes) {
  if (!known) return null;
  const candidates = new Set(candidateHashes);
  return knownContentHashes(known).some((hash) => candidates.has(hash)) ? known.decision : null;
}

// src/collection-state.ts
import {
  chmodSync as chmodSync2,
  existsSync as existsSync2,
  readFileSync as readFileSync2,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync as writeFileSync2
} from "node:fs";
import { resolve as resolve2 } from "node:path";
var INITIAL_LOOKBACK_DAYS = 1;
var INCREMENTAL_OVERLAP_MS = 24 * 60 * 60 * 1e3;
var COLLECTION_LEASE_MS = 30 * 60 * 1e3;
function statePath(directory) {
  return resolve2(directory, "collection-state.json");
}
function leasePath(directory) {
  return resolve2(directory, "collection.lock");
}
function emptyState(pluginInstanceId) {
  return {
    schemaVersion: "1.0",
    pluginInstanceId,
    collectionFloorAt: null,
    lastSuccessfulRunStartedAt: null,
    acceptedSessions: {},
    ignoredSessions: {}
  };
}
function validIso(value) {
  return typeof value === "string" && Number.isFinite(new Date(value).getTime());
}
function validateState(value, pluginInstanceId) {
  if (!value || typeof value !== "object")
    throw Object.assign(new Error("\u672C\u5730\u91C7\u96C6\u72B6\u6001\u683C\u5F0F\u65E0\u6548\u3002"), {
      code: "COLLECTION_STATE_INVALID"
    });
  const state = value;
  if (state.pluginInstanceId !== pluginInstanceId)
    return emptyState(pluginInstanceId);
  const acceptedSessions = state.acceptedSessions ?? {};
  if (state.schemaVersion !== "1.0" || state.collectionFloorAt !== null && !validIso(state.collectionFloorAt) || state.lastSuccessfulRunStartedAt !== null && !validIso(state.lastSuccessfulRunStartedAt) || !acceptedSessions || typeof acceptedSessions !== "object" || !state.ignoredSessions || typeof state.ignoredSessions !== "object") {
    throw Object.assign(new Error("\u672C\u5730\u91C7\u96C6\u72B6\u6001\u683C\u5F0F\u65E0\u6548\u3002"), {
      code: "COLLECTION_STATE_INVALID"
    });
  }
  for (const records of [acceptedSessions, state.ignoredSessions]) {
    for (const [sessionKey, processed] of Object.entries(records)) {
      if (!/^[a-f0-9]{64}$/.test(sessionKey) || !processed || typeof processed !== "object" || !/^[a-f0-9]{64}$/.test(processed.contentHash) || !validIso(processed.processedAt)) {
        throw Object.assign(new Error("\u672C\u5730\u91C7\u96C6\u72B6\u6001\u5305\u542B\u65E0\u6548\u7684\u5904\u7406\u8BB0\u5F55\u3002"), {
          code: "COLLECTION_STATE_INVALID"
        });
      }
    }
  }
  return { ...state, acceptedSessions };
}
function loadCollectionState(pluginInstanceId, directory = dataDirectory()) {
  const path = statePath(directory);
  if (!existsSync2(path)) return emptyState(pluginInstanceId);
  try {
    return validateState(
      JSON.parse(readFileSync2(path, "utf8")),
      pluginInstanceId
    );
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) throw error;
    throw Object.assign(new Error("\u65E0\u6CD5\u8BFB\u53D6\u672C\u5730\u91C7\u96C6\u72B6\u6001\u3002"), {
      code: "COLLECTION_STATE_INVALID"
    });
  }
}
function saveCollectionState(state, directory = dataDirectory()) {
  const path = statePath(directory);
  const temporary = resolve2(
    directory,
    `.collection-state.${process.pid}.${Date.now()}.tmp`
  );
  writeFileSync2(temporary, `${JSON.stringify(state, null, 2)}
`, {
    mode: 384
  });
  chmodSync2(temporary, 384);
  renameSync(temporary, path);
  chmodSync2(path, 384);
}
function initializeCollectionFloor(state, periodStartsAt, runStartedAt) {
  if (state.collectionFloorAt) return state.collectionFloorAt;
  const floor = Math.max(
    new Date(periodStartsAt).getTime(),
    new Date(runStartedAt).getTime() - INITIAL_LOOKBACK_DAYS * 24 * 60 * 60 * 1e3
  );
  state.collectionFloorAt = new Date(floor).toISOString();
  return state.collectionFloorAt;
}
function collectionWindow(state, period, runStartedAt) {
  const periodStart = new Date(period.starts_at).getTime();
  const runStart = new Date(runStartedAt).getTime();
  const floor = Math.max(
    periodStart,
    new Date(state.collectionFloorAt ?? period.starts_at).getTime()
  );
  const scanStart = state.lastSuccessfulRunStartedAt ? Math.max(
    floor,
    new Date(state.lastSuccessfulRunStartedAt).getTime() - INCREMENTAL_OVERLAP_MS
  ) : floor;
  return {
    extractionStartsAt: new Date(floor).toISOString(),
    extractionEndsAt: new Date(
      Math.min(new Date(period.ends_at).getTime(), runStart)
    ).toISOString(),
    scanStartsAt: new Date(scanStart).toISOString(),
    scanEndsAt: new Date(runStart).toISOString()
  };
}
function threadIsInScanWindow(updatedAt, scanStartsAt, scanEndsAt) {
  if (updatedAt == null) return true;
  const timestamp2 = typeof updatedAt === "number" && updatedAt < 1e10 ? updatedAt * 1e3 : new Date(updatedAt).getTime();
  return Number.isFinite(timestamp2) && timestamp2 >= new Date(scanStartsAt).getTime() && timestamp2 <= new Date(scanEndsAt).getTime();
}
function recordIgnoredSession(state, sessionKey, contentHash, processedAt = (/* @__PURE__ */ new Date()).toISOString()) {
  const existing = state.ignoredSessions[sessionKey];
  state.ignoredSessions[sessionKey] = {
    contentHash,
    processedAt: existing?.contentHash === contentHash ? existing.processedAt : processedAt
  };
  delete state.acceptedSessions[sessionKey];
}
function recordAcceptedSession(state, sessionKey, contentHash, processedAt = (/* @__PURE__ */ new Date()).toISOString()) {
  const existing = state.acceptedSessions[sessionKey];
  state.acceptedSessions[sessionKey] = {
    contentHash,
    processedAt: existing?.contentHash === contentHash ? existing.processedAt : processedAt
  };
  delete state.ignoredSessions[sessionKey];
}
function canAdvanceCollectionCheckpoint(counts) {
  return counts.failedRead === 0 && counts.failedExtract === 0;
}
function reviewCollectionCompletion(input) {
  const queueExhausted = input.cursor === input.queueLength;
  const noCurrentJob = !input.hasCurrentJob;
  return {
    queueExhausted,
    noCurrentJob,
    readyToFinalize: queueExhausted && noCurrentJob,
    checkpointEligible: canAdvanceCollectionCheckpoint(input.counts)
  };
}
function writeLease(path, lease, exclusive = false) {
  writeFileSync2(path, `${JSON.stringify(lease)}
`, {
    mode: 384,
    ...exclusive ? { flag: "wx" } : {}
  });
  chmodSync2(path, 384);
}
function readLease(path) {
  if (!existsSync2(path)) return null;
  try {
    return JSON.parse(readFileSync2(path, "utf8"));
  } catch {
    return null;
  }
}
function acquireCollectionLease(pluginInstanceId, runId, now = /* @__PURE__ */ new Date(), directory = dataDirectory()) {
  const path = leasePath(directory);
  const existing = readLease(path);
  if (existing) {
    const heartbeat = new Date(existing.heartbeatAt).getTime();
    if (existing.pluginInstanceId === pluginInstanceId && Number.isFinite(heartbeat) && now.getTime() - heartbeat <= COLLECTION_LEASE_MS) {
      throw Object.assign(
        new Error("\u5DF2\u6709\u91C7\u96C6\u4EFB\u52A1\u6B63\u5728\u8FD0\u884C\uFF0C\u8BF7\u7B49\u5F85\u5176\u5B8C\u6210\u540E\u518D\u8BD5\u3002"),
        { code: "COLLECTION_ALREADY_RUNNING" }
      );
    }
    unlinkSync(path);
  } else if (existsSync2(path)) {
    const age = now.getTime() - statSync(path).mtimeMs;
    if (age <= COLLECTION_LEASE_MS) {
      throw Object.assign(new Error("\u91C7\u96C6\u79DF\u7EA6\u72B6\u6001\u65E0\u6548\u4E14\u5C1A\u672A\u8FC7\u671F\u3002"), {
        code: "COLLECTION_ALREADY_RUNNING"
      });
    }
    unlinkSync(path);
  }
  const timestamp2 = now.toISOString();
  try {
    writeLease(
      path,
      {
        schemaVersion: "1.0",
        pluginInstanceId,
        runId,
        acquiredAt: timestamp2,
        heartbeatAt: timestamp2
      },
      true
    );
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      throw Object.assign(new Error("\u5DF2\u6709\u91C7\u96C6\u4EFB\u52A1\u6B63\u5728\u8FD0\u884C\u3002"), {
        code: "COLLECTION_ALREADY_RUNNING"
      });
    }
    throw error;
  }
}
function refreshCollectionLease(pluginInstanceId, runId, now = /* @__PURE__ */ new Date(), directory = dataDirectory()) {
  const path = leasePath(directory);
  const lease = readLease(path);
  if (!lease || lease.pluginInstanceId !== pluginInstanceId || lease.runId !== runId) {
    throw Object.assign(new Error("\u5F53\u524D\u91C7\u96C6\u4EFB\u52A1\u5DF2\u5931\u53BB\u8FD0\u884C\u79DF\u7EA6\u3002"), {
      code: "COLLECTION_LEASE_LOST"
    });
  }
  writeLease(path, { ...lease, heartbeatAt: now.toISOString() });
}
function releaseCollectionLease(pluginInstanceId, runId, directory = dataDirectory()) {
  const path = leasePath(directory);
  const lease = readLease(path);
  if (lease?.pluginInstanceId === pluginInstanceId && lease.runId === runId) {
    unlinkSync(path);
  }
}

// src/app-server.ts
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
var CodexAppServer = class {
  constructor(codexBin = process.env.CODEX_BIN ?? "codex") {
    this.codexBin = codexBin;
  }
  process = null;
  nextId = 1;
  pending = /* @__PURE__ */ new Map();
  stderr = "";
  async connect() {
    this.process = spawn(
      this.codexBin,
      [
        "app-server",
        "--stdio",
        "--disable",
        "plugins",
        "--disable",
        "remote_plugin"
      ],
      { stdio: ["pipe", "pipe", "pipe"] }
    );
    const lines = createInterface({ input: this.process.stdout });
    lines.on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (typeof message.id !== "number") return;
      const waiting = this.pending.get(message.id);
      if (!waiting) return;
      clearTimeout(waiting.timer);
      this.pending.delete(message.id);
      if (message.error)
        waiting.reject(
          new Error(message.error.message ?? "Codex app-server request failed")
        );
      else waiting.resolve(message.result);
    });
    this.process.stderr.on("data", (chunk) => {
      this.stderr = `${this.stderr}${chunk.toString("utf8")}`.slice(-4e3);
    });
    this.process.on("exit", (code) => {
      for (const waiting of this.pending.values()) {
        clearTimeout(waiting.timer);
        waiting.reject(
          new Error(
            `Codex app-server exited (${code ?? "unknown"}): ${this.stderr}`
          )
        );
      }
      this.pending.clear();
    });
    await this.request("initialize", {
      clientInfo: {
        name: "partner_report",
        title: "Partner Report",
        version: PLUGIN_VERSION
      }
    });
    this.notify("initialized", {});
  }
  request(method, params, timeoutMs = 3e4) {
    if (!this.process) throw new Error("Codex app-server \u5C1A\u672A\u8FDE\u63A5\u3002");
    const id = this.nextId++;
    return new Promise((resolve6, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve6, reject, timer });
      this.process.stdin.write(`${JSON.stringify({ method, id, params })}
`);
    });
  }
  notify(method, params) {
    if (!this.process) throw new Error("Codex app-server \u5C1A\u672A\u8FDE\u63A5\u3002");
    this.process.stdin.write(`${JSON.stringify({ method, params })}
`);
  }
  async listThreads() {
    const threads = [];
    let cursor = null;
    do {
      const result = await this.request("thread/list", {
        ...cursor ? { cursor } : {},
        limit: 100,
        sortKey: "updated_at",
        sortDirection: "desc",
        sourceKinds: ["cli", "vscode", "appServer"]
      });
      threads.push(...result.data ?? []);
      cursor = result.nextCursor ?? null;
    } while (cursor && threads.length < 2e3);
    return threads;
  }
  async readThread(threadId) {
    const result = await this.request(
      "thread/read",
      { threadId, includeTurns: true },
      6e4
    );
    return result.thread;
  }
  close() {
    if (!this.process) return;
    this.process.stdin.end();
    this.process.kill("SIGTERM");
    this.process = null;
  }
};

// src/scan.ts
import { createHash } from "node:crypto";
import { existsSync as existsSync3 } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve as resolve3 } from "node:path";
var secretPatterns = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~-]{16,}\b/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token)\s*[:=]\s*[^\s,;]{8,}/gi
];
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
function redactSensitive(value) {
  let text = value;
  let replacements = 0;
  for (const pattern of secretPatterns) {
    pattern.lastIndex = 0;
    text = text.replace(pattern, () => {
      replacements += 1;
      return "[REDACTED_SECRET]";
    });
  }
  return { text, replacements };
}
function containsSensitive(value) {
  const text = JSON.stringify(value);
  return secretPatterns.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(text);
  });
}
function safeText(value, maxLength = 16e3) {
  return redactSensitive(value).text.slice(0, maxLength);
}
function timestamp(value) {
  if (typeof value === "string") return new Date(value).getTime();
  if (typeof value !== "number") return Number.NaN;
  return value > 1e10 ? value : value * 1e3;
}
function toIso(value) {
  const time = timestamp(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}
function textContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const item = entry;
    return item.type === "text" && typeof item.text === "string" ? [item.text] : [];
  }).join("\n");
}
function normalizeProgressTurns(turns) {
  return turns.filter((turn) => turn?.id != null).map((turn) => {
    const items = Array.isArray(turn.items) ? turn.items : [];
    const userPrompt = safeText(
      items.filter((item) => item?.type === "userMessage").map((item) => textContent(item.content)).filter(Boolean).join("\n\n")
    );
    const assistantFinal = safeText(
      items.filter(
        (item) => item?.type === "agentMessage" && item.phase === "final_answer"
      ).map((item) => typeof item.text === "string" ? item.text : "").filter(Boolean).at(-1) ?? ""
    );
    return {
      id: String(turn.id),
      status: typeof turn.status === "string" ? turn.status : null,
      occurredAt: toIso(turn.completedAt ?? turn.updatedAt ?? turn.createdAt),
      userPrompt: userPrompt || null,
      assistantFinal: assistantFinal || null
    };
  });
}
function isCompleteTurn(turn) {
  const incomplete = /* @__PURE__ */ new Set([
    "cancelled",
    "canceled",
    "failed",
    "interrupted",
    "in_progress"
  ]);
  return Boolean(
    turn.userPrompt?.trim() && turn.assistantFinal?.trim() && !incomplete.has(turn.status?.toLowerCase() ?? "")
  );
}
function selectPeriodTurns(turns, period, fallbackOccurredAt) {
  const startsAt = new Date(period.starts_at).getTime();
  const endsAt = new Date(period.ends_at).getTime();
  return turns.filter((turn) => {
    if (!isCompleteTurn(turn)) return false;
    const occurredAt = new Date(
      turn.occurredAt ?? fallbackOccurredAt ?? ""
    ).getTime();
    return Number.isFinite(occurredAt) && occurredAt >= startsAt && occurredAt <= endsAt;
  });
}
function isPluginSystemThread(summary) {
  const name = [summary.name, summary.title].find((value) => typeof value === "string")?.trim().toLowerCase();
  if (!name) return false;
  return name === "partner report daily collection" || name === "\u914D\u7F6E\u63D2\u4EF6\u5B9A\u65F6\u4EFB\u52A1" || name === "\u8FDE\u63A5\u6570\u636E\u4E2D\u53F0\u4E0E\u7ED1\u5B9A\u7801" || name === "\u8FDE\u63A5\u8BBE\u5907\u5230\u672C\u5730\u670D\u52A1" || name === "connect partner report" || name.startsWith("\u67E5\u770B\u5DF2\u5B89\u88C5\u63D2\u4EF6") || name.startsWith("\u8FDE\u63A5\u6570\u636E\u4E2D\u53F0\u4E0E partner-report");
}
function isPluginAdministrationSession(turns) {
  const prompts = turns.map((turn) => turn.userPrompt?.trim()).filter((value) => Boolean(value));
  if (prompts.length === 0) return false;
  const allText = prompts.join("\n").toLowerCase();
  const mentionsPartnerReport = /partner[ -]report/.test(allText);
  const onlyDirectSkillInvocations = prompts.every(
    (prompt) => prompt.replace(/[`\s]/g, "").toLowerCase() === "$partner-report-sync"
  );
  const administration = /(安装|卸载|启用|禁用|绑定|连接|配置|定时任务|验证码|授权码|换绑|已安装|有哪些插件|查看.*插件|install|uninstall|enable|disable|bind|connect|configure|scheduled task)/i;
  return onlyDirectSkillInvocations || mentionsPartnerReport && prompts.every((prompt) => administration.test(prompt));
}
function withinPath(candidate, root) {
  const path = relative(resolve3(root), resolve3(candidate));
  return path === "" || !path.startsWith("..") && !isAbsolute(path);
}
function nearestGitRoot(cwd) {
  let current = resolve3(cwd);
  for (; ; ) {
    if (existsSync3(resolve3(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
function mappedProject(cwd, projects) {
  if (!cwd) {
    return {
      id: null,
      name: "\u72EC\u7ACB\u5DE5\u4F5C",
      matchMethod: "unassigned",
      rootFingerprint: sha256("unassigned")
    };
  }
  const absoluteCwd = resolve3(cwd);
  const configuredMatches = projects.flatMap(
    (project) => (project.allowed_paths ?? []).filter((root) => withinPath(absoluteCwd, root)).map((root) => ({ project, root: resolve3(root) }))
  ).sort((left, right) => right.root.length - left.root.length);
  const configured = configuredMatches[0];
  if (configured) {
    return {
      id: configured.project.id,
      name: configured.project.name,
      matchMethod: configured.root === absoluteCwd ? "exact_root" : "descendant_path",
      rootFingerprint: sha256(configured.root)
    };
  }
  const discoveredRoot = nearestGitRoot(absoluteCwd) ?? absoluteCwd;
  const rootFingerprint = sha256(discoveredRoot);
  const known = projects.find(
    (project) => (project.external_ids ?? []).includes(`path-sha256:${rootFingerprint}`)
  );
  if (known) {
    return {
      id: known.id,
      name: known.name,
      matchMethod: discoveredRoot === absoluteCwd ? "exact_root" : "descendant_path",
      rootFingerprint
    };
  }
  const rootName = basename(discoveredRoot) || "\u9879\u76EE";
  return {
    id: null,
    name: rootName,
    matchMethod: "path_discovered",
    rootFingerprint,
    rootName
  };
}
function pathIsExcluded(cwd, excludedPaths) {
  return Boolean(cwd && excludedPaths.some((root) => withinPath(cwd, root)));
}
function anonymousSessionKey(pluginInstanceId, sessionId) {
  return sha256(`partner-report/session/v1:${pluginInstanceId}:${sessionId}`);
}
function buildSessionJob(input) {
  const normalized = normalizeProgressTurns(input.turns);
  if (isPluginAdministrationSession(normalized)) return null;
  const fallbackOccurredAt = toIso(input.updatedAt) ?? new Date(input.period.ends_at).toISOString();
  const selected = selectPeriodTurns(
    normalized,
    input.period,
    fallbackOccurredAt
  );
  if (selected.length === 0) return null;
  const project = mappedProject(input.cwd, input.projects);
  const activity = {
    startedAt: selected[0].occurredAt ?? fallbackOccurredAt,
    endedAt: selected.at(-1).occurredAt ?? fallbackOccurredAt
  };
  const turns = selected.map((turn) => ({
    occurredAt: turn.occurredAt ?? fallbackOccurredAt,
    userPrompt: turn.userPrompt,
    assistantFinal: turn.assistantFinal
  }));
  const title = safeText(input.title?.trim() || "Codex \u4F1A\u8BDD", 200);
  const sessionKey = anonymousSessionKey(
    input.pluginInstanceId,
    input.sessionId
  );
  const legacyContentHash = (legacyProject) => sha256(
    JSON.stringify({
      periodKey: input.period.period_key,
      title,
      project: legacyProject,
      activity,
      turns
    })
  );
  const compatibleContentHashes = /* @__PURE__ */ new Set([legacyContentHash(project)]);
  if (project.id) {
    compatibleContentHashes.add(
      legacyContentHash({
        id: null,
        name: project.name,
        matchMethod: "path_discovered",
        rootFingerprint: project.rootFingerprint,
        rootName: project.name
      })
    );
  }
  const contentHash = sha256(
    JSON.stringify({
      hashVersion: "2.0",
      periodKey: input.period.period_key,
      turns
    })
  );
  const observedAt = input.observedAt ?? (/* @__PURE__ */ new Date()).toISOString();
  const production = {
    skillVersion: "partner-report-sync/0.4.1",
    promptVersion: "2026-08-05.zh-session-value.v3",
    schemaVersion: "1.0",
    producer: "codex-skill"
  };
  return {
    sessionKey,
    contentHash,
    compatibleContentHashes: [...compatibleContentHashes].filter(
      (hash) => hash !== contentHash
    ),
    expected: {
      schemaVersion: "1.0",
      periodKey: input.period.period_key,
      sessionKey,
      contentHash,
      project,
      activity,
      observedAt,
      production
    },
    modelInput: {
      schemaVersion: "1.0",
      task: "\u7B5B\u9009\u5E76\u603B\u7ED3\u5F53\u524D Codex Session \u7684\u9879\u76EE\u8D21\u732E",
      language: "zh-CN",
      instructions: [
        "\u5148\u5224\u65AD\u6574\u4E2A Session \u662F\u5426\u5305\u542B\u5BF9\u6620\u5C04\u9879\u76EE\u6709\u610F\u4E49\u7684\u5B9E\u9645\u5DE5\u4F5C\uFF0C\u518D\u51B3\u5B9A\u662F\u5426\u63D0\u53D6\u3002",
        "\u53EA\u4F9D\u636E\u5B8C\u6574\u7684\u7528\u6237\u95EE\u9898\u548C\u52A9\u624B\u6700\u7EC8\u56DE\u7B54\uFF0C\u4E0D\u63A8\u65AD\u63A8\u7406\u8FC7\u7A0B\u3001\u547D\u4EE4\u3001\u5DE5\u5177\u8C03\u7528\u6216\u6587\u4EF6\u6539\u52A8\u3002",
        "\u9879\u76EE\u76EE\u5F55\u53EA\u63D0\u4F9B\u4E0A\u4E0B\u6587\uFF0C\u4E0D\u80FD\u5355\u72EC\u8BC1\u660E Session \u4E0E\u9879\u76EE\u6709\u5173\u3002",
        "\u6807\u9898\u3001\u6458\u8981\u548C\u6BCF\u6761\u8D21\u732E\u6B63\u6587\u5FC5\u987B\u4F7F\u7528\u7B80\u4F53\u4E2D\u6587\u3002",
        "\u4E0D\u5F97\u8FD4\u56DE\u539F\u59CB\u5BF9\u8BDD\u3001\u7EDD\u5BF9\u8DEF\u5F84\u3001Session \u539F\u59CB\u6807\u8BC6\u6216\u51ED\u636E\u3002"
      ],
      period: {
        key: input.period.period_key,
        startsAt: input.period.starts_at,
        endsAt: input.period.ends_at
      },
      session: { title, project, activity, turns },
      screeningPolicy: {
        includeOnlyWhenSessionContainsMeaningfulProjectContribution: true,
        qualifyingKinds: [
          "outcome",
          "progress",
          "decision",
          "blocker",
          "next_step"
        ],
        ignoreWhen: [
          "casual_conversation",
          "unrelated_to_project",
          "no_meaningful_contribution",
          "insufficient_context"
        ],
        projectDirectoryAloneIsNotEvidenceOfRelevance: true
      },
      outputRequirements: {
        ignore: {
          schemaVersion: "1.0",
          decision: "ignore",
          reason: "casual_conversation | unrelated_to_project | no_meaningful_contribution | insufficient_context"
        },
        include: {
          schemaVersion: "1.0",
          decision: "include",
          contribution: {
            ...{
              schemaVersion: "1.0",
              periodKey: input.period.period_key,
              sessionKey,
              contentHash,
              project,
              activity,
              observedAt,
              production
            },
            title: "\u7B80\u6D01\u7684\u4E2D\u6587\u5DE5\u4F5C\u6807\u9898",
            summary: "\u7B80\u6D01\u3001\u51C6\u786E\u4E14\u6709\u4E8B\u5B9E\u4F9D\u636E\u7684\u4E2D\u6587\u9879\u76EE\u8D21\u732E\u6458\u8981",
            status: "discussion | planned | in_progress | awaiting_validation | completed | blocked | cancelled",
            contributions: [
              {
                kind: "outcome | progress | decision | blocker | next_step",
                text: "\u4E00\u6761\u6709\u4E8B\u5B9E\u4F9D\u636E\u7684\u4E2D\u6587\u8D21\u732E",
                confidence: "high | medium | low"
              }
            ]
          }
        },
        neverReturnRawTranscriptOrPaths: true
      }
    }
  };
}
function firstNonChineseContributionField(contribution) {
  const containsChinese = (value) => typeof value === "string" && /[\u3400-\u4dbf\u4e00-\u9fff]/u.test(value);
  const fields = [
    ["title", contribution?.title],
    ["summary", contribution?.summary],
    ...Array.isArray(contribution?.contributions) ? contribution.contributions.map((item, index) => [
      `contributions[${index}].text`,
      item?.text
    ]) : []
  ];
  return fields.find(([, value]) => !containsChinese(value))?.[0] ?? null;
}

// src/project-scope.ts
import { createHmac, randomBytes } from "node:crypto";
import {
  chmodSync as chmodSync3,
  existsSync as existsSync4,
  realpathSync,
  renameSync as renameSync2,
  writeFileSync as writeFileSync3,
  readFileSync as readFileSync3
} from "node:fs";
import { basename as basename2, dirname as dirname2, isAbsolute as isAbsolute2, relative as relative2, resolve as resolve4 } from "node:path";
function scopePath(directory = dataDirectory()) {
  return resolve4(directory, "project-scope.json");
}
function canonicalPath(path) {
  const absolute = resolve4(path);
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}
function withinPath2(candidate, root) {
  const nested = relative2(root, candidate);
  return nested === "" || !nested.startsWith("..") && !isAbsolute2(nested);
}
function outermostGitRoot(cwd) {
  let current = canonicalPath(cwd);
  let outermost = null;
  for (; ; ) {
    if (existsSync4(resolve4(current, ".git"))) outermost = current;
    const parent = dirname2(current);
    if (parent === current) return outermost;
    current = parent;
  }
}
function newLocalScope(pluginInstanceId) {
  return {
    schemaVersion: "1.0",
    scopeSalt: randomBytes(32).toString("hex"),
    pluginInstanceId,
    identityConfirmed: false,
    version: 0,
    initialized: false,
    initializedAt: null,
    currentPeriod: null,
    entries: []
  };
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isLocalProjectScope(value, pluginInstanceId) {
  if (!isRecord(value)) return false;
  if (value.schemaVersion !== "1.0" || value.pluginInstanceId !== pluginInstanceId || typeof value.scopeSalt !== "string" || !/^[a-f0-9]{64}$/.test(value.scopeSalt) || typeof value.identityConfirmed !== "boolean" || !Number.isInteger(value.version) || value.version < 0 || typeof value.initialized !== "boolean" || value.initializedAt !== null && typeof value.initializedAt !== "string" || !Array.isArray(value.entries)) {
    return false;
  }
  return value.entries.every(
    (entry) => isRecord(entry) && typeof entry.scopeKey === "string" && /^[a-f0-9]{64}$/.test(entry.scopeKey) && typeof entry.displayName === "string" && ["pending", "allowed", "denied"].includes(String(entry.status)) && (entry.effectiveFrom === null || typeof entry.effectiveFrom === "string") && typeof entry.firstSeenPeriodKey === "string" && typeof entry.firstSeenAt === "string" && typeof entry.lastSeenAt === "string" && Number.isInteger(entry.sessionCount) && entry.sessionCount >= 0 && (entry.localRoot === null || typeof entry.localRoot === "string")
  );
}
function inspectLocalProjectScope(pluginInstanceId, directory = dataDirectory()) {
  const path = scopePath(directory);
  if (!existsSync4(path))
    return { state: "missing", scope: newLocalScope(pluginInstanceId) };
  try {
    const parsed = JSON.parse(readFileSync3(path, "utf8"));
    if (isLocalProjectScope(parsed, pluginInstanceId))
      return { state: "valid", scope: parsed };
  } catch {
  }
  return { state: "invalid", scope: newLocalScope(pluginInstanceId) };
}
function saveLocalProjectScope(scope, directory = dataDirectory()) {
  const path = scopePath(directory);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync3(temporary, `${JSON.stringify(scope, null, 2)}
`, {
    mode: 384
  });
  chmodSync3(temporary, 384);
  renameSync2(temporary, path);
  chmodSync3(path, 384);
}
function mergeRemoteProjectScope(local, remote) {
  if (local.pluginInstanceId !== remote.pluginInstanceId)
    throw new Error("\u9879\u76EE\u6743\u9650\u4E0D\u5C5E\u4E8E\u5F53\u524D Plugin Instance\u3002");
  const localRoots = new Map(
    local.entries.map((entry) => [entry.scopeKey, entry.localRoot])
  );
  return {
    schemaVersion: "1.0",
    scopeSalt: local.scopeSalt,
    ...remote,
    entries: remote.entries.map((entry) => ({
      ...entry,
      localRoot: localRoots.get(entry.scopeKey) ?? null
    }))
  };
}
function anonymousProjectScopeKey(pluginInstanceId, scopeSalt, localRoot) {
  return createHmac("sha256", scopeSalt).update(`partner-report/project-scope/v1:${pluginInstanceId}:${localRoot}`).digest("hex");
}
function discoverProjectScopes(pluginInstanceId, local, summaries) {
  const knownRoots = local.entries.filter(
    (entry) => Boolean(entry.localRoot)
  ).map((entry) => ({ ...entry, localRoot: canonicalPath(entry.localRoot) })).sort((left, right) => right.localRoot.length - left.localRoot.length);
  const discovered = /* @__PURE__ */ new Map();
  const threadScopes = /* @__PURE__ */ new Map();
  for (const summary of summaries) {
    if (!summary.cwd) continue;
    const cwd = canonicalPath(summary.cwd);
    const inherited = knownRoots.find(
      (entry) => withinPath2(cwd, entry.localRoot)
    );
    const localRoot = inherited?.localRoot ?? outermostGitRoot(cwd) ?? cwd;
    const scopeKey = inherited?.scopeKey ?? anonymousProjectScopeKey(pluginInstanceId, local.scopeSalt, localRoot);
    const current = discovered.get(scopeKey);
    discovered.set(scopeKey, {
      scopeKey,
      displayName: inherited?.displayName ?? (basename2(localRoot) || "\u672A\u547D\u540D\u9879\u76EE"),
      localRoot,
      sessionCount: (current?.sessionCount ?? 0) + 1
    });
    threadScopes.set(summary.id, scopeKey);
  }
  return { candidates: [...discovered.values()], threadScopes };
}
function mergeDiscoveredRoots(local, candidates) {
  const roots = new Map(
    candidates.map((candidate) => [candidate.scopeKey, candidate.localRoot])
  );
  return {
    ...local,
    entries: local.entries.map((entry) => ({
      ...entry,
      localRoot: roots.get(entry.scopeKey) ?? entry.localRoot
    }))
  };
}
function scopeIsActive(entry, now = /* @__PURE__ */ new Date()) {
  return Boolean(
    entry?.status === "allowed" && entry.effectiveFrom && new Date(entry.effectiveFrom).getTime() <= now.getTime()
  );
}
function authorizedProjectThreads(summaries, threadScopes, entries, now = /* @__PURE__ */ new Date()) {
  const policies = new Map(entries.map((entry) => [entry.scopeKey, entry]));
  return summaries.flatMap((summary) => {
    const scopeKey = threadScopes.get(summary.id);
    if (!scopeKey || !scopeIsActive(policies.get(scopeKey), now)) return [];
    return [{ ...summary, scopeKey }];
  });
}

// src/cli.ts
var RUN_PREFIX = "partner-report-run-";
function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  return process.argv[index + 1] ?? fallback;
}
function flag(name) {
  return process.argv.includes(`--${name}`);
}
function output(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}
`);
}
function sha2562(value) {
  return createHash2("sha256").update(value).digest("hex");
}
function compareVersions(left, right) {
  const parse = (value) => value.split(".").map((part) => Number(part.replace(/\D.*$/, "")) || 0);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0))
      return (a[index] ?? 0) - (b[index] ?? 0);
  }
  return 0;
}
async function fetchPolicy() {
  const policy = await authenticatedRequest("/v1/plugin-bindings/me");
  if (policy.team.minimum_plugin_version && compareVersions(PLUGIN_VERSION, policy.team.minimum_plugin_version) < 0) {
    throw Object.assign(
      new Error(
        `Plugin v${PLUGIN_VERSION} \u4F4E\u4E8E Team \u6700\u4F4E\u7248\u672C v${policy.team.minimum_plugin_version}\u3002`
      ),
      { code: "PLUGIN_VERSION_BLOCKED" }
    );
  }
  return policy;
}
async function fetchProjectScope() {
  return authenticatedRequest("/v1/project-scope");
}
function cacheRemoteProjectScope(remote) {
  const inspection = inspectLocalProjectScope(remote.pluginInstanceId);
  const scope = mergeRemoteProjectScope(inspection.scope, remote);
  if (inspection.state === "valid") saveLocalProjectScope(scope);
  return { ...inspection, scope };
}
function scheduledTaskConfig() {
  output({
    status: "scheduled_task_config",
    scheduledTask: SCHEDULED_COLLECTION_TASK,
    setupMode: "create_if_missing_or_repair_prompt_only"
  });
}
async function performConnectivityTest(supplied) {
  let config = loadConfig();
  try {
    const issueChallenge = async () => {
      const connectivity2 = await authenticatedRequest(
        "/v1/plugin-instances/me/connectivity-challenge",
        { method: "POST", body: "{}" }
      );
      saveConfig({
        ...config,
        connectivityStatus: "pending",
        pendingConnectivityChallenge: {
          value: connectivity2.challenge,
          expiresAt: connectivity2.challengeExpiresAt
        }
      });
      return connectivity2;
    };
    let connectivity = supplied && new Date(supplied.challengeExpiresAt).getTime() > Date.now() ? supplied : await issueChallenge();
    const submitChallenge = () => authenticatedRequest(
      "/v1/plugin-instances/me/connectivity-test",
      {
        method: "POST",
        body: JSON.stringify({
          challenge: connectivity.challenge,
          pluginVersion: PLUGIN_VERSION,
          clientTime: (/* @__PURE__ */ new Date()).toISOString(),
          capabilityVersion: "1.0"
        })
      }
    );
    let response;
    try {
      response = await submitChallenge();
    } catch (error) {
      if (!(error instanceof HttpError) || !["CHALLENGE_INVALID", "CHALLENGE_EXPIRED"].includes(error.code)) {
        throw error;
      }
      connectivity = await issueChallenge();
      response = await submitChallenge();
    }
    config = loadConfig();
    const { pendingConnectivityChallenge: _pending, ...stableConfig } = config;
    saveConfig({
      ...stableConfig,
      connectivityStatus: "verified",
      connectivityVerifiedAt: typeof response.verifiedAt === "string" ? response.verifiedAt : (/* @__PURE__ */ new Date()).toISOString()
    });
    return response;
  } catch (error) {
    config = loadConfig();
    saveConfig({ ...config, connectivityStatus: "failed" });
    throw error;
  }
}
async function setServerUrl() {
  const requestedServerUrl = option("server") ?? process.env.PARTNER_REPORT_SERVER_URL;
  if (!requestedServerUrl)
    throw new Error(
      "server-url-set \u9700\u8981 --server <url>\uFF0C\u4E5F\u53EF\u4EE5\u8BBE\u7F6E PARTNER_REPORT_SERVER_URL\u3002"
    );
  const config = loadConfig();
  const serverUrl = normalizeServerUrl(
    requestedServerUrl,
    flag("allow-insecure-http")
  );
  saveConfig({ ...config, serverUrl });
  const connectivity = await performConnectivityTest();
  output({
    status: "server_url_updated",
    serverUrl,
    pluginInstanceId: config.pluginInstanceId,
    connectivity
  });
}
function authRecoveryOutput(expiresAt) {
  output({
    status: "auth_recovery_required",
    message: "\u8FDE\u63A5\u6062\u590D\u786E\u8BA4\u5361\u5DF2\u53D1\u9001\u5230\u98DE\u4E66\u3002\u786E\u8BA4\u540E\uFF0C\u4E0B\u6B21\u8FD0\u884C\u4F1A\u81EA\u52A8\u7EE7\u7EED\u3002",
    expiresAt,
    checkpointAdvanced: false,
    counts: {
      discovered: 0,
      read: 0,
      uploaded: 0,
      ignored: 0,
      skipped: 0
    }
  });
}
function clearAuthRecovery(config) {
  const { pendingAuthRecovery: _pending, ...stableConfig } = config;
  removeSecret(config.pluginInstanceId, "recovery");
  saveConfig(stableConfig);
}
async function startAuthRecovery() {
  const config = loadConfig();
  if (config.pendingAuthRecovery) {
    authRecoveryOutput(config.pendingAuthRecovery.expiresAt);
    return;
  }
  const deviceCode = randomBytes2(32).toString("base64url");
  const recovery = await publicRequest(config.serverUrl, "/v1/plugin-bindings/recovery-authorizations", {
    method: "POST",
    body: JSON.stringify({
      pluginInstanceId: config.pluginInstanceId,
      deviceName: config.deviceName,
      pluginVersion: PLUGIN_VERSION,
      deviceCode
    })
  });
  saveSecret(config.pluginInstanceId, "recovery", deviceCode);
  saveConfig({
    ...config,
    pendingAuthRecovery: {
      requestedAt: (/* @__PURE__ */ new Date()).toISOString(),
      expiresAt: new Date(recovery.expiresAt).toISOString()
    }
  });
  authRecoveryOutput(new Date(recovery.expiresAt).toISOString());
}
async function resumeAuthRecovery() {
  let config = loadConfig();
  const pending = config.pendingAuthRecovery;
  if (!pending) return "continue";
  if (new Date(pending.expiresAt).getTime() <= Date.now()) {
    clearAuthRecovery(config);
    return "continue";
  }
  let deviceCode;
  try {
    deviceCode = loadSecret(config.pluginInstanceId, "recovery");
  } catch {
    clearAuthRecovery(config);
    return "continue";
  }
  let tokens;
  try {
    tokens = await publicRequest(
      config.serverUrl,
      "/v1/plugin-bindings/device-authorizations/token",
      {
        method: "POST",
        body: JSON.stringify({ deviceCode })
      }
    );
  } catch (error) {
    if (error instanceof HttpError && error.code === "AUTHORIZATION_PENDING") {
      authRecoveryOutput(pending.expiresAt);
      return "waiting";
    }
    if (error instanceof HttpError && ["DEVICE_CODE_EXPIRED", "DEVICE_CODE_CONSUMED"].includes(error.code)) {
      clearAuthRecovery(config);
      return "continue";
    }
    throw error;
  }
  if (tokens.pluginInstanceId !== config.pluginInstanceId)
    throw new Error("\u6062\u590D\u54CD\u5E94\u7684 Plugin Instance \u4E0D\u5339\u914D\u3002");
  saveSecret(config.pluginInstanceId, "access", tokens.accessToken);
  saveSecret(config.pluginInstanceId, "refresh", tokens.refreshToken);
  removeSecret(config.pluginInstanceId, "recovery");
  const { pendingAuthRecovery: _pending, ...stableConfig } = config;
  saveConfig({
    ...stableConfig,
    accessExpiresAt: tokens.expiresAt,
    connectivityStatus: "pending",
    pendingConnectivityChallenge: {
      value: tokens.challenge,
      expiresAt: tokens.challengeExpiresAt
    }
  });
  await performConnectivityTest(tokens);
  return "continue";
}
function connectedOutput(partnerId, deviceName, connectivity) {
  const config = loadConfig();
  output({
    status: "connected",
    pluginInstanceId: config.pluginInstanceId,
    partnerId,
    deviceName,
    connectivity,
    scheduledTask: SCHEDULED_COLLECTION_TASK,
    nextStep: "\u4F7F\u7528 $partner-report-sync \u521B\u5EFA\u6216\u4FEE\u590D\u540C\u540D Codex Scheduled Task\u3002"
  });
}
async function connect() {
  const requestedServerUrl = option("server") ?? process.env.PARTNER_REPORT_SERVER_URL;
  if (!requestedServerUrl)
    throw new Error(
      "connect \u9700\u8981 --server <url>\uFF0C\u4E5F\u53EF\u4EE5\u8BBE\u7F6E PARTNER_REPORT_SERVER_URL\u3002"
    );
  const bindingCode = option("binding-code") ?? process.env.PARTNER_REPORT_BINDING_CODE;
  if (!bindingCode)
    throw new Error("connect \u9700\u8981 Admin \u751F\u6210\u7684 --binding-code <code>\u3002");
  const serverUrl = normalizeServerUrl(
    requestedServerUrl,
    flag("allow-insecure-http")
  );
  const deviceName = option("device-name", hostname());
  const tokens = await publicRequest(
    serverUrl,
    "/v1/plugin-bindings/claim",
    {
      method: "POST",
      body: JSON.stringify({
        bindingCode,
        deviceName,
        pluginVersion: PLUGIN_VERSION
      })
    }
  );
  const existing = loadConfig(false);
  if (existing && existing.pluginInstanceId !== tokens.pluginInstanceId)
    removeSecrets(existing.pluginInstanceId);
  saveSecret(tokens.pluginInstanceId, "access", tokens.accessToken);
  saveSecret(tokens.pluginInstanceId, "refresh", tokens.refreshToken);
  saveConfig({
    serverUrl,
    pluginInstanceId: tokens.pluginInstanceId,
    deviceName,
    accessExpiresAt: tokens.expiresAt,
    connectivityStatus: "pending",
    pendingConnectivityChallenge: {
      value: tokens.challenge,
      expiresAt: tokens.challengeExpiresAt
    },
    excludedSessionIds: existing?.excludedSessionIds ?? [],
    excludedPaths: existing?.excludedPaths ?? []
  });
  const connectivity = await performConnectivityTest(tokens);
  connectedOutput(tokens.partnerId, deviceName, connectivity);
}
async function connectivityTest() {
  const config = loadConfig();
  const pending = config.pendingConnectivityChallenge;
  const connectivity = await performConnectivityTest(
    pending ? {
      challenge: pending.value,
      challengeExpiresAt: pending.expiresAt,
      capabilityVersion: "1.0"
    } : void 0
  );
  const policy = await fetchPolicy();
  connectedOutput(policy.partnerId, config.deviceName, connectivity);
}
function summaryFromThread(value) {
  if (!value?.id) return null;
  const title = typeof value.name === "string" ? value.name : typeof value.title === "string" ? value.title : null;
  return {
    id: String(value.id),
    title,
    cwd: typeof value.cwd === "string" ? value.cwd : null,
    updatedAt: value.updatedAt ?? value.updated_at ?? value.createdAt ?? null
  };
}
function createRun(manifest) {
  const runDirectory = mkdtempSync(resolve5(tmpdir(), RUN_PREFIX));
  chmodSync4(runDirectory, 448);
  const runPath = resolve5(runDirectory, "run.json");
  writeFileSync4(runPath, `${JSON.stringify(manifest, null, 2)}
`, {
    mode: 384
  });
  chmodSync4(runPath, 384);
  return runPath;
}
function assertRunPath(runPath) {
  const absolute = resolve5(runPath);
  const runDirectory = dirname3(absolute);
  const outsideTemp = relative3(resolve5(tmpdir()), runDirectory).startsWith(
    ".."
  );
  if (outsideTemp || !basename3(runDirectory).startsWith(RUN_PREFIX) || basename3(absolute) !== "run.json") {
    throw new Error("Run \u8DEF\u5F84\u4E0D\u5C5E\u4E8E Partner Report \u4E34\u65F6\u76EE\u5F55\u3002");
  }
  return absolute;
}
function readRun(runPath) {
  const absolute = assertRunPath(runPath);
  const manifest = JSON.parse(readFileSync4(absolute, "utf8"));
  const config = loadConfig();
  if (manifest.schemaVersion !== "1.0" || manifest.pluginInstanceId !== config.pluginInstanceId) {
    throw new Error("Run \u6E05\u5355\u65E0\u6548\u6216\u4E0D\u5C5E\u4E8E\u5F53\u524D Plugin Instance\u3002");
  }
  refreshCollectionLease(manifest.pluginInstanceId, manifest.runId);
  return { absolute, manifest };
}
function saveRun(runPath, manifest) {
  writeFileSync4(runPath, `${JSON.stringify(manifest, null, 2)}
`, {
    mode: 384
  });
  chmodSync4(runPath, 384);
}
function removeJobFiles(runPath, current) {
  const runDirectory = dirname3(runPath);
  for (const path of [current.inputPath, current.resultPath]) {
    if (dirname3(resolve5(path)) !== runDirectory)
      throw new Error("Job \u6587\u4EF6\u4E0D\u5C5E\u4E8E\u5F53\u524D Run\u3002");
    if (existsSync5(path)) unlinkSync2(path);
  }
}
function writeJob(runPath, jobId, modelInput) {
  const runDirectory = dirname3(runPath);
  const inputPath = resolve5(runDirectory, `${jobId}-input.json`);
  const resultPath = resolve5(runDirectory, `${jobId}-result.json`);
  writeFileSync4(inputPath, `${JSON.stringify(modelInput, null, 2)}
`, {
    mode: 384
  });
  chmodSync4(inputPath, 384);
  return { inputPath, resultPath };
}
async function postCollectionStatus(config, manifest, phase) {
  const { counts } = manifest;
  const lastSyncAt = counts.uploaded > 0 ? (/* @__PURE__ */ new Date()).toISOString() : void 0;
  const coverage = {
    discovered: counts.discovered,
    eligible: counts.eligible,
    readable: counts.read,
    extracted: counts.uploaded + counts.unchanged,
    deferred: counts.outsideWindow,
    failedRead: counts.failedRead,
    failedExtract: counts.failedExtract,
    excluded: counts.excluded + counts.ignored + counts.cachedIgnored,
    pendingSync: phase === "completed" ? 0 : manifest.queue.length,
    activeAtCutoff: 0,
    hookMissed: 0,
    warnings: canAdvanceCollectionCheckpoint(counts) ? [] : ["PARTIAL_COLLECTION_RETRY_REQUIRED"],
    ...lastSyncAt ? { lastSyncAt } : {}
  };
  await authenticatedRequest("/v1/plugin-instances/me/collection-status", {
    method: "POST",
    body: JSON.stringify({
      pluginVersion: PLUGIN_VERSION,
      deviceName: config.deviceName,
      phase,
      periodKey: manifest.period.period_key,
      sessionCount: counts.uploaded + counts.unchanged,
      factCount: counts.uploaded + counts.unchanged,
      pendingLocalJobs: phase === "completed" ? 0 : manifest.queue.length,
      discoveredCount: counts.discovered,
      eligibleCount: counts.eligible,
      excludedCount: counts.excluded + counts.ignored + counts.cachedIgnored,
      lastScanAt: manifest.createdAt,
      ...lastSyncAt ? { lastSyncAt } : {},
      coverage
    })
  });
}
async function collectStart() {
  const config = loadConfig();
  const localInspection = inspectLocalProjectScope(config.pluginInstanceId);
  const requiresProjectScopeBootstrap = localInspection.state !== "valid";
  const [policy, remoteScope] = await Promise.all([
    fetchPolicy(),
    fetchProjectScope()
  ]);
  if (!policy.currentPeriod)
    throw Object.assign(new Error("\u5F53\u524D Team \u6CA1\u6709\u5F00\u653E\u7684 Report Period\u3002"), {
      code: "REPORT_PERIOD_MISSING"
    });
  if (!remoteScope.identityConfirmed)
    return output({
      status: "feishu_identity_confirmation_required",
      periodKey: policy.currentPeriod.period_key,
      read: 0,
      uploaded: 0,
      discovered: 0,
      message: "\u8BF7\u5148\u5728\u98DE\u4E66\u8EAB\u4EFD\u5361\u4E2D\u786E\u8BA4\u5BA1\u6838\u8EAB\u4EFD\u3002\u786E\u8BA4\u524D\u4E0D\u4F1A\u626B\u63CF\u9879\u76EE\u6216\u8BFB\u53D6 Session \u5185\u5BB9\u3002"
    });
  let localScope;
  if (!requiresProjectScopeBootstrap) {
    localScope = mergeRemoteProjectScope(localInspection.scope, remoteScope);
    saveLocalProjectScope(localScope);
  } else {
    const bootstrapScope = await authenticatedRequest(
      "/v1/project-scope/bootstrap",
      {
        method: "POST",
        body: JSON.stringify({
          baseVersion: remoteScope.version,
          reason: localInspection.state === "missing" ? "local_scope_missing" : "local_scope_invalid"
        })
      }
    );
    localScope = mergeRemoteProjectScope(localInspection.scope, bootstrapScope);
    saveLocalProjectScope(localScope);
  }
  const runId = randomUUID();
  const runStartedAt = (/* @__PURE__ */ new Date()).toISOString();
  acquireCollectionLease(config.pluginInstanceId, runId);
  let localState;
  let window;
  try {
    localState = loadCollectionState(config.pluginInstanceId);
    initializeCollectionFloor(
      localState,
      policy.currentPeriod.starts_at,
      runStartedAt
    );
    saveCollectionState(localState);
    window = collectionWindow(localState, policy.currentPeriod, runStartedAt);
  } catch (error) {
    releaseCollectionLease(config.pluginInstanceId, runId);
    throw error;
  }
  const effectivePeriod = {
    period_key: policy.currentPeriod.period_key,
    starts_at: window.extractionStartsAt,
    ends_at: window.extractionEndsAt
  };
  const server = new CodexAppServer();
  let listed;
  try {
    await server.connect();
    listed = await server.listThreads();
  } catch (error) {
    releaseCollectionLease(config.pluginInstanceId, runId);
    throw error;
  } finally {
    server.close();
  }
  const summaries = listed.map(summaryFromThread).filter((value) => Boolean(value));
  const excludedSessionIds = new Set(config.excludedSessionIds ?? []);
  const currentSessionId = process.env.CODEX_THREAD_ID;
  const metadataEligible = summaries.filter(
    (summary) => summary.id !== currentSessionId && !excludedSessionIds.has(summary.id) && !pathIsExcluded(summary.cwd, config.excludedPaths ?? []) && !isPluginSystemThread(summary)
  );
  const inWindow = flag("force") ? metadataEligible : metadataEligible.filter(
    (summary) => threadIsInScanWindow(
      summary.updatedAt,
      window.scanStartsAt,
      window.scanEndsAt
    )
  );
  const permissionDiscoverySummaries = requiresProjectScopeBootstrap ? metadataEligible.filter(
    (summary) => threadIsInScanWindow(
      summary.updatedAt,
      policy.currentPeriod.starts_at,
      window.scanEndsAt
    )
  ) : inWindow;
  const discovery = discoverProjectScopes(
    config.pluginInstanceId,
    localScope,
    permissionDiscoverySummaries
  );
  let registeredScope;
  try {
    registeredScope = await authenticatedRequest(
      "/v1/project-scope/candidates",
      {
        method: "POST",
        body: JSON.stringify({
          periodKey: policy.currentPeriod.period_key,
          candidates: discovery.candidates.map((candidate) => ({
            scopeKey: candidate.scopeKey,
            displayName: candidate.displayName,
            sessionCount: candidate.sessionCount
          }))
        })
      }
    );
  } catch (error) {
    releaseCollectionLease(config.pluginInstanceId, runId);
    throw error;
  }
  localScope = mergeDiscoveredRoots(
    mergeRemoteProjectScope(localScope, registeredScope),
    discovery.candidates
  );
  saveLocalProjectScope(localScope);
  const queue = authorizedProjectThreads(
    inWindow,
    discovery.threadScopes,
    localScope.entries
  );
  if (!localScope.initialized) {
    releaseCollectionLease(config.pluginInstanceId, runId);
    return output({
      status: "project_scope_approval_required",
      periodKey: policy.currentPeriod.period_key,
      policyVersion: localScope.version,
      pendingProjects: localScope.entries.filter(
        (entry) => entry.status === "pending"
      ).length,
      read: 0,
      uploaded: 0,
      message: "\u9879\u76EE\u91C7\u96C6\u8303\u56F4\u5C1A\u672A\u5BA1\u6279\uFF0C\u672A\u8BFB\u53D6\u4EFB\u4F55 Session \u5185\u5BB9\u3002\u8BF7\u5728\u98DE\u4E66\u5361\u7247\u4E2D\u5B8C\u6210\u5BA1\u6279\u3002"
    });
  }
  let state;
  try {
    state = await authenticatedRequest(
      `/v1/session-contributions/state?periodKey=${encodeURIComponent(policy.currentPeriod.period_key)}`
    );
  } catch (error) {
    releaseCollectionLease(config.pluginInstanceId, runId);
    throw error;
  }
  const knownSessions = buildKnownSessionIndex({
    remoteAccepted: state.sessions,
    localAccepted: localState.acceptedSessions,
    localIgnored: localState.ignoredSessions
  });
  const manifest = {
    schemaVersion: "1.0",
    runId,
    pluginInstanceId: config.pluginInstanceId,
    createdAt: runStartedAt,
    force: flag("force"),
    period: effectivePeriod,
    projects: policy.projects,
    queue,
    cursor: 0,
    knownSessions,
    counts: {
      discovered: summaries.length,
      read: 0,
      eligible: 0,
      uploaded: 0,
      ignored: 0,
      unchanged: 0,
      cachedIgnored: 0,
      outsideWindow: metadataEligible.length - inWindow.length,
      excluded: summaries.length - metadataEligible.length + (inWindow.length - queue.length),
      failedRead: 0,
      failedExtract: 0
    },
    current: null
  };
  let runPath = null;
  try {
    runPath = createRun(manifest);
    await postCollectionStatus(config, manifest, "started");
  } catch (error) {
    if (runPath) rmSync(dirname3(runPath), { recursive: true, force: true });
    releaseCollectionLease(config.pluginInstanceId, runId);
    throw error;
  }
  output({
    status: "started",
    runPath,
    periodKey: manifest.period.period_key,
    collectionStartsAt: manifest.period.starts_at,
    collectionEndsAt: manifest.period.ends_at,
    scanStartsAt: window.scanStartsAt,
    scanEndsAt: window.scanEndsAt,
    discovered: manifest.counts.discovered,
    queued: manifest.queue.length,
    outsideWindow: manifest.counts.outsideWindow,
    excluded: manifest.counts.excluded,
    nextCommand: `collect-next --run ${runPath}`
  });
}
function currentJobOutput(runPath, current) {
  output({
    status: "job",
    runPath,
    jobId: current.jobId,
    inputPath: current.inputPath,
    resultPath: current.resultPath,
    resultSchema: resolve5(
      import.meta.dirname,
      "../schemas/session-extraction-result-v1.json"
    ),
    nextCommand: `collect-submit --run ${runPath} --result ${current.resultPath}`
  });
}
async function finishRun(runPath, manifest, config) {
  await postCollectionStatus(config, manifest, "completed");
  const checkpointAdvanced = canAdvanceCollectionCheckpoint(manifest.counts);
  if (checkpointAdvanced) {
    const state = loadCollectionState(manifest.pluginInstanceId);
    state.lastSuccessfulRunStartedAt = manifest.createdAt;
    saveCollectionState(state);
  }
  const summary = {
    status: "completed",
    reviewed: true,
    periodKey: manifest.period.period_key,
    collectionStartsAt: manifest.period.starts_at,
    collectionEndsAt: manifest.period.ends_at,
    checkpointAdvanced,
    warnings: checkpointAdvanced ? [] : ["PARTIAL_COLLECTION_RETRY_REQUIRED"],
    ...manifest.counts
  };
  releaseCollectionLease(manifest.pluginInstanceId, manifest.runId);
  rmSync(dirname3(runPath), { recursive: true, force: true });
  output(summary);
}
function completionReview(manifest) {
  return reviewCollectionCompletion({
    cursor: manifest.cursor,
    queueLength: manifest.queue.length,
    hasCurrentJob: manifest.current !== null,
    counts: manifest.counts
  });
}
async function collectNext() {
  const runPath = option("run");
  if (!runPath) throw new Error("collect-next \u9700\u8981 --run <path>\u3002");
  const { absolute, manifest } = readRun(runPath);
  if (manifest.current) return currentJobOutput(absolute, manifest.current);
  const server = new CodexAppServer();
  try {
    await server.connect();
    while (manifest.cursor < manifest.queue.length) {
      const summary = manifest.queue[manifest.cursor++];
      let thread;
      try {
        thread = await server.readThread(summary.id);
        manifest.counts.read += 1;
      } catch {
        manifest.counts.failedRead += 1;
        saveRun(absolute, manifest);
        continue;
      }
      const job = buildSessionJob({
        pluginInstanceId: manifest.pluginInstanceId,
        sessionId: summary.id,
        title: thread.name ?? summary.title,
        cwd: thread.cwd ?? summary.cwd,
        updatedAt: thread.updatedAt ?? summary.updatedAt,
        turns: Array.isArray(thread.turns) ? thread.turns : [],
        projects: manifest.projects,
        period: manifest.period
      });
      if (!job) {
        manifest.counts.excluded += 1;
        saveRun(absolute, manifest);
        continue;
      }
      manifest.counts.eligible += 1;
      const known = manifest.knownSessions[job.sessionKey];
      const compatibleContentHashes = /* @__PURE__ */ new Set([
        job.contentHash,
        ...job.compatibleContentHashes
      ]);
      const knownDecision = manifest.force ? null : matchingKnownDecision(known, compatibleContentHashes);
      if (knownDecision) {
        const state = loadCollectionState(manifest.pluginInstanceId);
        if (knownDecision === "accepted")
          recordAcceptedSession(state, job.sessionKey, job.contentHash);
        else recordIgnoredSession(state, job.sessionKey, job.contentHash);
        saveCollectionState(state);
        if (knownDecision === "accepted") manifest.counts.unchanged += 1;
        else manifest.counts.cachedIgnored += 1;
        saveRun(absolute, manifest);
        continue;
      }
      const jobId = randomUUID();
      const paths = writeJob(absolute, jobId, job.modelInput);
      manifest.current = { jobId, ...paths, expected: job.expected };
      saveRun(absolute, manifest);
      return currentJobOutput(absolute, manifest.current);
    }
  } finally {
    server.close();
  }
  output({
    status: "review_required",
    runPath: absolute,
    review: completionReview(manifest),
    nextCommand: `collect-review --run ${absolute}`
  });
}
async function collectReview() {
  const runPath = option("run");
  if (!runPath) throw new Error("collect-review \u9700\u8981 --run <path>\u3002");
  const { absolute, manifest } = readRun(runPath);
  const review = completionReview(manifest);
  if (!review.readyToFinalize) {
    return output({
      status: "review_failed",
      runPath: absolute,
      review,
      nextCommand: `collect-next --run ${absolute}`
    });
  }
  await finishRun(absolute, manifest, loadConfig());
}
function assertImmutableContribution(contribution, expected) {
  for (const key of [
    "schemaVersion",
    "periodKey",
    "sessionKey",
    "contentHash",
    "project",
    "activity",
    "observedAt"
  ]) {
    if (!isDeepStrictEqual(contribution[key], expected[key]))
      throw new Error(`\u6A21\u578B\u4FEE\u6539\u4E86\u4E0D\u53EF\u53D8\u5B57\u6BB5 contribution.${key}\u3002`);
  }
  const { modelVersion: _actualModel, ...actualProduction } = contribution.production;
  if (!isDeepStrictEqual(actualProduction, expected.production))
    throw new Error("\u6A21\u578B\u4FEE\u6539\u4E86\u4E0D\u53EF\u53D8\u5B57\u6BB5 contribution.production\u3002");
  if (contribution.contributions.length === 0)
    throw new Error("include \u7ED3\u679C\u5FC5\u987B\u81F3\u5C11\u5305\u542B\u4E00\u6761\u6709\u4EF7\u503C\u7684\u9879\u76EE\u8D21\u732E\u3002");
}
function assertChineseContribution(contribution) {
  const invalid = firstNonChineseContributionField(contribution);
  if (invalid) {
    throw Object.assign(new Error(`\u4E0A\u4F20\u5B57\u6BB5 ${invalid} \u5FC5\u987B\u4F7F\u7528\u4E2D\u6587\u3002`), {
      code: "CHINESE_OUTPUT_REQUIRED"
    });
  }
}
async function collectSubmit() {
  const runPath = option("run");
  const resultPath = option("result");
  if (!runPath || !resultPath)
    throw new Error("collect-submit \u9700\u8981 --run <path> --result <path>\u3002");
  const { absolute, manifest } = readRun(runPath);
  const current = manifest.current;
  if (!current) throw new Error("\u5F53\u524D Run \u6CA1\u6709\u5F85\u63D0\u4EA4 Job\u3002");
  if (resolve5(resultPath) !== resolve5(current.resultPath))
    throw new Error("Result \u8DEF\u5F84\u4E0E\u5F53\u524D Job \u4E0D\u5339\u914D\u3002");
  const result = sessionExtractionResultSchema.parse(
    JSON.parse(readFileSync4(current.resultPath, "utf8"))
  );
  if (result.decision === "ignore") {
    const state2 = loadCollectionState(manifest.pluginInstanceId);
    recordIgnoredSession(
      state2,
      current.expected.sessionKey,
      current.expected.contentHash
    );
    saveCollectionState(state2);
    removeJobFiles(absolute, current);
    manifest.counts.ignored += 1;
    manifest.knownSessions[current.expected.sessionKey] = {
      contentHashes: [current.expected.contentHash],
      decision: "ignored"
    };
    manifest.current = null;
    saveRun(absolute, manifest);
    return output({
      status: "ignored",
      reason: result.reason,
      nextCommand: `collect-next --run ${absolute}`
    });
  }
  assertImmutableContribution(result.contribution, current.expected);
  assertChineseContribution(result.contribution);
  if (containsSensitive(result.contribution))
    throw Object.assign(new Error("\u8D21\u732E\u7ED3\u679C\u5305\u542B\u7591\u4F3C\u654F\u611F\u503C\uFF0C\u5DF2\u963B\u6B62\u4E0A\u4F20\u3002"), {
      code: "SENSITIVE_EGRESS_REJECTED"
    });
  const idempotencyKey = sha2562(
    `${result.contribution.sessionKey}:${result.contribution.periodKey}:${result.contribution.contentHash}`
  );
  const response = await authenticatedRequest(
    "/v1/session-contributions",
    {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body: JSON.stringify(result.contribution)
    }
  );
  const state = loadCollectionState(manifest.pluginInstanceId);
  recordAcceptedSession(
    state,
    result.contribution.sessionKey,
    result.contribution.contentHash
  );
  saveCollectionState(state);
  removeJobFiles(absolute, current);
  manifest.counts.uploaded += 1;
  manifest.knownSessions[result.contribution.sessionKey] = {
    contentHashes: [result.contribution.contentHash],
    decision: "accepted"
  };
  manifest.current = null;
  saveRun(absolute, manifest);
  output({
    status: "uploaded",
    response,
    nextCommand: `collect-next --run ${absolute}`
  });
}
function collectSkip() {
  const runPath = option("run");
  if (!runPath) throw new Error("collect-skip \u9700\u8981 --run <path>\u3002");
  const { absolute, manifest } = readRun(runPath);
  const current = manifest.current;
  if (!current) throw new Error("\u5F53\u524D Run \u6CA1\u6709\u5F85\u8DF3\u8FC7 Job\u3002");
  removeJobFiles(absolute, current);
  manifest.counts.failedExtract += 1;
  manifest.current = null;
  saveRun(absolute, manifest);
  output({
    status: "skipped",
    errorCode: option("error-code", "EXTRACT_FAILED"),
    nextCommand: `collect-next --run ${absolute}`
  });
}
async function status() {
  const config = loadConfig(false);
  if (!config) return output({ status: "not_connected" });
  const [policy, remoteScope] = await Promise.all([
    fetchPolicy(),
    fetchProjectScope()
  ]);
  const projectScope = cacheRemoteProjectScope(remoteScope);
  const localState = loadCollectionState(config.pluginInstanceId);
  const state = policy.currentPeriod ? await authenticatedRequest(
    `/v1/session-contributions/state?periodKey=${encodeURIComponent(policy.currentPeriod.period_key)}`
  ) : { sessions: [] };
  output({
    status: "connected",
    pluginVersion: PLUGIN_VERSION,
    deviceName: config.deviceName,
    connectivityStatus: config.connectivityStatus ?? "pending",
    periodKey: policy.currentPeriod?.period_key ?? null,
    acceptedSessionCount: state.sessions.length,
    localAcceptedSessionCount: Object.keys(localState.acceptedSessions).length,
    ignoredSessionCount: Object.keys(localState.ignoredSessions).length,
    collectionFloorAt: localState.collectionFloorAt,
    lastSuccessfulRunStartedAt: localState.lastSuccessfulRunStartedAt,
    excludedSessionCount: config.excludedSessionIds.length,
    excludedPathCount: config.excludedPaths.length,
    projectScopeLocalState: projectScope.state,
    projectScopeVersion: projectScope.scope.version,
    projectScopeInitialized: projectScope.state === "valid" && projectScope.scope.initialized,
    projectScopeRequiresApproval: projectScope.state !== "valid" || !projectScope.scope.initialized,
    allowedProjectCount: projectScope.state === "valid" ? projectScope.scope.entries.filter((entry) => scopeIsActive(entry)).length : 0,
    pendingProjectCount: projectScope.scope.entries.filter(
      (entry) => entry.status === "pending"
    ).length,
    deniedProjectCount: projectScope.scope.entries.filter(
      (entry) => entry.status === "denied"
    ).length
  });
}
async function projectScopeList() {
  const remote = await fetchProjectScope();
  const local = cacheRemoteProjectScope(remote);
  output({
    status: "project_scope",
    localState: local.state,
    version: local.scope.version,
    initialized: local.scope.initialized,
    requiresApproval: local.state !== "valid" || !local.scope.initialized,
    projects: local.scope.entries.map((entry) => ({
      scopeKey: entry.scopeKey,
      name: entry.displayName,
      permission: entry.status,
      active: scopeIsActive(entry),
      effectiveFrom: entry.effectiveFrom,
      firstSeenPeriodKey: entry.firstSeenPeriodKey,
      sessionCount: entry.sessionCount
    }))
  });
}
async function changeProjectScope(decision) {
  const config = loadConfig();
  const localInspection = inspectLocalProjectScope(config.pluginInstanceId);
  if (localInspection.state !== "valid")
    throw Object.assign(
      new Error("\u672C\u5730\u91C7\u96C6\u6743\u9650\u5C1A\u672A\u5EFA\u7ACB\uFF0C\u8BF7\u5148\u8FD0\u884C\u91C7\u96C6\u5E76\u5728\u98DE\u4E66\u5B8C\u6210\u9996\u6B21\u5BA1\u6279\u3002"),
      { code: "PROJECT_SCOPE_APPROVAL_REQUIRED" }
    );
  const remote = await fetchProjectScope();
  const scopeKey = option("scope-key")?.trim();
  const projectName = option("project")?.trim().toLocaleLowerCase("zh-CN");
  let selected = remote.entries.filter((entry) => {
    if (flag("all-pending")) return entry.status === "pending";
    if (scopeKey) return entry.scopeKey === scopeKey;
    if (projectName)
      return entry.displayName.toLocaleLowerCase("zh-CN") === projectName;
    return false;
  });
  if (!scopeKey && !projectName && !flag("all-pending"))
    throw new Error(
      "\u9700\u8981 --project <\u9879\u76EE\u540D>\u3001--scope-key <key> \u6216 --all-pending\u3002"
    );
  if (projectName && selected.length > 1)
    throw new Error(
      "\u5B58\u5728\u540C\u540D\u9879\u76EE\uFF0C\u8BF7\u5148 project-scope-list\uFF0C\u518D\u7528 --scope-key \u6307\u5B9A\u3002"
    );
  if (selected.length === 0) throw new Error("\u6CA1\u6709\u627E\u5230\u5339\u914D\u7684\u9879\u76EE\u6743\u9650\u3002");
  selected = selected.slice(0, 500);
  const updated = await authenticatedRequest(
    "/v1/project-scope",
    {
      method: "PATCH",
      body: JSON.stringify({
        baseVersion: remote.version,
        decisions: selected.map((entry) => ({
          scopeKey: entry.scopeKey,
          decision
        }))
      })
    }
  );
  saveLocalProjectScope(
    mergeRemoteProjectScope(localInspection.scope, updated)
  );
  output({
    status: "project_scope_updated",
    decision,
    version: updated.version,
    projects: selected.map((entry) => ({
      scopeKey: entry.scopeKey,
      name: entry.displayName
    }))
  });
}
function configureExclusion(kind, remove = false) {
  const config = loadConfig();
  const raw = option(kind === "session" ? "session-id" : "path");
  if (!raw)
    throw new Error(
      kind === "session" ? "\u9700\u8981 --session-id <id>\u3002" : "\u9700\u8981 --path <absolute-path>\u3002"
    );
  const value = kind === "path" ? resolve5(raw) : raw.trim();
  const key = kind === "session" ? "excludedSessionIds" : "excludedPaths";
  const current = new Set(config[key] ?? []);
  if (remove) current.delete(value);
  else current.add(value);
  saveConfig({ ...config, [key]: [...current].sort() });
  output({
    status: remove ? "exclusion_removed" : "excluded",
    kind,
    value
  });
}
function help() {
  output({
    commands: [
      "connect --server <url> --binding-code <code> [--device-name <name>] [--allow-insecure-http]",
      "connectivity-test",
      "server-url-set --server <url> [--allow-insecure-http]",
      "scheduled-task-config",
      "collect-start [--force]",
      "collect-next --run <path>",
      "collect-review --run <path>",
      "collect-submit --run <path> --result <path>",
      "collect-skip --run <path> [--error-code <code>]",
      "status",
      "project-scope-list",
      "project-scope-allow --project <name>|--scope-key <key>|--all-pending",
      "project-scope-deny --project <name>|--scope-key <key>|--all-pending",
      "exclude-session --session-id <id>",
      "include-session --session-id <id>",
      "exclude-path --path <absolute-path>",
      "include-path --path <absolute-path>"
    ]
  });
}
var command = process.argv[2] ?? "help";
var recoveryAwareCommands = /* @__PURE__ */ new Set([
  "connectivity-test",
  "server-url-set",
  "collect-start",
  "daily-collect",
  "collect-next",
  "collect-review",
  "collect-submit",
  "status",
  "project-scope-list",
  "project-scope-allow",
  "project-scope-deny"
]);
var recoveryResumeCommands = new Set(
  [...recoveryAwareCommands].filter((value) => value !== "server-url-set")
);
async function runCommand() {
  if (recoveryResumeCommands.has(command) && await resumeAuthRecovery() === "waiting")
    return;
  if (command === "connect") await connect();
  else if (command === "connectivity-test") await connectivityTest();
  else if (command === "server-url-set") await setServerUrl();
  else if (command === "scheduled-task-config") scheduledTaskConfig();
  else if (command === "collect-start" || command === "daily-collect")
    await collectStart();
  else if (command === "collect-next") await collectNext();
  else if (command === "collect-review") await collectReview();
  else if (command === "collect-submit") await collectSubmit();
  else if (command === "collect-skip") collectSkip();
  else if (command === "status") await status();
  else if (command === "project-scope-list") await projectScopeList();
  else if (command === "project-scope-allow") await changeProjectScope("allow");
  else if (command === "project-scope-deny") await changeProjectScope("deny");
  else if (command === "exclude-session") configureExclusion("session");
  else if (command === "include-session") configureExclusion("session", true);
  else if (command === "exclude-path") configureExclusion("path");
  else if (command === "include-path") configureExclusion("path", true);
  else help();
}
try {
  await runCommand();
} catch (error) {
  if (recoveryAwareCommands.has(command) && error instanceof HttpError && error.code === "REFRESH_TOKEN_INVALID") {
    try {
      await startAuthRecovery();
    } catch (recoveryError) {
      const recoveryCode = recoveryError instanceof HttpError ? recoveryError.code : "AUTH_RECOVERY_START_FAILED";
      process.stderr.write(
        `${JSON.stringify({
          status: "error",
          code: recoveryCode,
          message: recoveryError instanceof Error ? recoveryError.message : String(recoveryError)
        })}
`
      );
      process.exitCode = 1;
    }
  } else {
    const code = error instanceof HttpError ? error.code : error && typeof error === "object" && "code" in error ? String(error.code) : "PLUGIN_COMMAND_FAILED";
    process.stderr.write(
      `${JSON.stringify({
        status: "error",
        code,
        message: error instanceof Error ? error.message : String(error)
      })}
`
    );
    process.exitCode = 1;
  }
}
