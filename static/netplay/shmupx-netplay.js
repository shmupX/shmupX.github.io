var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// spacetimedb/module/node_modules/base64-js/index.js
var require_base64_js = __commonJS({
  "spacetimedb/module/node_modules/base64-js/index.js"(exports) {
    "use strict";
    exports.byteLength = byteLength;
    exports.toByteArray = toByteArray;
    exports.fromByteArray = fromByteArray2;
    var lookup = [];
    var revLookup = [];
    var Arr = typeof Uint8Array !== "undefined" ? Uint8Array : Array;
    var code = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    for (i = 0, len = code.length; i < len; ++i) {
      lookup[i] = code[i];
      revLookup[code.charCodeAt(i)] = i;
    }
    var i;
    var len;
    revLookup["-".charCodeAt(0)] = 62;
    revLookup["_".charCodeAt(0)] = 63;
    function getLens(b64) {
      var len2 = b64.length;
      if (len2 % 4 > 0) {
        throw new Error("Invalid string. Length must be a multiple of 4");
      }
      var validLen = b64.indexOf("=");
      if (validLen === -1) validLen = len2;
      var placeHoldersLen = validLen === len2 ? 0 : 4 - validLen % 4;
      return [validLen, placeHoldersLen];
    }
    function byteLength(b64) {
      var lens = getLens(b64);
      var validLen = lens[0];
      var placeHoldersLen = lens[1];
      return (validLen + placeHoldersLen) * 3 / 4 - placeHoldersLen;
    }
    function _byteLength(b64, validLen, placeHoldersLen) {
      return (validLen + placeHoldersLen) * 3 / 4 - placeHoldersLen;
    }
    function toByteArray(b64) {
      var tmp;
      var lens = getLens(b64);
      var validLen = lens[0];
      var placeHoldersLen = lens[1];
      var arr = new Arr(_byteLength(b64, validLen, placeHoldersLen));
      var curByte = 0;
      var len2 = placeHoldersLen > 0 ? validLen - 4 : validLen;
      var i2;
      for (i2 = 0; i2 < len2; i2 += 4) {
        tmp = revLookup[b64.charCodeAt(i2)] << 18 | revLookup[b64.charCodeAt(i2 + 1)] << 12 | revLookup[b64.charCodeAt(i2 + 2)] << 6 | revLookup[b64.charCodeAt(i2 + 3)];
        arr[curByte++] = tmp >> 16 & 255;
        arr[curByte++] = tmp >> 8 & 255;
        arr[curByte++] = tmp & 255;
      }
      if (placeHoldersLen === 2) {
        tmp = revLookup[b64.charCodeAt(i2)] << 2 | revLookup[b64.charCodeAt(i2 + 1)] >> 4;
        arr[curByte++] = tmp & 255;
      }
      if (placeHoldersLen === 1) {
        tmp = revLookup[b64.charCodeAt(i2)] << 10 | revLookup[b64.charCodeAt(i2 + 1)] << 4 | revLookup[b64.charCodeAt(i2 + 2)] >> 2;
        arr[curByte++] = tmp >> 8 & 255;
        arr[curByte++] = tmp & 255;
      }
      return arr;
    }
    function tripletToBase64(num) {
      return lookup[num >> 18 & 63] + lookup[num >> 12 & 63] + lookup[num >> 6 & 63] + lookup[num & 63];
    }
    function encodeChunk(uint8, start, end) {
      var tmp;
      var output = [];
      for (var i2 = start; i2 < end; i2 += 3) {
        tmp = (uint8[i2] << 16 & 16711680) + (uint8[i2 + 1] << 8 & 65280) + (uint8[i2 + 2] & 255);
        output.push(tripletToBase64(tmp));
      }
      return output.join("");
    }
    function fromByteArray2(uint8) {
      var tmp;
      var len2 = uint8.length;
      var extraBytes = len2 % 3;
      var parts = [];
      var maxChunkLength = 16383;
      for (var i2 = 0, len22 = len2 - extraBytes; i2 < len22; i2 += maxChunkLength) {
        parts.push(encodeChunk(uint8, i2, i2 + maxChunkLength > len22 ? len22 : i2 + maxChunkLength));
      }
      if (extraBytes === 1) {
        tmp = uint8[len2 - 1];
        parts.push(
          lookup[tmp >> 2] + lookup[tmp << 4 & 63] + "=="
        );
      } else if (extraBytes === 2) {
        tmp = (uint8[len2 - 2] << 8) + uint8[len2 - 1];
        parts.push(
          lookup[tmp >> 10] + lookup[tmp >> 4 & 63] + lookup[tmp << 2 & 63] + "="
        );
      }
      return parts.join("");
    }
  }
});

// spacetimedb/module/node_modules/safe-stable-stringify/index.js
var require_safe_stable_stringify = __commonJS({
  "spacetimedb/module/node_modules/safe-stable-stringify/index.js"(exports, module) {
    "use strict";
    var { hasOwnProperty } = Object.prototype;
    var stringify3 = configure2();
    stringify3.configure = configure2;
    stringify3.stringify = stringify3;
    stringify3.default = stringify3;
    exports.stringify = stringify3;
    exports.configure = configure2;
    module.exports = stringify3;
    var strEscapeSequencesRegExp = /[\u0000-\u001f\u0022\u005c\ud800-\udfff]/;
    function strEscape(str) {
      if (str.length < 5e3 && !strEscapeSequencesRegExp.test(str)) {
        return `"${str}"`;
      }
      return JSON.stringify(str);
    }
    function sort(array, comparator) {
      if (array.length > 200 || comparator) {
        return array.sort(comparator);
      }
      for (let i = 1; i < array.length; i++) {
        const currentValue = array[i];
        let position = i;
        while (position !== 0 && array[position - 1] > currentValue) {
          array[position] = array[position - 1];
          position--;
        }
        array[position] = currentValue;
      }
      return array;
    }
    var typedArrayPrototypeGetSymbolToStringTag = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(
        Object.getPrototypeOf(
          new Int8Array()
        )
      ),
      Symbol.toStringTag
    ).get;
    function isTypedArrayWithEntries(value) {
      return typedArrayPrototypeGetSymbolToStringTag.call(value) !== void 0 && value.length !== 0;
    }
    function stringifyTypedArray(array, separator, maximumBreadth) {
      if (array.length < maximumBreadth) {
        maximumBreadth = array.length;
      }
      const whitespace = separator === "," ? "" : " ";
      let res = `"0":${whitespace}${array[0]}`;
      for (let i = 1; i < maximumBreadth; i++) {
        res += `${separator}"${i}":${whitespace}${array[i]}`;
      }
      return res;
    }
    function getCircularValueOption(options) {
      if (hasOwnProperty.call(options, "circularValue")) {
        const circularValue = options.circularValue;
        if (typeof circularValue === "string") {
          return `"${circularValue}"`;
        }
        if (circularValue == null) {
          return circularValue;
        }
        if (circularValue === Error || circularValue === TypeError) {
          return {
            toString() {
              throw new TypeError("Converting circular structure to JSON");
            }
          };
        }
        throw new TypeError('The "circularValue" argument must be of type string or the value null or undefined');
      }
      return '"[Circular]"';
    }
    function getDeterministicOption(options) {
      let value;
      if (hasOwnProperty.call(options, "deterministic")) {
        value = options.deterministic;
        if (typeof value !== "boolean" && typeof value !== "function") {
          throw new TypeError('The "deterministic" argument must be of type boolean or comparator function');
        }
      }
      return value === void 0 ? true : value;
    }
    function getBooleanOption(options, key) {
      let value;
      if (hasOwnProperty.call(options, key)) {
        value = options[key];
        if (typeof value !== "boolean") {
          throw new TypeError(`The "${key}" argument must be of type boolean`);
        }
      }
      return value === void 0 ? true : value;
    }
    function getPositiveIntegerOption(options, key) {
      let value;
      if (hasOwnProperty.call(options, key)) {
        value = options[key];
        if (typeof value !== "number") {
          throw new TypeError(`The "${key}" argument must be of type number`);
        }
        if (!Number.isInteger(value)) {
          throw new TypeError(`The "${key}" argument must be an integer`);
        }
        if (value < 1) {
          throw new RangeError(`The "${key}" argument must be >= 1`);
        }
      }
      return value === void 0 ? Infinity : value;
    }
    function getItemCount(number) {
      if (number === 1) {
        return "1 item";
      }
      return `${number} items`;
    }
    function getUniqueReplacerSet(replacerArray) {
      const replacerSet = /* @__PURE__ */ new Set();
      for (const value of replacerArray) {
        if (typeof value === "string" || typeof value === "number") {
          replacerSet.add(String(value));
        }
      }
      return replacerSet;
    }
    function getStrictOption(options) {
      if (hasOwnProperty.call(options, "strict")) {
        const value = options.strict;
        if (typeof value !== "boolean") {
          throw new TypeError('The "strict" argument must be of type boolean');
        }
        if (value) {
          return (value2) => {
            let message = `Object can not safely be stringified. Received type ${typeof value2}`;
            if (typeof value2 !== "function") message += ` (${value2.toString()})`;
            throw new Error(message);
          };
        }
      }
    }
    function configure2(options) {
      options = { ...options };
      const fail = getStrictOption(options);
      if (fail) {
        if (options.bigint === void 0) {
          options.bigint = false;
        }
        if (!("circularValue" in options)) {
          options.circularValue = Error;
        }
      }
      const circularValue = getCircularValueOption(options);
      const bigint = getBooleanOption(options, "bigint");
      const deterministic = getDeterministicOption(options);
      const comparator = typeof deterministic === "function" ? deterministic : void 0;
      const maximumDepth = getPositiveIntegerOption(options, "maximumDepth");
      const maximumBreadth = getPositiveIntegerOption(options, "maximumBreadth");
      function stringifyFnReplacer(key, parent, stack, replacer, spacer, indentation) {
        let value = parent[key];
        if (typeof value === "object" && value !== null && typeof value.toJSON === "function") {
          value = value.toJSON(key);
        }
        value = replacer.call(parent, key, value);
        switch (typeof value) {
          case "string":
            return strEscape(value);
          case "object": {
            if (value === null) {
              return "null";
            }
            if (stack.indexOf(value) !== -1) {
              return circularValue;
            }
            let res = "";
            let join = ",";
            const originalIndentation = indentation;
            if (Array.isArray(value)) {
              if (value.length === 0) {
                return "[]";
              }
              if (maximumDepth < stack.length + 1) {
                return '"[Array]"';
              }
              stack.push(value);
              if (spacer !== "") {
                indentation += spacer;
                res += `
${indentation}`;
                join = `,
${indentation}`;
              }
              const maximumValuesToStringify = Math.min(value.length, maximumBreadth);
              let i = 0;
              for (; i < maximumValuesToStringify - 1; i++) {
                const tmp2 = stringifyFnReplacer(String(i), value, stack, replacer, spacer, indentation);
                res += tmp2 !== void 0 ? tmp2 : "null";
                res += join;
              }
              const tmp = stringifyFnReplacer(String(i), value, stack, replacer, spacer, indentation);
              res += tmp !== void 0 ? tmp : "null";
              if (value.length - 1 > maximumBreadth) {
                const removedKeys = value.length - maximumBreadth - 1;
                res += `${join}"... ${getItemCount(removedKeys)} not stringified"`;
              }
              if (spacer !== "") {
                res += `
${originalIndentation}`;
              }
              stack.pop();
              return `[${res}]`;
            }
            let keys = Object.keys(value);
            const keyLength = keys.length;
            if (keyLength === 0) {
              return "{}";
            }
            if (maximumDepth < stack.length + 1) {
              return '"[Object]"';
            }
            let whitespace = "";
            let separator = "";
            if (spacer !== "") {
              indentation += spacer;
              join = `,
${indentation}`;
              whitespace = " ";
            }
            const maximumPropertiesToStringify = Math.min(keyLength, maximumBreadth);
            if (deterministic && !isTypedArrayWithEntries(value)) {
              keys = sort(keys, comparator);
            }
            stack.push(value);
            for (let i = 0; i < maximumPropertiesToStringify; i++) {
              const key2 = keys[i];
              const tmp = stringifyFnReplacer(key2, value, stack, replacer, spacer, indentation);
              if (tmp !== void 0) {
                res += `${separator}${strEscape(key2)}:${whitespace}${tmp}`;
                separator = join;
              }
            }
            if (keyLength > maximumBreadth) {
              const removedKeys = keyLength - maximumBreadth;
              res += `${separator}"...":${whitespace}"${getItemCount(removedKeys)} not stringified"`;
              separator = join;
            }
            if (spacer !== "" && separator.length > 1) {
              res = `
${indentation}${res}
${originalIndentation}`;
            }
            stack.pop();
            return `{${res}}`;
          }
          case "number":
            return isFinite(value) ? String(value) : fail ? fail(value) : "null";
          case "boolean":
            return value === true ? "true" : "false";
          case "undefined":
            return void 0;
          case "bigint":
            if (bigint) {
              return String(value);
            }
          // fallthrough
          default:
            return fail ? fail(value) : void 0;
        }
      }
      function stringifyArrayReplacer(key, value, stack, replacer, spacer, indentation) {
        if (typeof value === "object" && value !== null && typeof value.toJSON === "function") {
          value = value.toJSON(key);
        }
        switch (typeof value) {
          case "string":
            return strEscape(value);
          case "object": {
            if (value === null) {
              return "null";
            }
            if (stack.indexOf(value) !== -1) {
              return circularValue;
            }
            const originalIndentation = indentation;
            let res = "";
            let join = ",";
            if (Array.isArray(value)) {
              if (value.length === 0) {
                return "[]";
              }
              if (maximumDepth < stack.length + 1) {
                return '"[Array]"';
              }
              stack.push(value);
              if (spacer !== "") {
                indentation += spacer;
                res += `
${indentation}`;
                join = `,
${indentation}`;
              }
              const maximumValuesToStringify = Math.min(value.length, maximumBreadth);
              let i = 0;
              for (; i < maximumValuesToStringify - 1; i++) {
                const tmp2 = stringifyArrayReplacer(String(i), value[i], stack, replacer, spacer, indentation);
                res += tmp2 !== void 0 ? tmp2 : "null";
                res += join;
              }
              const tmp = stringifyArrayReplacer(String(i), value[i], stack, replacer, spacer, indentation);
              res += tmp !== void 0 ? tmp : "null";
              if (value.length - 1 > maximumBreadth) {
                const removedKeys = value.length - maximumBreadth - 1;
                res += `${join}"... ${getItemCount(removedKeys)} not stringified"`;
              }
              if (spacer !== "") {
                res += `
${originalIndentation}`;
              }
              stack.pop();
              return `[${res}]`;
            }
            stack.push(value);
            let whitespace = "";
            if (spacer !== "") {
              indentation += spacer;
              join = `,
${indentation}`;
              whitespace = " ";
            }
            let separator = "";
            for (const key2 of replacer) {
              const tmp = stringifyArrayReplacer(key2, value[key2], stack, replacer, spacer, indentation);
              if (tmp !== void 0) {
                res += `${separator}${strEscape(key2)}:${whitespace}${tmp}`;
                separator = join;
              }
            }
            if (spacer !== "" && separator.length > 1) {
              res = `
${indentation}${res}
${originalIndentation}`;
            }
            stack.pop();
            return `{${res}}`;
          }
          case "number":
            return isFinite(value) ? String(value) : fail ? fail(value) : "null";
          case "boolean":
            return value === true ? "true" : "false";
          case "undefined":
            return void 0;
          case "bigint":
            if (bigint) {
              return String(value);
            }
          // fallthrough
          default:
            return fail ? fail(value) : void 0;
        }
      }
      function stringifyIndent(key, value, stack, spacer, indentation) {
        switch (typeof value) {
          case "string":
            return strEscape(value);
          case "object": {
            if (value === null) {
              return "null";
            }
            if (typeof value.toJSON === "function") {
              value = value.toJSON(key);
              if (typeof value !== "object") {
                return stringifyIndent(key, value, stack, spacer, indentation);
              }
              if (value === null) {
                return "null";
              }
            }
            if (stack.indexOf(value) !== -1) {
              return circularValue;
            }
            const originalIndentation = indentation;
            if (Array.isArray(value)) {
              if (value.length === 0) {
                return "[]";
              }
              if (maximumDepth < stack.length + 1) {
                return '"[Array]"';
              }
              stack.push(value);
              indentation += spacer;
              let res2 = `
${indentation}`;
              const join2 = `,
${indentation}`;
              const maximumValuesToStringify = Math.min(value.length, maximumBreadth);
              let i = 0;
              for (; i < maximumValuesToStringify - 1; i++) {
                const tmp2 = stringifyIndent(String(i), value[i], stack, spacer, indentation);
                res2 += tmp2 !== void 0 ? tmp2 : "null";
                res2 += join2;
              }
              const tmp = stringifyIndent(String(i), value[i], stack, spacer, indentation);
              res2 += tmp !== void 0 ? tmp : "null";
              if (value.length - 1 > maximumBreadth) {
                const removedKeys = value.length - maximumBreadth - 1;
                res2 += `${join2}"... ${getItemCount(removedKeys)} not stringified"`;
              }
              res2 += `
${originalIndentation}`;
              stack.pop();
              return `[${res2}]`;
            }
            let keys = Object.keys(value);
            const keyLength = keys.length;
            if (keyLength === 0) {
              return "{}";
            }
            if (maximumDepth < stack.length + 1) {
              return '"[Object]"';
            }
            indentation += spacer;
            const join = `,
${indentation}`;
            let res = "";
            let separator = "";
            let maximumPropertiesToStringify = Math.min(keyLength, maximumBreadth);
            if (isTypedArrayWithEntries(value)) {
              res += stringifyTypedArray(value, join, maximumBreadth);
              keys = keys.slice(value.length);
              maximumPropertiesToStringify -= value.length;
              separator = join;
            }
            if (deterministic) {
              keys = sort(keys, comparator);
            }
            stack.push(value);
            for (let i = 0; i < maximumPropertiesToStringify; i++) {
              const key2 = keys[i];
              const tmp = stringifyIndent(key2, value[key2], stack, spacer, indentation);
              if (tmp !== void 0) {
                res += `${separator}${strEscape(key2)}: ${tmp}`;
                separator = join;
              }
            }
            if (keyLength > maximumBreadth) {
              const removedKeys = keyLength - maximumBreadth;
              res += `${separator}"...": "${getItemCount(removedKeys)} not stringified"`;
              separator = join;
            }
            if (separator !== "") {
              res = `
${indentation}${res}
${originalIndentation}`;
            }
            stack.pop();
            return `{${res}}`;
          }
          case "number":
            return isFinite(value) ? String(value) : fail ? fail(value) : "null";
          case "boolean":
            return value === true ? "true" : "false";
          case "undefined":
            return void 0;
          case "bigint":
            if (bigint) {
              return String(value);
            }
          // fallthrough
          default:
            return fail ? fail(value) : void 0;
        }
      }
      function stringifySimple(key, value, stack) {
        switch (typeof value) {
          case "string":
            return strEscape(value);
          case "object": {
            if (value === null) {
              return "null";
            }
            if (typeof value.toJSON === "function") {
              value = value.toJSON(key);
              if (typeof value !== "object") {
                return stringifySimple(key, value, stack);
              }
              if (value === null) {
                return "null";
              }
            }
            if (stack.indexOf(value) !== -1) {
              return circularValue;
            }
            let res = "";
            const hasLength = value.length !== void 0;
            if (hasLength && Array.isArray(value)) {
              if (value.length === 0) {
                return "[]";
              }
              if (maximumDepth < stack.length + 1) {
                return '"[Array]"';
              }
              stack.push(value);
              const maximumValuesToStringify = Math.min(value.length, maximumBreadth);
              let i = 0;
              for (; i < maximumValuesToStringify - 1; i++) {
                const tmp2 = stringifySimple(String(i), value[i], stack);
                res += tmp2 !== void 0 ? tmp2 : "null";
                res += ",";
              }
              const tmp = stringifySimple(String(i), value[i], stack);
              res += tmp !== void 0 ? tmp : "null";
              if (value.length - 1 > maximumBreadth) {
                const removedKeys = value.length - maximumBreadth - 1;
                res += `,"... ${getItemCount(removedKeys)} not stringified"`;
              }
              stack.pop();
              return `[${res}]`;
            }
            let keys = Object.keys(value);
            const keyLength = keys.length;
            if (keyLength === 0) {
              return "{}";
            }
            if (maximumDepth < stack.length + 1) {
              return '"[Object]"';
            }
            let separator = "";
            let maximumPropertiesToStringify = Math.min(keyLength, maximumBreadth);
            if (hasLength && isTypedArrayWithEntries(value)) {
              res += stringifyTypedArray(value, ",", maximumBreadth);
              keys = keys.slice(value.length);
              maximumPropertiesToStringify -= value.length;
              separator = ",";
            }
            if (deterministic) {
              keys = sort(keys, comparator);
            }
            stack.push(value);
            for (let i = 0; i < maximumPropertiesToStringify; i++) {
              const key2 = keys[i];
              const tmp = stringifySimple(key2, value[key2], stack);
              if (tmp !== void 0) {
                res += `${separator}${strEscape(key2)}:${tmp}`;
                separator = ",";
              }
            }
            if (keyLength > maximumBreadth) {
              const removedKeys = keyLength - maximumBreadth;
              res += `${separator}"...":"${getItemCount(removedKeys)} not stringified"`;
            }
            stack.pop();
            return `{${res}}`;
          }
          case "number":
            return isFinite(value) ? String(value) : fail ? fail(value) : "null";
          case "boolean":
            return value === true ? "true" : "false";
          case "undefined":
            return void 0;
          case "bigint":
            if (bigint) {
              return String(value);
            }
          // fallthrough
          default:
            return fail ? fail(value) : void 0;
        }
      }
      function stringify4(value, replacer, space) {
        if (arguments.length > 1) {
          let spacer = "";
          if (typeof space === "number") {
            spacer = " ".repeat(Math.min(space, 10));
          } else if (typeof space === "string") {
            spacer = space.slice(0, 10);
          }
          if (replacer != null) {
            if (typeof replacer === "function") {
              return stringifyFnReplacer("", { "": value }, [], replacer, spacer, "");
            }
            if (Array.isArray(replacer)) {
              return stringifyArrayReplacer("", value, [], getUniqueReplacerSet(replacer), spacer, "");
            }
          }
          if (spacer.length !== 0) {
            return stringifyIndent("", value, [], spacer, "");
          }
        }
        return stringifySimple("", value, []);
      }
      return stringify4;
    }
  }
});

// spacetimedb/module/node_modules/spacetimedb/dist/index.browser.mjs
var import_base64_js = __toESM(require_base64_js(), 1);

// spacetimedb/module/node_modules/safe-stable-stringify/esm/wrapper.js
var import__ = __toESM(require_safe_stable_stringify(), 1);
var configure = import__.default.configure;
var stringify = import__.default;

// spacetimedb/module/node_modules/spacetimedb/dist/index.browser.mjs
var BinaryReader = class {
  /**
   * The DataView used to read values from the binary data.
   *
   * Note: The DataView's `byteOffset` is relative to the beginning of the
   * underlying ArrayBuffer, not the start of the provided Uint8Array input.
   * This `BinaryReader`'s `#offset` field is used to track the current read position
   * relative to the start of the provided Uint8Array input.
   */
  view;
  /**
   * Represents the offset (in bytes) relative to the start of the DataView
   * and provided Uint8Array input.
   *
   * Note: This is *not* the absolute byte offset within the underlying ArrayBuffer.
   */
  offset = 0;
  constructor(input) {
    this.view = input instanceof DataView ? input : new DataView(input.buffer, input.byteOffset, input.byteLength);
    this.offset = 0;
  }
  reset(input) {
    this.view = input instanceof DataView ? input : new DataView(input.buffer, input.byteOffset, input.byteLength);
    this.offset = 0;
  }
  get remaining() {
    return this.view.byteLength - this.offset;
  }
  /** Ensure we have at least `n` bytes left to read */
  #ensure(n) {
    if (this.offset + n > this.view.byteLength) {
      throw new RangeError(
        `Tried to read ${n} byte(s) at relative offset ${this.offset}, but only ${this.remaining} byte(s) remain`
      );
    }
  }
  readUInt8Array() {
    const length = this.readU32();
    this.#ensure(length);
    return this.readBytes(length).slice();
  }
  readBool() {
    const value = this.view.getUint8(this.offset);
    this.offset += 1;
    return value !== 0;
  }
  readByte() {
    const value = this.view.getUint8(this.offset);
    this.offset += 1;
    return value;
  }
  readBytes(length) {
    const array = new Uint8Array(
      this.view.buffer,
      this.view.byteOffset + this.offset,
      length
    );
    this.offset += length;
    return array;
  }
  readI8() {
    const value = this.view.getInt8(this.offset);
    this.offset += 1;
    return value;
  }
  readU8() {
    return this.readByte();
  }
  readI16() {
    const value = this.view.getInt16(this.offset, true);
    this.offset += 2;
    return value;
  }
  readU16() {
    const value = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return value;
  }
  readI32() {
    const value = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return value;
  }
  readU32() {
    const value = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }
  readI64() {
    const value = this.view.getBigInt64(this.offset, true);
    this.offset += 8;
    return value;
  }
  readU64() {
    const value = this.view.getBigUint64(this.offset, true);
    this.offset += 8;
    return value;
  }
  readU128() {
    const lowerPart = this.view.getBigUint64(this.offset, true);
    const upperPart = this.view.getBigUint64(this.offset + 8, true);
    this.offset += 16;
    return (upperPart << BigInt(64)) + lowerPart;
  }
  readI128() {
    const lowerPart = this.view.getBigUint64(this.offset, true);
    const upperPart = this.view.getBigInt64(this.offset + 8, true);
    this.offset += 16;
    return (upperPart << BigInt(64)) + lowerPart;
  }
  readU256() {
    const p0 = this.view.getBigUint64(this.offset, true);
    const p1 = this.view.getBigUint64(this.offset + 8, true);
    const p2 = this.view.getBigUint64(this.offset + 16, true);
    const p3 = this.view.getBigUint64(this.offset + 24, true);
    this.offset += 32;
    return (p3 << BigInt(3 * 64)) + (p2 << BigInt(2 * 64)) + (p1 << BigInt(1 * 64)) + p0;
  }
  readI256() {
    const p0 = this.view.getBigUint64(this.offset, true);
    const p1 = this.view.getBigUint64(this.offset + 8, true);
    const p2 = this.view.getBigUint64(this.offset + 16, true);
    const p3 = this.view.getBigInt64(this.offset + 24, true);
    this.offset += 32;
    return (p3 << BigInt(3 * 64)) + (p2 << BigInt(2 * 64)) + (p1 << BigInt(1 * 64)) + p0;
  }
  readF32() {
    const value = this.view.getFloat32(this.offset, true);
    this.offset += 4;
    return value;
  }
  readF64() {
    const value = this.view.getFloat64(this.offset, true);
    this.offset += 8;
    return value;
  }
  readString() {
    const length = this.readU32();
    this.#ensure(length);
    const bytes = this.readBytes(length);
    return new TextDecoder("utf-8").decode(bytes);
  }
};
var ArrayBufferPrototypeTransfer = ArrayBuffer.prototype.transfer ?? function(newByteLength) {
  if (newByteLength === void 0) {
    return this.slice();
  } else if (newByteLength <= this.byteLength) {
    return this.slice(0, newByteLength);
  } else {
    const copy = new Uint8Array(newByteLength);
    copy.set(new Uint8Array(this));
    return copy.buffer;
  }
};
var ResizableBuffer = class {
  buffer;
  view;
  constructor(init) {
    this.buffer = typeof init === "number" ? new ArrayBuffer(init) : init;
    this.view = new DataView(this.buffer);
  }
  get capacity() {
    return this.buffer.byteLength;
  }
  grow(newSize) {
    if (newSize <= this.buffer.byteLength) return;
    this.buffer = ArrayBufferPrototypeTransfer.call(this.buffer, newSize);
    this.view = new DataView(this.buffer);
  }
};
var BinaryWriter = class {
  buffer;
  offset = 0;
  constructor(init) {
    this.buffer = typeof init === "number" ? new ResizableBuffer(init) : init;
  }
  clear() {
    this.offset = 0;
  }
  reset(buffer) {
    this.buffer = buffer;
    this.offset = 0;
  }
  expandBuffer(additionalCapacity) {
    const minCapacity = this.offset + additionalCapacity + 1;
    if (minCapacity <= this.buffer.capacity) return;
    let newCapacity = this.buffer.capacity * 2;
    if (newCapacity < minCapacity) newCapacity = minCapacity;
    this.buffer.grow(newCapacity);
  }
  toBase64() {
    return (0, import_base64_js.fromByteArray)(this.getBuffer());
  }
  getBuffer() {
    return new Uint8Array(this.buffer.buffer, 0, this.offset);
  }
  get view() {
    return this.buffer.view;
  }
  writeUInt8Array(value) {
    const length = value.length;
    this.expandBuffer(4 + length);
    this.writeU32(length);
    new Uint8Array(this.buffer.buffer, this.offset).set(value);
    this.offset += length;
  }
  writeBool(value) {
    this.expandBuffer(1);
    this.view.setUint8(this.offset, value ? 1 : 0);
    this.offset += 1;
  }
  writeByte(value) {
    this.expandBuffer(1);
    this.view.setUint8(this.offset, value);
    this.offset += 1;
  }
  writeBytes(value) {
    this.expandBuffer(value.length);
    new Uint8Array(this.buffer.buffer, this.offset, value.length).set(value);
    this.offset += value.length;
  }
  writeI8(value) {
    this.expandBuffer(1);
    this.view.setInt8(this.offset, value);
    this.offset += 1;
  }
  writeU8(value) {
    this.expandBuffer(1);
    this.view.setUint8(this.offset, value);
    this.offset += 1;
  }
  writeI16(value) {
    this.expandBuffer(2);
    this.view.setInt16(this.offset, value, true);
    this.offset += 2;
  }
  writeU16(value) {
    this.expandBuffer(2);
    this.view.setUint16(this.offset, value, true);
    this.offset += 2;
  }
  writeI32(value) {
    this.expandBuffer(4);
    this.view.setInt32(this.offset, value, true);
    this.offset += 4;
  }
  writeU32(value) {
    this.expandBuffer(4);
    this.view.setUint32(this.offset, value, true);
    this.offset += 4;
  }
  writeI64(value) {
    this.expandBuffer(8);
    this.view.setBigInt64(this.offset, value, true);
    this.offset += 8;
  }
  writeU64(value) {
    this.expandBuffer(8);
    this.view.setBigUint64(this.offset, value, true);
    this.offset += 8;
  }
  writeU128(value) {
    this.expandBuffer(16);
    const lowerPart = value & BigInt("0xFFFFFFFFFFFFFFFF");
    const upperPart = value >> BigInt(64);
    this.view.setBigUint64(this.offset, lowerPart, true);
    this.view.setBigUint64(this.offset + 8, upperPart, true);
    this.offset += 16;
  }
  writeI128(value) {
    this.expandBuffer(16);
    const lowerPart = value & BigInt("0xFFFFFFFFFFFFFFFF");
    const upperPart = value >> BigInt(64);
    this.view.setBigInt64(this.offset, lowerPart, true);
    this.view.setBigInt64(this.offset + 8, upperPart, true);
    this.offset += 16;
  }
  writeU256(value) {
    this.expandBuffer(32);
    const low_64_mask = BigInt("0xFFFFFFFFFFFFFFFF");
    const p0 = value & low_64_mask;
    const p1 = value >> BigInt(64 * 1) & low_64_mask;
    const p2 = value >> BigInt(64 * 2) & low_64_mask;
    const p3 = value >> BigInt(64 * 3);
    this.view.setBigUint64(this.offset + 8 * 0, p0, true);
    this.view.setBigUint64(this.offset + 8 * 1, p1, true);
    this.view.setBigUint64(this.offset + 8 * 2, p2, true);
    this.view.setBigUint64(this.offset + 8 * 3, p3, true);
    this.offset += 32;
  }
  writeI256(value) {
    this.expandBuffer(32);
    const low_64_mask = BigInt("0xFFFFFFFFFFFFFFFF");
    const p0 = value & low_64_mask;
    const p1 = value >> BigInt(64 * 1) & low_64_mask;
    const p2 = value >> BigInt(64 * 2) & low_64_mask;
    const p3 = value >> BigInt(64 * 3);
    this.view.setBigUint64(this.offset + 8 * 0, p0, true);
    this.view.setBigUint64(this.offset + 8 * 1, p1, true);
    this.view.setBigUint64(this.offset + 8 * 2, p2, true);
    this.view.setBigInt64(this.offset + 8 * 3, p3, true);
    this.offset += 32;
  }
  writeF32(value) {
    this.expandBuffer(4);
    this.view.setFloat32(this.offset, value, true);
    this.offset += 4;
  }
  writeF64(value) {
    this.expandBuffer(8);
    this.view.setFloat64(this.offset, value, true);
    this.offset += 8;
  }
  writeString(value) {
    const encoder = new TextEncoder();
    const encodedString = encoder.encode(value);
    this.writeUInt8Array(encodedString);
  }
};
function deepEqual(obj1, obj2) {
  if (obj1 === obj2) return true;
  if (typeof obj1 !== "object" || obj1 === null || typeof obj2 !== "object" || obj2 === null) {
    return false;
  }
  const keys1 = Object.keys(obj1);
  const keys2 = Object.keys(obj2);
  if (keys1.length !== keys2.length) return false;
  for (const key of keys1) {
    if (!keys2.includes(key) || !deepEqual(obj1[key], obj2[key])) {
      return false;
    }
  }
  return true;
}
function uint8ArrayToHexString(array) {
  return Array.prototype.map.call(array.reverse(), (x) => ("00" + x.toString(16)).slice(-2)).join("");
}
function uint8ArrayToU128(array) {
  if (array.length != 16) {
    throw new Error(`Uint8Array is not 16 bytes long: ${array}`);
  }
  return new BinaryReader(array).readU128();
}
function uint8ArrayToU256(array) {
  if (array.length != 32) {
    throw new Error(`Uint8Array is not 32 bytes long: [${array}]`);
  }
  return new BinaryReader(array).readU256();
}
function hexStringToUint8Array(str) {
  if (str.startsWith("0x")) {
    str = str.slice(2);
  }
  const matches = str.match(/.{1,2}/g) || [];
  const data = Uint8Array.from(
    matches.map((byte) => parseInt(byte, 16))
  );
  return data.reverse();
}
function hexStringToU128(str) {
  return uint8ArrayToU128(hexStringToUint8Array(str));
}
function hexStringToU256(str) {
  return uint8ArrayToU256(hexStringToUint8Array(str));
}
function u128ToUint8Array(data) {
  const writer = new BinaryWriter(16);
  writer.writeU128(data);
  return writer.getBuffer();
}
function u128ToHexString(data) {
  return uint8ArrayToHexString(u128ToUint8Array(data));
}
function u256ToUint8Array(data) {
  const writer = new BinaryWriter(32);
  writer.writeU256(data);
  return writer.getBuffer();
}
function u256ToHexString(data) {
  return uint8ArrayToHexString(u256ToUint8Array(data));
}
function coerceToBigInt(value, what) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  if (typeof value === "string" && value.trim() !== "") return BigInt(value);
  throw new TypeError(
    `Cannot convert ${typeof value} to ${what}: expected bigint, integer number, or decimal string`
  );
}
function toPascalCase(s) {
  const str = toCamelCase(s);
  return str.charAt(0).toUpperCase() + str.slice(1);
}
function toCamelCase(s) {
  const str = s.replace(/[-_]+/g, "_").replace(/_([a-zA-Z0-9])/g, (_, c) => c.toUpperCase());
  return str.charAt(0).toLowerCase() + str.slice(1);
}
var hasOwn = Object.hasOwn;
var TimeDuration = class _TimeDuration {
  __time_duration_micros__;
  static MICROS_PER_MILLIS = 1000n;
  /**
   * Get the algebraic type representation of the {@link TimeDuration} type.
   * @returns The algebraic type representation of the type.
   */
  static getAlgebraicType() {
    return AlgebraicType.Product({
      elements: [
        {
          name: "__time_duration_micros__",
          algebraicType: AlgebraicType.I64
        }
      ]
    });
  }
  static isTimeDuration(algebraicType) {
    if (algebraicType.tag !== "Product") {
      return false;
    }
    const elements = algebraicType.value.elements;
    if (elements.length !== 1) {
      return false;
    }
    const microsElement = elements[0];
    return microsElement.name === "__time_duration_micros__" && microsElement.algebraicType.tag === "I64";
  }
  get micros() {
    return this.__time_duration_micros__;
  }
  get millis() {
    return Number(this.micros / _TimeDuration.MICROS_PER_MILLIS);
  }
  constructor(micros) {
    this.__time_duration_micros__ = coerceToBigInt(micros, "TimeDuration");
  }
  static fromMillis(millis) {
    return new _TimeDuration(BigInt(millis) * _TimeDuration.MICROS_PER_MILLIS);
  }
  /** This outputs the same string format that we use in the host and in Rust modules */
  toString() {
    const micros = this.micros;
    const sign = micros < 0 ? "-" : "+";
    const pos = micros < 0 ? -micros : micros;
    const secs = pos / 1000000n;
    const micros_remaining = pos % 1000000n;
    return `${sign}${secs}.${String(micros_remaining).padStart(6, "0")}`;
  }
};
var Timestamp = class _Timestamp {
  __timestamp_micros_since_unix_epoch__;
  static MICROS_PER_MILLIS = 1000n;
  get microsSinceUnixEpoch() {
    return this.__timestamp_micros_since_unix_epoch__;
  }
  constructor(micros) {
    this.__timestamp_micros_since_unix_epoch__ = coerceToBigInt(
      micros,
      "Timestamp"
    );
  }
  /**
   * Get the algebraic type representation of the {@link Timestamp} type.
   * @returns The algebraic type representation of the type.
   */
  static getAlgebraicType() {
    return AlgebraicType.Product({
      elements: [
        {
          name: "__timestamp_micros_since_unix_epoch__",
          algebraicType: AlgebraicType.I64
        }
      ]
    });
  }
  static isTimestamp(algebraicType) {
    if (algebraicType.tag !== "Product") {
      return false;
    }
    const elements = algebraicType.value.elements;
    if (elements.length !== 1) {
      return false;
    }
    const microsElement = elements[0];
    return microsElement.name === "__timestamp_micros_since_unix_epoch__" && microsElement.algebraicType.tag === "I64";
  }
  /**
   * The Unix epoch, the midnight at the beginning of January 1, 1970, UTC.
   */
  static UNIX_EPOCH = new _Timestamp(0n);
  /**
   * Get a `Timestamp` representing the execution environment's belief of the current moment in time.
   */
  static now() {
    return _Timestamp.fromDate(/* @__PURE__ */ new Date());
  }
  /** Convert to milliseconds since Unix epoch. */
  toMillis() {
    return this.microsSinceUnixEpoch / 1000n;
  }
  /**
   * Get a `Timestamp` representing the same point in time as `date`.
   */
  static fromDate(date) {
    const millis = date.getTime();
    const micros = BigInt(millis) * _Timestamp.MICROS_PER_MILLIS;
    return new _Timestamp(micros);
  }
  /**
   * Get a `Date` representing approximately the same point in time as `this`.
   *
   * This method truncates to millisecond precision,
   * and throws `RangeError` if the `Timestamp` is outside the range representable as a `Date`.
   */
  toDate() {
    const micros = this.__timestamp_micros_since_unix_epoch__;
    const millis = micros / _Timestamp.MICROS_PER_MILLIS;
    if (millis > BigInt(Number.MAX_SAFE_INTEGER) || millis < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new RangeError(
        "Timestamp is outside of the representable range of JS's Date"
      );
    }
    return new Date(Number(millis));
  }
  /**
   * Get an ISO 8601 / RFC 3339 formatted string representation of this timestamp with microsecond precision.
   *
   * This method preserves the full microsecond precision of the timestamp,
   * and throws `RangeError` if the `Timestamp` is outside the range representable in ISO format.
   *
   * @returns ISO 8601 formatted string with microsecond precision (e.g., '2025-02-17T10:30:45.123456Z')
   */
  toISOString() {
    const micros = this.__timestamp_micros_since_unix_epoch__;
    const millis = micros / _Timestamp.MICROS_PER_MILLIS;
    if (millis > BigInt(Number.MAX_SAFE_INTEGER) || millis < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new RangeError(
        "Timestamp is outside of the representable range for ISO string formatting"
      );
    }
    const date = new Date(Number(millis));
    const isoBase = date.toISOString();
    const microsRemainder = Math.abs(Number(micros % 1000000n));
    const fractionalPart = String(microsRemainder).padStart(6, "0");
    return isoBase.replace(/\.\d{3}Z$/, `.${fractionalPart}Z`);
  }
  since(other) {
    return new TimeDuration(
      this.__timestamp_micros_since_unix_epoch__ - other.__timestamp_micros_since_unix_epoch__
    );
  }
};
var Uuid = class _Uuid {
  __uuid__;
  /**
   * The nil UUID (all zeros).
   *
   * @example
   * ```ts
   * const uuid = Uuid.NIL;
   * console.assert(
   *   uuid.toString() === "00000000-0000-0000-0000-000000000000"
   * );
   * ```
   */
  static NIL = new _Uuid(0n);
  static MAX_UUID_BIGINT = 0xffffffffffffffffffffffffffffffffn;
  /**
   * The max UUID (all ones).
   *
   * @example
   * ```ts
   * const uuid = Uuid.MAX;
   * console.assert(
   *   uuid.toString() === "ffffffff-ffff-ffff-ffff-ffffffffffff"
   * );
   * ```
   */
  static MAX = new _Uuid(_Uuid.MAX_UUID_BIGINT);
  /**
   * Create a UUID from a raw 128-bit value.
   *
   * @param u - Unsigned 128-bit integer
   * @throws {Error} If the value is outside the valid UUID range
   */
  constructor(u) {
    const v = coerceToBigInt(u, "Uuid");
    if (v < 0n || v > _Uuid.MAX_UUID_BIGINT) {
      throw new Error("Invalid UUID: must be between 0 and `MAX_UUID_BIGINT`");
    }
    this.__uuid__ = v;
  }
  /**
   * Create a UUID `v4` from explicit random bytes.
   *
   * This method assumes the bytes are already sufficiently random.
   * It only sets the appropriate bits for the UUID version and variant.
   *
   * @param bytes - Exactly 16 random bytes
   * @returns A UUID `v4`
   * @throws {Error} If `bytes.length !== 16`
   *
   * @example
   * ```ts
   * const randomBytes = new Uint8Array(16);
   * const uuid = Uuid.fromRandomBytesV4(randomBytes);
   *
   * console.assert(
   *   uuid.toString() === "00000000-0000-4000-8000-000000000000"
   * );
   * ```
   */
  static fromRandomBytesV4(bytes) {
    if (bytes.length !== 16) throw new Error("UUID v4 requires 16 bytes");
    const arr = new Uint8Array(bytes);
    arr[6] = arr[6] & 15 | 64;
    arr[8] = arr[8] & 63 | 128;
    return new _Uuid(_Uuid.bytesToBigInt(arr));
  }
  /**
   * Generate a UUID `v7` using a monotonic counter from `0` to `2^31 - 1`,
   * a timestamp, and 4 random bytes.
   *
   * The counter wraps around on overflow.
   *
   * The UUID `v7` is structured as follows:
   *
   * ```ascii
   * ┌───────────────────────────────────────────────┬───────────────────┐
   * | B0  | B1  | B2  | B3  | B4  | B5              |         B6        |
   * ├───────────────────────────────────────────────┼───────────────────┤
   * |                 unix_ts_ms                    |      version 7    |
   * └───────────────────────────────────────────────┴───────────────────┘
   * ┌──────────────┬─────────┬──────────────────┬───────────────────────┐
   * | B7           | B8      | B9  | B10 | B11  | B12 | B13 | B14 | B15 |
   * ├──────────────┼─────────┼──────────────────┼───────────────────────┤
   * | counter_high | variant |    counter_low   |        random         |
   * └──────────────┴─────────┴──────────────────┴───────────────────────┘
   * ```
   *
   * @param counter - Mutable monotonic counter (31-bit)
   * @param now - Timestamp since the Unix epoch
   * @param randomBytes - Exactly 4 random bytes
   * @returns A UUID `v7`
   *
   * @throws {Error} If the `counter` is negative
   * @throws {Error} If the `timestamp` is before the Unix epoch
   * @throws {Error} If `randomBytes.length !== 4`
   *
   * @example
   * ```ts
   * const now = Timestamp.fromMillis(1_686_000_000_000n);
   * const counter = { value: 1 };
   * const randomBytes = new Uint8Array(4);
   *
   * const uuid = Uuid.fromCounterV7(counter, now, randomBytes);
   *
   * console.assert(
   *   uuid.toString() === "0000647e-5180-7000-8000-000200000000"
   * );
   * ```
   */
  static fromCounterV7(counter, now, randomBytes) {
    if (randomBytes.length !== 4) {
      throw new Error("`fromCounterV7` requires `randomBytes.length == 4`");
    }
    if (counter.value < 0) {
      throw new Error("`fromCounterV7` uuid `counter` must be non-negative");
    }
    if (now.__timestamp_micros_since_unix_epoch__ < 0) {
      throw new Error("`fromCounterV7` `timestamp` before unix epoch");
    }
    const counterVal = counter.value;
    counter.value = counterVal + 1 & 2147483647;
    const tsMs = now.toMillis() & 0xffffffffffffn;
    const bytes = new Uint8Array(16);
    bytes[0] = Number(tsMs >> 40n & 0xffn);
    bytes[1] = Number(tsMs >> 32n & 0xffn);
    bytes[2] = Number(tsMs >> 24n & 0xffn);
    bytes[3] = Number(tsMs >> 16n & 0xffn);
    bytes[4] = Number(tsMs >> 8n & 0xffn);
    bytes[5] = Number(tsMs & 0xffn);
    bytes[7] = counterVal >>> 23 & 255;
    bytes[9] = counterVal >>> 15 & 255;
    bytes[10] = counterVal >>> 7 & 255;
    bytes[11] = (counterVal & 127) << 1 & 255;
    bytes[12] |= randomBytes[0] & 127;
    bytes[13] = randomBytes[1];
    bytes[14] = randomBytes[2];
    bytes[15] = randomBytes[3];
    bytes[6] = bytes[6] & 15 | 112;
    bytes[8] = bytes[8] & 63 | 128;
    return new _Uuid(_Uuid.bytesToBigInt(bytes));
  }
  /**
   * Parse a UUID from a string representation.
   *
   * @param s - UUID string
   * @returns Parsed UUID
   * @throws {Error} If the string is not a valid UUID
   *
   * @example
   * ```ts
   * const s = "01888d6e-5c00-7000-8000-000000000000";
   * const uuid = Uuid.parse(s);
   *
   * console.assert(uuid.toString() === s);
   * ```
   */
  static parse(s) {
    const hex = s.replace(/-/g, "");
    if (hex.length !== 32) throw new Error("Invalid hex UUID");
    let v = 0n;
    for (let i = 0; i < 32; i += 2) {
      v = v << 8n | BigInt(parseInt(hex.slice(i, i + 2), 16));
    }
    return new _Uuid(v);
  }
  /** Convert to hex string without a 0x prefix. */
  toHexString() {
    return u128ToHexString(this.asBigInt());
  }
  /** Convert to string (hyphenated form). */
  toString() {
    const hex = this.toHexString();
    return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" + hex.slice(16, 20) + "-" + hex.slice(20);
  }
  /** Convert to bigint (u128). */
  asBigInt() {
    return this.__uuid__;
  }
  /** Return a `Uint8Array` of 16 bytes. */
  toBytes() {
    return _Uuid.bigIntToBytes(this.__uuid__);
  }
  static bytesToBigInt(bytes) {
    let result = 0n;
    for (const b of bytes) result = result << 8n | BigInt(b);
    return result;
  }
  static bigIntToBytes(value) {
    const bytes = new Uint8Array(16);
    for (let i = 15; i >= 0; i--) {
      bytes[i] = Number(value & 0xffn);
      value >>= 8n;
    }
    return bytes;
  }
  /**
   * Returns the version of this UUID.
   *
   * This represents the algorithm used to generate the value.
   *
   * @returns A `UuidVersion`
   * @throws {Error} If the version field is not recognized
   */
  getVersion() {
    const version = this.toBytes()[6] >> 4 & 15;
    switch (version) {
      case 4:
        return "V4";
      case 7:
        return "V7";
      default:
        if (this == _Uuid.NIL) {
          return "Nil";
        }
        if (this == _Uuid.MAX) {
          return "Max";
        }
        throw new Error(`Unsupported UUID version: ${version}`);
    }
  }
  /**
   * Extract the monotonic counter from a UUIDv7.
   *
   * Intended for testing and diagnostics.
   * Behavior is undefined if called on a non-V7 UUID.
   *
   * @returns 31-bit counter value
   */
  getCounter() {
    const bytes = this.toBytes();
    const high = bytes[7];
    const mid1 = bytes[9];
    const mid2 = bytes[10];
    const low = bytes[11] >>> 1;
    return high << 23 | mid1 << 15 | mid2 << 7 | low | 0;
  }
  compareTo(other) {
    if (this.__uuid__ < other.__uuid__) return -1;
    if (this.__uuid__ > other.__uuid__) return 1;
    return 0;
  }
  static getAlgebraicType() {
    return AlgebraicType.Product({
      elements: [
        {
          name: "__uuid__",
          algebraicType: AlgebraicType.U128
        }
      ]
    });
  }
};
var Identity = class _Identity {
  __identity__;
  /**
   * Creates a new `Identity`.
   *
   * `data` can be a hexadecimal string or a `bigint`.
   */
  constructor(data) {
    this.__identity__ = typeof data === "string" ? hexStringToU256(data) : coerceToBigInt(data, "Identity");
  }
  /**
   * Get the algebraic type representation of the {@link Identity} type.
   * @returns The algebraic type representation of the type.
   */
  static getAlgebraicType() {
    return AlgebraicType.Product({
      elements: [{ name: "__identity__", algebraicType: AlgebraicType.U256 }]
    });
  }
  /**
   * Check if two identities are equal.
   */
  isEqual(other) {
    return this.toHexString() === other.toHexString();
  }
  /**
   * Check if two identities are equal.
   */
  equals(other) {
    return this.isEqual(other);
  }
  /**
   * Print the identity as a hexadecimal string.
   */
  toHexString() {
    return u256ToHexString(this.__identity__);
  }
  /**
   * Convert the address to a Uint8Array.
   */
  toUint8Array() {
    return u256ToUint8Array(this.__identity__);
  }
  /**
   * Parse an Identity from a hexadecimal string.
   */
  static fromString(str) {
    return new _Identity(str);
  }
  /**
   * Zero identity (0x0000000000000000000000000000000000000000000000000000000000000000)
   */
  static zero() {
    return new _Identity(0n);
  }
  toString() {
    return this.toHexString();
  }
};
var SERIALIZERS = /* @__PURE__ */ new Map();
var DESERIALIZERS = /* @__PURE__ */ new Map();
var AlgebraicType = {
  Ref: (value) => ({ tag: "Ref", value }),
  Sum: (value) => ({
    tag: "Sum",
    value
  }),
  Product: (value) => ({
    tag: "Product",
    value
  }),
  Array: (value) => ({
    tag: "Array",
    value
  }),
  String: { tag: "String" },
  Bool: { tag: "Bool" },
  I8: { tag: "I8" },
  U8: { tag: "U8" },
  I16: { tag: "I16" },
  U16: { tag: "U16" },
  I32: { tag: "I32" },
  U32: { tag: "U32" },
  I64: { tag: "I64" },
  U64: { tag: "U64" },
  I128: { tag: "I128" },
  U128: { tag: "U128" },
  I256: { tag: "I256" },
  U256: { tag: "U256" },
  F32: { tag: "F32" },
  F64: { tag: "F64" },
  makeSerializer(ty, typespace) {
    if (ty.tag === "Ref") {
      if (!typespace)
        throw new Error("cannot serialize refs without a typespace");
      while (ty.tag === "Ref") ty = typespace.types[ty.value];
    }
    switch (ty.tag) {
      case "Product":
        return ProductType.makeSerializer(ty.value, typespace);
      case "Sum":
        return SumType.makeSerializer(ty.value, typespace);
      case "Array":
        if (ty.value.tag === "U8") {
          return serializeUint8Array;
        } else {
          const serialize = AlgebraicType.makeSerializer(ty.value, typespace);
          return (writer, value) => {
            writer.writeU32(value.length);
            for (const elem of value) {
              serialize(writer, elem);
            }
          };
        }
      default:
        return primitiveSerializers[ty.tag];
    }
  },
  /** @deprecated Use `makeSerializer` instead. */
  serializeValue(writer, ty, value, typespace) {
    AlgebraicType.makeSerializer(ty, typespace)(writer, value);
  },
  makeDeserializer(ty, typespace) {
    if (ty.tag === "Ref") {
      if (!typespace)
        throw new Error("cannot deserialize refs without a typespace");
      while (ty.tag === "Ref") ty = typespace.types[ty.value];
    }
    switch (ty.tag) {
      case "Product":
        return ProductType.makeDeserializer(ty.value, typespace);
      case "Sum":
        return SumType.makeDeserializer(ty.value, typespace);
      case "Array":
        if (ty.value.tag === "U8") {
          return deserializeUint8Array;
        } else {
          const deserialize = AlgebraicType.makeDeserializer(
            ty.value,
            typespace
          );
          return (reader) => {
            const length = reader.readU32();
            const result = Array(length);
            for (let i = 0; i < length; i++) {
              result[i] = deserialize(reader);
            }
            return result;
          };
        }
      default:
        return primitiveDeserializers[ty.tag];
    }
  },
  /** @deprecated Use `makeDeserializer` instead. */
  deserializeValue(reader, ty, typespace) {
    return AlgebraicType.makeDeserializer(ty, typespace)(reader);
  },
  /**
   * Convert a value of the algebraic type into something that can be used as a key in a map.
   * There are no guarantees about being able to order it.
   * This is only guaranteed to be comparable to other values of the same type.
   * @param value A value of the algebraic type
   * @returns Something that can be used as a key in a map.
   */
  intoMapKey: function(ty, value) {
    switch (ty.tag) {
      case "U8":
      case "U16":
      case "U32":
      case "U64":
      case "U128":
      case "U256":
      case "I8":
      case "I16":
      case "I32":
      case "I64":
      case "I128":
      case "I256":
      case "F32":
      case "F64":
      case "String":
      case "Bool":
        return value;
      case "Product":
        return ProductType.intoMapKey(ty.value, value);
      default: {
        const writer = new BinaryWriter(10);
        AlgebraicType.serializeValue(writer, ty, value);
        return writer.toBase64();
      }
    }
  }
};
function bindCall(f) {
  return Function.prototype.call.bind(f);
}
var primitiveSerializers = {
  Bool: bindCall(BinaryWriter.prototype.writeBool),
  I8: bindCall(BinaryWriter.prototype.writeI8),
  U8: bindCall(BinaryWriter.prototype.writeU8),
  I16: bindCall(BinaryWriter.prototype.writeI16),
  U16: bindCall(BinaryWriter.prototype.writeU16),
  I32: bindCall(BinaryWriter.prototype.writeI32),
  U32: bindCall(BinaryWriter.prototype.writeU32),
  I64: bindCall(BinaryWriter.prototype.writeI64),
  U64: bindCall(BinaryWriter.prototype.writeU64),
  I128: bindCall(BinaryWriter.prototype.writeI128),
  U128: bindCall(BinaryWriter.prototype.writeU128),
  I256: bindCall(BinaryWriter.prototype.writeI256),
  U256: bindCall(BinaryWriter.prototype.writeU256),
  F32: bindCall(BinaryWriter.prototype.writeF32),
  F64: bindCall(BinaryWriter.prototype.writeF64),
  String: bindCall(BinaryWriter.prototype.writeString)
};
Object.freeze(primitiveSerializers);
var serializeUint8Array = bindCall(BinaryWriter.prototype.writeUInt8Array);
var primitiveDeserializers = {
  Bool: bindCall(BinaryReader.prototype.readBool),
  I8: bindCall(BinaryReader.prototype.readI8),
  U8: bindCall(BinaryReader.prototype.readU8),
  I16: bindCall(BinaryReader.prototype.readI16),
  U16: bindCall(BinaryReader.prototype.readU16),
  I32: bindCall(BinaryReader.prototype.readI32),
  U32: bindCall(BinaryReader.prototype.readU32),
  I64: bindCall(BinaryReader.prototype.readI64),
  U64: bindCall(BinaryReader.prototype.readU64),
  I128: bindCall(BinaryReader.prototype.readI128),
  U128: bindCall(BinaryReader.prototype.readU128),
  I256: bindCall(BinaryReader.prototype.readI256),
  U256: bindCall(BinaryReader.prototype.readU256),
  F32: bindCall(BinaryReader.prototype.readF32),
  F64: bindCall(BinaryReader.prototype.readF64),
  String: bindCall(BinaryReader.prototype.readString)
};
Object.freeze(primitiveDeserializers);
var deserializeUint8Array = bindCall(BinaryReader.prototype.readUInt8Array);
var primitiveSizes = {
  Bool: 1,
  I8: 1,
  U8: 1,
  I16: 2,
  U16: 2,
  I32: 4,
  U32: 4,
  I64: 8,
  U64: 8,
  I128: 16,
  U128: 16,
  I256: 32,
  U256: 32,
  F32: 4,
  F64: 8
};
var fixedSizePrimitives = new Set(Object.keys(primitiveSizes));
var isFixedSizeProduct = (ty) => ty.elements.every(
  ({ algebraicType }) => fixedSizePrimitives.has(algebraicType.tag)
);
var productSize = (ty) => ty.elements.reduce(
  (acc, { algebraicType }) => acc + primitiveSizes[algebraicType.tag],
  0
);
var primitiveJSName = {
  Bool: "Uint8",
  I8: "Int8",
  U8: "Uint8",
  I16: "Int16",
  U16: "Uint16",
  I32: "Int32",
  U32: "Uint32",
  I64: "BigInt64",
  U64: "BigUint64",
  F32: "Float32",
  F64: "Float64"
};
var specialProductDeserializers = {
  __time_duration_micros__: (reader) => new TimeDuration(reader.readI64()),
  __timestamp_micros_since_unix_epoch__: (reader) => new Timestamp(reader.readI64()),
  __identity__: (reader) => new Identity(reader.readU256()),
  __connection_id__: (reader) => new ConnectionId(reader.readU128()),
  __uuid__: (reader) => new Uuid(reader.readU128())
};
Object.freeze(specialProductDeserializers);
var unitDeserializer = () => ({});
var getElementInitializer = (element) => {
  let init;
  switch (element.algebraicType.tag) {
    case "String":
      init = "''";
      break;
    case "Bool":
      init = "false";
      break;
    case "I8":
    case "U8":
    case "I16":
    case "U16":
    case "I32":
    case "U32":
      init = "0";
      break;
    case "I64":
    case "U64":
    case "I128":
    case "U128":
    case "I256":
    case "U256":
      init = "0n";
      break;
    case "F32":
    case "F64":
      init = "0.0";
      break;
    default:
      init = "undefined";
  }
  return `${element.name}: ${init}`;
};
var ProductType = {
  makeSerializer(ty, typespace) {
    let serializer = SERIALIZERS.get(ty);
    if (serializer != null) return serializer;
    if (isFixedSizeProduct(ty)) {
      const size = productSize(ty);
      const body2 = `"use strict";
writer.expandBuffer(${size});
const view = writer.view;
${ty.elements.map(
        ({ name, algebraicType: { tag } }) => tag in primitiveJSName ? `view.set${primitiveJSName[tag]}(writer.offset, value.${name}, ${primitiveSizes[tag] > 1 ? "true" : ""});
writer.offset += ${primitiveSizes[tag]};` : `writer.write${tag}(value.${name});`
      ).join("\n")}`;
      serializer = Function("writer", "value", body2);
      SERIALIZERS.set(ty, serializer);
      return serializer;
    }
    const serializers = {};
    const body = '"use strict";\n' + ty.elements.map(
      (element) => `this.${element.name}(writer, value.${element.name});`
    ).join("\n");
    serializer = Function("writer", "value", body).bind(
      serializers
    );
    SERIALIZERS.set(ty, serializer);
    for (const { name, algebraicType } of ty.elements) {
      serializers[name] = AlgebraicType.makeSerializer(
        algebraicType,
        typespace
      );
    }
    Object.freeze(serializers);
    return serializer;
  },
  /** @deprecated Use `makeSerializer` instead. */
  serializeValue(writer, ty, value, typespace) {
    ProductType.makeSerializer(ty, typespace)(writer, value);
  },
  makeDeserializer(ty, typespace) {
    switch (ty.elements.length) {
      case 0:
        return unitDeserializer;
      case 1: {
        const fieldName = ty.elements[0].name;
        if (hasOwn(specialProductDeserializers, fieldName))
          return specialProductDeserializers[fieldName];
      }
    }
    let deserializer = DESERIALIZERS.get(ty);
    if (deserializer != null) return deserializer;
    if (isFixedSizeProduct(ty)) {
      const body = `"use strict";
const result = { ${ty.elements.map(getElementInitializer).join(", ")} };
const view = reader.view;
${ty.elements.map(
        ({ name, algebraicType: { tag } }) => tag in primitiveJSName ? tag === "Bool" ? `result.${name} = view.getUint8(reader.offset) !== 0;
reader.offset += 1;` : `result.${name} = view.get${primitiveJSName[tag]}(reader.offset, ${primitiveSizes[tag] > 1 ? "true" : ""});
reader.offset += ${primitiveSizes[tag]};` : `result.${name} = reader.read${tag}();`
      ).join("\n")}
return result;`;
      deserializer = Function("reader", body);
      DESERIALIZERS.set(ty, deserializer);
      return deserializer;
    }
    const deserializers = {};
    deserializer = Function(
      "reader",
      `"use strict";
const result = { ${ty.elements.map(getElementInitializer).join(", ")} };
${ty.elements.map(({ name }) => `result.${name} = this.${name}(reader);`).join("\n")}
return result;`
    ).bind(deserializers);
    DESERIALIZERS.set(ty, deserializer);
    for (const { name, algebraicType } of ty.elements) {
      deserializers[name] = AlgebraicType.makeDeserializer(
        algebraicType,
        typespace
      );
    }
    Object.freeze(deserializers);
    return deserializer;
  },
  /** @deprecated Use `makeDeserializer` instead. */
  deserializeValue(reader, ty, typespace) {
    return ProductType.makeDeserializer(ty, typespace)(reader);
  },
  intoMapKey(ty, value) {
    if (ty.elements.length === 1) {
      const fieldName = ty.elements[0].name;
      if (hasOwn(specialProductDeserializers, fieldName)) {
        return value[fieldName];
      }
    }
    const writer = new BinaryWriter(10);
    AlgebraicType.serializeValue(writer, AlgebraicType.Product(ty), value);
    return writer.toBase64();
  }
};
var SumType = {
  makeSerializer(ty, typespace) {
    if (ty.variants.length == 2 && ty.variants[0].name === "some" && ty.variants[1].name === "none") {
      const serialize = AlgebraicType.makeSerializer(
        ty.variants[0].algebraicType,
        typespace
      );
      return (writer, value) => {
        if (value !== null && value !== void 0) {
          writer.writeByte(0);
          serialize(writer, value);
        } else {
          writer.writeByte(1);
        }
      };
    } else if (ty.variants.length == 2 && ty.variants[0].name === "ok" && ty.variants[1].name === "err") {
      const serializeOk = AlgebraicType.makeSerializer(
        ty.variants[0].algebraicType,
        typespace
      );
      const serializeErr = AlgebraicType.makeSerializer(
        ty.variants[0].algebraicType,
        typespace
      );
      return (writer, value) => {
        if ("ok" in value) {
          writer.writeU8(0);
          serializeOk(writer, value.ok);
        } else if ("err" in value) {
          writer.writeU8(1);
          serializeErr(writer, value.err);
        } else {
          throw new TypeError(
            "could not serialize result: object had neither a `ok` nor an `err` field"
          );
        }
      };
    } else {
      let serializer = SERIALIZERS.get(ty);
      if (serializer != null) return serializer;
      const serializers = {};
      const body = `switch (value.tag) {
${ty.variants.map(
        ({ name }, i) => `  case ${JSON.stringify(name)}:
    writer.writeByte(${i});
    return this.${name}(writer, value.value);`
      ).join("\n")}
  default:
    throw new TypeError(
      \`Could not serialize sum type; unknown tag \${value.tag}\`
    )
}
`;
      serializer = Function("writer", "value", body).bind(
        serializers
      );
      SERIALIZERS.set(ty, serializer);
      for (const { name, algebraicType } of ty.variants) {
        serializers[name] = AlgebraicType.makeSerializer(
          algebraicType,
          typespace
        );
      }
      Object.freeze(serializers);
      return serializer;
    }
  },
  /** @deprecated Use `makeSerializer` instead. */
  serializeValue(writer, ty, value, typespace) {
    SumType.makeSerializer(ty, typespace)(writer, value);
  },
  makeDeserializer(ty, typespace) {
    if (ty.variants.length == 2 && ty.variants[0].name === "some" && ty.variants[1].name === "none") {
      const deserialize = AlgebraicType.makeDeserializer(
        ty.variants[0].algebraicType,
        typespace
      );
      return (reader) => {
        const tag = reader.readU8();
        if (tag === 0) {
          return deserialize(reader);
        } else if (tag === 1) {
          return void 0;
        } else {
          throw `Can't deserialize an option type, couldn't find ${tag} tag`;
        }
      };
    } else if (ty.variants.length == 2 && ty.variants[0].name === "ok" && ty.variants[1].name === "err") {
      const deserializeOk = AlgebraicType.makeDeserializer(
        ty.variants[0].algebraicType,
        typespace
      );
      const deserializeErr = AlgebraicType.makeDeserializer(
        ty.variants[1].algebraicType,
        typespace
      );
      return (reader) => {
        const tag = reader.readByte();
        if (tag === 0) {
          return { ok: deserializeOk(reader) };
        } else if (tag === 1) {
          return { err: deserializeErr(reader) };
        } else {
          throw `Can't deserialize a result type, couldn't find ${tag} tag`;
        }
      };
    } else {
      let deserializer = DESERIALIZERS.get(ty);
      if (deserializer != null) return deserializer;
      const deserializers = {};
      deserializer = Function(
        "reader",
        `switch (reader.readU8()) {
${ty.variants.map(
          ({ name }, i) => `case ${i}: return { tag: ${JSON.stringify(name)}, value: this.${name}(reader) };`
        ).join("\n")} }`
      ).bind(deserializers);
      DESERIALIZERS.set(ty, deserializer);
      for (const { name, algebraicType } of ty.variants) {
        deserializers[name] = AlgebraicType.makeDeserializer(
          algebraicType,
          typespace
        );
      }
      Object.freeze(deserializers);
      return deserializer;
    }
  },
  /** @deprecated Use `makeDeserializer` instead. */
  deserializeValue(reader, ty, typespace) {
    return SumType.makeDeserializer(ty, typespace)(reader);
  }
};
var ConnectionId = class _ConnectionId {
  __connection_id__;
  /**
   * Creates a new `ConnectionId`.
   */
  constructor(data) {
    this.__connection_id__ = coerceToBigInt(data, "ConnectionId");
  }
  /**
   * Get the algebraic type representation of the {@link ConnectionId} type.
   * @returns The algebraic type representation of the type.
   */
  static getAlgebraicType() {
    return AlgebraicType.Product({
      elements: [
        { name: "__connection_id__", algebraicType: AlgebraicType.U128 }
      ]
    });
  }
  isZero() {
    return this.__connection_id__ === BigInt(0);
  }
  static nullIfZero(addr) {
    if (addr.isZero()) {
      return null;
    } else {
      return addr;
    }
  }
  static random() {
    function randomU8() {
      return Math.floor(Math.random() * 255);
    }
    let result = BigInt(0);
    for (let i = 0; i < 16; i++) {
      result = result << BigInt(8) | BigInt(randomU8());
    }
    return new _ConnectionId(result);
  }
  /**
   * Compare two connection IDs for equality.
   */
  isEqual(other) {
    return this.__connection_id__ == other.__connection_id__;
  }
  /**
   * Check if two connection IDs are equal.
   */
  equals(other) {
    return this.isEqual(other);
  }
  /**
   * Print the connection ID as a hexadecimal string.
   */
  toHexString() {
    return u128ToHexString(this.__connection_id__);
  }
  /**
   * Convert the connection ID to a Uint8Array.
   */
  toUint8Array() {
    return u128ToUint8Array(this.__connection_id__);
  }
  /**
   * Parse a connection ID from a hexadecimal string.
   */
  static fromString(str) {
    return new _ConnectionId(hexStringToU128(str));
  }
  static fromStringOrNull(str) {
    const addr = _ConnectionId.fromString(str);
    if (addr.isZero()) {
      return null;
    } else {
      return addr;
    }
  }
};
var SenderError = class extends Error {
  constructor(message) {
    super(message);
  }
  get name() {
    return "SenderError";
  }
};
var InternalError = class extends Error {
  constructor(message) {
    super(message);
  }
  get name() {
    return "InternalError";
  }
};
var ScheduleAt = {
  interval(value) {
    return Interval(value);
  },
  time(value) {
    return Time(value);
  },
  getAlgebraicType() {
    return AlgebraicType.Sum({
      variants: [
        {
          name: "Interval",
          algebraicType: TimeDuration.getAlgebraicType()
        },
        { name: "Time", algebraicType: Timestamp.getAlgebraicType() }
      ]
    });
  },
  isScheduleAt(algebraicType) {
    if (algebraicType.tag !== "Sum") {
      return false;
    }
    const variants = algebraicType.value.variants;
    if (variants.length !== 2) {
      return false;
    }
    const intervalVariant = variants.find((v) => v.name === "Interval");
    const timeVariant = variants.find((v) => v.name === "Time");
    if (!intervalVariant || !timeVariant) {
      return false;
    }
    return TimeDuration.isTimeDuration(intervalVariant.algebraicType) && Timestamp.isTimestamp(timeVariant.algebraicType);
  }
};
var Interval = (micros) => ({
  tag: "Interval",
  value: new TimeDuration(micros)
});
var Time = (microsSinceUnixEpoch) => ({
  tag: "Time",
  value: new Timestamp(microsSinceUnixEpoch)
});
var schedule_at_default = ScheduleAt;
var Option = {
  getAlgebraicType(innerType) {
    return AlgebraicType.Sum({
      variants: [
        { name: "some", algebraicType: innerType },
        {
          name: "none",
          algebraicType: AlgebraicType.Product({ elements: [] })
        }
      ]
    });
  }
};
var Result = {
  getAlgebraicType(okType, errType) {
    return AlgebraicType.Sum({
      variants: [
        { name: "ok", algebraicType: okType },
        { name: "err", algebraicType: errType }
      ]
    });
  }
};
var QueryBrand = Symbol("QueryBrand");
var isRowTypedQuery = (val) => !!val && typeof val === "object" && QueryBrand in val;
function toSql(q) {
  return q.toSql();
}
var SemijoinImpl = class _SemijoinImpl {
  constructor(sourceQuery, filterQuery, joinCondition) {
    this.sourceQuery = sourceQuery;
    this.filterQuery = filterQuery;
    this.joinCondition = joinCondition;
    if (sourceQuery.table.sourceName === filterQuery.table.sourceName) {
      throw new Error("Cannot semijoin a table to itself");
    }
  }
  [QueryBrand] = true;
  type = "semijoin";
  build() {
    return this;
  }
  where(predicate) {
    const nextSourceQuery = this.sourceQuery.where(predicate);
    return new _SemijoinImpl(
      nextSourceQuery,
      this.filterQuery,
      this.joinCondition
    );
  }
  toSql() {
    const left = this.filterQuery;
    const right = this.sourceQuery;
    const leftTable = quoteIdentifier(left.table.sourceName);
    const rightTable = quoteIdentifier(right.table.sourceName);
    let sql = `SELECT ${rightTable}.* FROM ${leftTable} JOIN ${rightTable} ON ${booleanExprToSql(this.joinCondition)}`;
    const clauses = [];
    if (left.whereClause) {
      clauses.push(booleanExprToSql(left.whereClause));
    }
    if (right.whereClause) {
      clauses.push(booleanExprToSql(right.whereClause));
    }
    if (clauses.length > 0) {
      const whereSql = clauses.length === 1 ? clauses[0] : clauses.map(wrapInParens).join(" AND ");
      sql += ` WHERE ${whereSql}`;
    }
    return sql;
  }
};
var FromBuilder = class _FromBuilder {
  constructor(table2, whereClause) {
    this.table = table2;
    this.whereClause = whereClause;
  }
  [QueryBrand] = true;
  where(predicate) {
    const newCondition = normalizePredicateExpr(predicate(this.table.cols));
    const nextWhere = this.whereClause ? this.whereClause.and(newCondition) : newCondition;
    return new _FromBuilder(this.table, nextWhere);
  }
  rightSemijoin(right, on) {
    const sourceQuery = new _FromBuilder(right);
    const joinCondition = on(
      this.table.indexedCols,
      right.indexedCols
    );
    return new SemijoinImpl(sourceQuery, this, joinCondition);
  }
  leftSemijoin(right, on) {
    const filterQuery = new _FromBuilder(right);
    const joinCondition = on(
      this.table.indexedCols,
      right.indexedCols
    );
    return new SemijoinImpl(this, filterQuery, joinCondition);
  }
  toSql() {
    return renderSelectSqlWithJoins(this.table, this.whereClause);
  }
  build() {
    return this;
  }
};
var TableRefImpl = class {
  [QueryBrand] = true;
  type = "table";
  sourceName;
  accessorName;
  cols;
  indexedCols;
  tableDef;
  // Delegate UntypedTableDef properties from tableDef so this can be used as a table def.
  get columns() {
    return this.tableDef.columns;
  }
  get indexes() {
    return this.tableDef.indexes;
  }
  get rowType() {
    return this.tableDef.rowType;
  }
  get constraints() {
    return this.tableDef.constraints;
  }
  constructor(tableDef) {
    this.sourceName = tableDef.sourceName;
    this.accessorName = tableDef.accessorName;
    this.cols = createRowExpr(tableDef);
    this.indexedCols = this.cols;
    this.tableDef = tableDef;
    Object.freeze(this);
  }
  asFrom() {
    return new FromBuilder(this);
  }
  rightSemijoin(other, on) {
    return this.asFrom().rightSemijoin(other, on);
  }
  leftSemijoin(other, on) {
    return this.asFrom().leftSemijoin(other, on);
  }
  build() {
    return this.asFrom().build();
  }
  toSql() {
    return this.asFrom().toSql();
  }
  where(predicate) {
    return this.asFrom().where(predicate);
  }
};
function createTableRefFromDef(tableDef) {
  return new TableRefImpl(tableDef);
}
function makeQueryBuilder(schema2) {
  const qb = /* @__PURE__ */ Object.create(null);
  for (const table2 of Object.values(schema2.tables)) {
    const ref = createTableRefFromDef(
      table2
    );
    qb[table2.accessorName] = ref;
  }
  return Object.freeze(qb);
}
function makeFromBuilder(tables2) {
  const result = /* @__PURE__ */ Object.create(null);
  const namespaces = /* @__PURE__ */ Object.create(
    null
  );
  for (const table2 of Object.values(tables2)) {
    const dotIdx = table2.sourceName.indexOf(".");
    if (dotIdx === -1) {
      result[table2.accessorName] = createTableRefFromDef(table2);
    } else {
      const ns = table2.sourceName.slice(0, dotIdx);
      const key = table2.sourceName.slice(dotIdx + 1);
      (namespaces[ns] ??= /* @__PURE__ */ Object.create(null))[key] = createTableRefFromDef(
        table2
      );
    }
  }
  for (const [ns, nsTables] of Object.entries(namespaces)) {
    result[ns] = Object.freeze(nsTables);
  }
  return Object.freeze(result);
}
function createRowExpr(tableDef) {
  const row = {};
  for (const columnName of Object.keys(tableDef.columns)) {
    const columnBuilder = tableDef.columns[columnName];
    const column = new ColumnExpression(
      tableDef.sourceName,
      columnName,
      columnBuilder.typeBuilder.algebraicType,
      columnBuilder.columnMetadata.name
    );
    row[columnName] = Object.freeze(column);
  }
  return Object.freeze(row);
}
function renderSelectSqlWithJoins(table2, where, extraClauses = []) {
  const quotedTable = quoteIdentifier(table2.sourceName);
  const sql = `SELECT * FROM ${quotedTable}`;
  const clauses = [];
  if (where) clauses.push(booleanExprToSql(where));
  clauses.push(...extraClauses);
  if (clauses.length === 0) return sql;
  const whereSql = clauses.length === 1 ? clauses[0] : clauses.map(wrapInParens).join(" AND ");
  return `${sql} WHERE ${whereSql}`;
}
var ColumnExpression = class {
  type = "column";
  // This is the column accessor
  column;
  // The name of the column in the database.
  columnName;
  table;
  // phantom: actual runtime value is undefined
  tsValueType;
  spacetimeType;
  constructor(table2, column, spacetimeType, columnName) {
    this.table = table2;
    this.column = column;
    this.columnName = columnName || column;
    this.spacetimeType = spacetimeType;
  }
  eq(x) {
    return new BooleanExpr({
      type: "eq",
      left: this,
      right: normalizeValue(x)
    });
  }
  ne(x) {
    return new BooleanExpr({
      type: "ne",
      left: this,
      right: normalizeValue(x)
    });
  }
  lt(x) {
    return new BooleanExpr({
      type: "lt",
      left: this,
      right: normalizeValue(x)
    });
  }
  lte(x) {
    return new BooleanExpr({
      type: "lte",
      left: this,
      right: normalizeValue(x)
    });
  }
  gt(x) {
    return new BooleanExpr({
      type: "gt",
      left: this,
      right: normalizeValue(x)
    });
  }
  gte(x) {
    return new BooleanExpr({
      type: "gte",
      left: this,
      right: normalizeValue(x)
    });
  }
};
function literal(value) {
  return { type: "literal", value };
}
function normalizeValue(val) {
  if (val.type === "literal")
    return val;
  if (typeof val === "object" && val != null && "type" in val && val.type === "column") {
    return val;
  }
  return literal(val);
}
function normalizePredicateExpr(value) {
  if (value instanceof BooleanExpr) return value;
  if (typeof value === "boolean") {
    return new BooleanExpr({
      type: "eq",
      left: literal(value),
      right: literal(true)
    });
  }
  return new BooleanExpr({
    type: "eq",
    left: value,
    right: literal(true)
  });
}
var BooleanExpr = class _BooleanExpr {
  constructor(data) {
    this.data = data;
  }
  and(other) {
    return new _BooleanExpr({
      type: "and",
      clauses: [this.data, other.data]
    });
  }
  or(other) {
    return new _BooleanExpr({
      type: "or",
      clauses: [this.data, other.data]
    });
  }
  not() {
    return new _BooleanExpr({ type: "not", clause: this.data });
  }
};
function booleanExprToSql(expr, tableAlias) {
  const data = expr instanceof BooleanExpr ? expr.data : expr;
  switch (data.type) {
    case "eq":
      return `${valueExprToSql(data.left)} = ${valueExprToSql(data.right)}`;
    case "ne":
      return `${valueExprToSql(data.left)} <> ${valueExprToSql(data.right)}`;
    case "gt":
      return `${valueExprToSql(data.left)} > ${valueExprToSql(data.right)}`;
    case "gte":
      return `${valueExprToSql(data.left)} >= ${valueExprToSql(data.right)}`;
    case "lt":
      return `${valueExprToSql(data.left)} < ${valueExprToSql(data.right)}`;
    case "lte":
      return `${valueExprToSql(data.left)} <= ${valueExprToSql(data.right)}`;
    case "and":
      return data.clauses.map((c) => booleanExprToSql(c)).map(wrapInParens).join(" AND ");
    case "or":
      return data.clauses.map((c) => booleanExprToSql(c)).map(wrapInParens).join(" OR ");
    case "not":
      return `NOT ${wrapInParens(booleanExprToSql(data.clause))}`;
  }
}
function wrapInParens(sql) {
  return `(${sql})`;
}
function valueExprToSql(expr, tableAlias) {
  if (isLiteralExpr(expr)) {
    return literalValueToSql(expr.value);
  }
  const table2 = expr.table;
  return `${quoteIdentifier(table2)}.${quoteIdentifier(expr.columnName)}`;
}
function literalValueToSql(value) {
  if (value === null || value === void 0) {
    return "NULL";
  }
  if (value instanceof Identity || value instanceof ConnectionId || value instanceof Uuid) {
    return `0x${value.toHexString()}`;
  }
  if (value instanceof Timestamp) {
    return `'${value.toISOString()}'`;
  }
  switch (typeof value) {
    case "number":
    case "bigint":
      return String(value);
    case "boolean":
      return value ? "TRUE" : "FALSE";
    case "string":
      return `'${value.replace(/'/g, "''")}'`;
    default:
      return `'${JSON.stringify(value).replace(/'/g, "''")}'`;
  }
}
function quoteIdentifier(name) {
  return name.split(".").map((part) => `"${part.replace(/"/g, '""')}"`).join(".");
}
function isLiteralExpr(expr) {
  return expr.type === "literal";
}
function set(x, t2) {
  return { ...x, ...t2 };
}
var TypeBuilder = class {
  /**
   * The TypeScript phantom type. This is not stored at runtime,
   * but is visible to the compiler
   */
  type;
  /**
   * The SpacetimeDB algebraic type (run‑time value). In addition to storing
   * the runtime representation of the `AlgebraicType`, it also captures
   * the TypeScript type information of the `AlgebraicType`. That is to say
   * the value is not merely an `AlgebraicType`, but is constructed to be
   * the corresponding concrete `AlgebraicType` for the TypeScript type `Type`.
   *
   * e.g. `string` corresponds to `AlgebraicType.String`
   */
  algebraicType;
  constructor(algebraicType) {
    this.algebraicType = algebraicType;
  }
  optional() {
    return new OptionBuilder(this);
  }
  serialize(writer, value) {
    const serialize = this.serialize = AlgebraicType.makeSerializer(
      this.algebraicType
    );
    serialize(writer, value);
  }
  deserialize(reader) {
    const deserialize = this.deserialize = AlgebraicType.makeDeserializer(
      this.algebraicType
    );
    return deserialize(reader);
  }
};
var U8Builder = class extends TypeBuilder {
  constructor() {
    super(AlgebraicType.U8);
  }
  index(algorithm = "btree") {
    return new U8ColumnBuilder(
      this,
      set(defaultMetadata, { indexType: algorithm })
    );
  }
  unique() {
    return new U8ColumnBuilder(this, set(defaultMetadata, { isUnique: true }));
  }
  primaryKey() {
    return new U8ColumnBuilder(
      this,
      set(defaultMetadata, { isPrimaryKey: true })
    );
  }
  autoInc() {
    return new U8ColumnBuilder(
      this,
      set(defaultMetadata, { isAutoIncrement: true })
    );
  }
  default(value) {
    return new U8ColumnBuilder(
      this,
      set(defaultMetadata, { defaultValue: value })
    );
  }
  name(name) {
    return new U8ColumnBuilder(this, set(defaultMetadata, { name }));
  }
};
var U16Builder = class extends TypeBuilder {
  constructor() {
    super(AlgebraicType.U16);
  }
  index(algorithm = "btree") {
    return new U16ColumnBuilder(
      this,
      set(defaultMetadata, { indexType: algorithm })
    );
  }
  unique() {
    return new U16ColumnBuilder(this, set(defaultMetadata, { isUnique: true }));
  }
  primaryKey() {
    return new U16ColumnBuilder(
      this,
      set(defaultMetadata, { isPrimaryKey: true })
    );
  }
  autoInc() {
    return new U16ColumnBuilder(
      this,
      set(defaultMetadata, { isAutoIncrement: true })
    );
  }
  default(value) {
    return new U16ColumnBuilder(
      this,
      set(defaultMetadata, { defaultValue: value })
    );
  }
  name(name) {
    return new U16ColumnBuilder(this, set(defaultMetadata, { name }));
  }
};
var U32Builder = class extends TypeBuilder {
  constructor() {
    super(AlgebraicType.U32);
  }
  index(algorithm = "btree") {
    return new U32ColumnBuilder(
      this,
      set(defaultMetadata, { indexType: algorithm })
    );
  }
  unique() {
    return new U32ColumnBuilder(this, set(defaultMetadata, { isUnique: true }));
  }
  primaryKey() {
    return new U32ColumnBuilder(
      this,
      set(defaultMetadata, { isPrimaryKey: true })
    );
  }
  autoInc() {
    return new U32ColumnBuilder(
      this,
      set(defaultMetadata, { isAutoIncrement: true })
    );
  }
  default(value) {
    return new U32ColumnBuilder(
      this,
      set(defaultMetadata, { defaultValue: value })
    );
  }
  name(name) {
    return new U32ColumnBuilder(this, set(defaultMetadata, { name }));
  }
};
var U64Builder = class extends TypeBuilder {
  constructor() {
    super(AlgebraicType.U64);
  }
  index(algorithm = "btree") {
    return new U64ColumnBuilder(
      this,
      set(defaultMetadata, { indexType: algorithm })
    );
  }
  unique() {
    return new U64ColumnBuilder(this, set(defaultMetadata, { isUnique: true }));
  }
  primaryKey() {
    return new U64ColumnBuilder(
      this,
      set(defaultMetadata, { isPrimaryKey: true })
    );
  }
  autoInc() {
    return new U64ColumnBuilder(
      this,
      set(defaultMetadata, { isAutoIncrement: true })
    );
  }
  default(value) {
    return new U64ColumnBuilder(
      this,
      set(defaultMetadata, { defaultValue: value })
    );
  }
  name(name) {
    return new U64ColumnBuilder(this, set(defaultMetadata, { name }));
  }
};
var U128Builder = class extends TypeBuilder {
  constructor() {
    super(AlgebraicType.U128);
  }
  index(algorithm = "btree") {
    return new U128ColumnBuilder(
      this,
      set(defaultMetadata, { indexType: algorithm })
    );
  }
  unique() {
    return new U128ColumnBuilder(
      this,
      set(defaultMetadata, { isUnique: true })
    );
  }
  primaryKey() {
    return new U128ColumnBuilder(
      this,
      set(defaultMetadata, { isPrimaryKey: true })
    );
  }
  autoInc() {
    return new U128ColumnBuilder(
      this,
      set(defaultMetadata, { isAutoIncrement: true })
    );
  }
  default(value) {
    return new U128ColumnBuilder(
      this,
      set(defaultMetadata, { defaultValue: value })
    );
  }
  name(name) {
    return new U128ColumnBuilder(this, set(defaultMetadata, { name }));
  }
};
var U256Builder = class extends TypeBuilder {
  constructor() {
    super(AlgebraicType.U256);
  }
  index(algorithm = "btree") {
    return new U256ColumnBuilder(
      this,
      set(defaultMetadata, { indexType: algorithm })
    );
  }
  unique() {
    return new U256ColumnBuilder(
      this,
      set(defaultMetadata, { isUnique: true })
    );
  }
  primaryKey() {
    return new U256ColumnBuilder(
      this,
      set(defaultMetadata, { isPrimaryKey: true })
    );
  }
  autoInc() {
    return new U256ColumnBuilder(
      this,
      set(defaultMetadata, { isAutoIncrement: true })
    );
  }
  default(value) {
    return new U256ColumnBuilder(
      this,
      set(defaultMetadata, { defaultValue: value })
    );
  }
  name(name) {
    return new U256ColumnBuilder(this, set(defaultMetadata, { name }));
  }
};
var I8Builder = class extends TypeBuilder {
  constructor() {
    super(AlgebraicType.I8);
  }
  index(algorithm = "btree") {
    return new I8ColumnBuilder(
      this,
      set(defaultMetadata, { indexType: algorithm })
    );
  }
  unique() {
    return new I8ColumnBuilder(this, set(defaultMetadata, { isUnique: true }));
  }
  primaryKey() {
    return new I8ColumnBuilder(
      this,
      set(defaultMetadata, { isPrimaryKey: true })
    );
  }
  autoInc() {
    return new I8ColumnBuilder(
      this,
      set(defaultMetadata, { isAutoIncrement: true })
    );
  }
  default(value) {
    return new I8ColumnBuilder(
      this,
      set(defaultMetadata, { defaultValue: value })
    );
  }
  name(name) {
    return new I8ColumnBuilder(this, set(defaultMetadata, { name }));
  }
};
var I16Builder = class extends TypeBuilder {
  constructor() {
    super(AlgebraicType.I16);
  }
  index(algorithm = "btree") {
    return new I16ColumnBuilder(
      this,
      set(defaultMetadata, { indexType: algorithm })
    );
  }
  unique() {
    return new I16ColumnBuilder(this, set(defaultMetadata, { isUnique: true }));
  }
  primaryKey() {
    return new I16ColumnBuilder(
      this,
      set(defaultMetadata, { isPrimaryKey: true })
    );
  }
  autoInc() {
    return new I16ColumnBuilder(
      this,
      set(defaultMetadata, { isAutoIncrement: true })
    );
  }
  default(value) {
    return new I16ColumnBuilder(
      this,
      set(defaultMetadata, { defaultValue: value })
    );
  }
  name(name) {
    return new I16ColumnBuilder(this, set(defaultMetadata, { name }));
  }
};
var I32Builder = class extends TypeBuilder {
  constructor() {
    super(AlgebraicType.I32);
  }
  index(algorithm = "btree") {
    return new I32ColumnBuilder(
      this,
      set(defaultMetadata, { indexType: algorithm })
    );
  }
  unique() {
    return new I32ColumnBuilder(this, set(defaultMetadata, { isUnique: true }));
  }
  primaryKey() {
    return new I32ColumnBuilder(
      this,
      set(defaultMetadata, { isPrimaryKey: true })
    );
  }
  autoInc() {
    return new I32ColumnBuilder(
      this,
      set(defaultMetadata, { isAutoIncrement: true })
    );
  }
  default(value) {
    return new I32ColumnBuilder(
      this,
      set(defaultMetadata, { defaultValue: value })
    );
  }
  name(name) {
    return new I32ColumnBuilder(this, set(defaultMetadata, { name }));
  }
};
var I64Builder = class extends TypeBuilder {
  constructor() {
    super(AlgebraicType.I64);
  }
  index(algorithm = "btree") {
    return new I64ColumnBuilder(
      this,
      set(defaultMetadata, { indexType: algorithm })
    );
  }
  unique() {
    return new I64ColumnBuilder(this, set(defaultMetadata, { isUnique: true }));
  }
  primaryKey() {
    return new I64ColumnBuilder(
      this,
      set(defaultMetadata, { isPrimaryKey: true })
    );
  }
  autoInc() {
    return new I64ColumnBuilder(
      this,
      set(defaultMetadata, { isAutoIncrement: true })
    );
  }
  default(value) {
    return new I64ColumnBuilder(
      this,
      set(defaultMetadata, { defaultValue: value })
    );
  }
  name(name) {
    return new I64ColumnBuilder(this, set(defaultMetadata, { name }));
  }
};
var I128Builder = class extends TypeBuilder {
  constructor() {
    super(AlgebraicType.I128);
  }
  index(algorithm = "btree") {
    return new I128ColumnBuilder(
      this,
      set(defaultMetadata, { indexType: algorithm })
    );
  }
  unique() {
    return new I128ColumnBuilder(
      this,
      set(defaultMetadata, { isUnique: true })
    );
  }
  primaryKey() {
    return new I128ColumnBuilder(
      this,
      set(defaultMetadata, { isPrimaryKey: true })
    );
  }
  autoInc() {
    return new I128ColumnBuilder(
      this,
      set(defaultMetadata, { isAutoIncrement: true })
    );
  }
  default(value) {
    return new I128ColumnBuilder(
      this,
      set(defaultMetadata, { defaultValue: value })
    );
  }
  name(name) {
    return new I128ColumnBuilder(this, set(defaultMetadata, { name }));
  }
};
var I256Builder = class extends TypeBuilder {
  constructor() {
    super(AlgebraicType.I256);
  }
  index(algorithm = "btree") {
    return new I256ColumnBuilder(
      this,
      set(defaultMetadata, { indexType: algorithm })
    );
  }
  unique() {
    return new I256ColumnBuilder(
      this,
      set(defaultMetadata, { isUnique: true })
    );
  }
  primaryKey() {
    return new I256ColumnBuilder(
      this,
      set(defaultMetadata, { isPrimaryKey: true })
    );
  }
  autoInc() {
    return new I256ColumnBuilder(
      this,
      set(defaultMetadata, { isAutoIncrement: true })
    );
  }
  default(value) {
    return new I256ColumnBuilder(
      this,
      set(defaultMetadata, { defaultValue: value })
    );
  }
  name(name) {
    return new I256ColumnBuilder(this, set(defaultMetadata, { name }));
  }
};
var F32Builder = class extends TypeBuilder {
  constructor() {
    super(AlgebraicType.F32);
  }
  default(value) {
    return new F32ColumnBuilder(
      this,
      set(defaultMetadata, { defaultValue: value })
    );
  }
  name(name) {
    return new F32ColumnBuilder(this, set(defaultMetadata, { name }));
  }
};
var F64Builder = class extends TypeBuilder {
  constructor() {
    super(AlgebraicType.F64);
  }
  default(value) {
    return new F64ColumnBuilder(
      this,
      set(defaultMetadata, { defaultValue: value })
    );
  }
  name(name) {
    return new F64ColumnBuilder(this, set(defaultMetadata, { name }));
  }
};
var BoolBuilder = class extends TypeBuilder {
  constructor() {
    super(AlgebraicType.Bool);
  }
  index(algorithm = "btree") {
    return new BoolColumnBuilder(
      this,
      set(defaultMetadata, { indexType: algorithm })
    );
  }
  unique() {
    return new BoolColumnBuilder(
      this,
      set(defaultMetadata, { isUnique: true })
    );
  }
  primaryKey() {
    return new BoolColumnBuilder(
      this,
      set(defaultMetadata, { isPrimaryKey: true })
    );
  }
  default(value) {
    return new BoolColumnBuilder(
      this,
      set(defaultMetadata, { defaultValue: value })
    );
  }
  name(name) {
    return new BoolColumnBuilder(this, set(defaultMetadata, { name }));
  }
};
var StringBuilder = class extends TypeBuilder {
  constructor() {
    super(AlgebraicType.String);
  }
  index(algorithm = "btree") {
    return new StringColumnBuilder(
      this,
      set(defaultMetadata, { indexType: algorithm })
    );
  }
  unique() {
    return new StringColumnBuilder(
      this,
      set(defaultMetadata, { isUnique: true })
    );
  }
  primaryKey() {
    return new StringColumnBuilder(
      this,
      set(defaultMetadata, { isPrimaryKey: true })
    );
  }
  default(value) {
    return new StringColumnBuilder(
      this,
      set(defaultMetadata, { defaultValue: value })
    );
  }
  name(name) {
    return new StringColumnBuilder(this, set(defaultMetadata, { name }));
  }
};
var ArrayBuilder = class extends TypeBuilder {
  element;
  constructor(element) {
    super(AlgebraicType.Array(element.algebraicType));
    this.element = element;
  }
  default(value) {
    return new ArrayColumnBuilder(
      this,
      set(defaultMetadata, { defaultValue: value })
    );
  }
  name(name) {
    return new ArrayColumnBuilder(this, set(defaultMetadata, { name }));
  }
};
var ByteArrayBuilder = class extends TypeBuilder {
  constructor() {
    super(AlgebraicType.Array(AlgebraicType.U8));
  }
  default(value) {
    return new ByteArrayColumnBuilder(
      set(defaultMetadata, { defaultValue: value })
    );
  }
  name(name) {
    return new ByteArrayColumnBuilder(set(defaultMetadata, { name }));
  }
};
var OptionBuilder = class extends TypeBuilder {
  value;
  constructor(value) {
    super(Option.getAlgebraicType(value.algebraicType));
    this.value = value;
  }
  default(value) {
    return new OptionColumnBuilder(
      this,
      set(defaultMetadata, { defaultValue: value })
    );
  }
  name(name) {
    return new OptionColumnBuilder(this, set(defaultMetadata, { name }));
  }
};
var ProductBuilder = class extends TypeBuilder {
  typeName;
  elements;
  constructor(elements, name) {
    function elementsArrayFromElementsObj(obj) {
      return Object.keys(obj).map((key) => ({
        name: key,
        // Lazily resolve the underlying object's algebraicType.
        // This will call obj[key].algebraicType only when someone
        // actually reads this property.
        get algebraicType() {
          return obj[key].algebraicType;
        }
      }));
    }
    super(
      AlgebraicType.Product({
        elements: elementsArrayFromElementsObj(elements)
      })
    );
    this.typeName = name;
    this.elements = elements;
  }
  default(value) {
    return new ProductColumnBuilder(
      this,
      set(defaultMetadata, { defaultValue: value })
    );
  }
  name(name) {
    return new ProductColumnBuilder(this, set(defaultMetadata, { name }));
  }
};
var ResultBuilder = class extends TypeBuilder {
  ok;
  err;
  constructor(ok, err) {
    super(Result.getAlgebraicType(ok.algebraicType, err.algebraicType));
    this.ok = ok;
    this.err = err;
  }
  default(value) {
    return new ResultColumnBuilder(this, set(defaultMetadata, { defaultValue: value }));
  }
};
var UnitBuilder = class extends TypeBuilder {
  constructor() {
    super({ tag: "Product", value: { elements: [] } });
  }
};
var RowBuilder = class extends TypeBuilder {
  row;
  typeName;
  constructor(row, name) {
    const mappedRow = Object.fromEntries(
      Object.entries(row).map(([colName, builder]) => [
        colName,
        builder instanceof ColumnBuilder ? builder : new ColumnBuilder(builder, {})
      ])
    );
    const elements = Object.keys(mappedRow).map((name2) => ({
      name: name2,
      get algebraicType() {
        return mappedRow[name2].typeBuilder.algebraicType;
      }
    }));
    super(AlgebraicType.Product({ elements }));
    this.row = mappedRow;
    this.typeName = name;
  }
};
var SumBuilderImpl = class extends TypeBuilder {
  variants;
  typeName;
  constructor(variants, name) {
    function variantsArrayFromVariantsObj(variants2) {
      return Object.keys(variants2).map((key) => ({
        name: key,
        // Lazily resolve the underlying object's algebraicType.
        // This will call obj[key].algebraicType only when someone
        // actually reads this property.
        get algebraicType() {
          return variants2[key].algebraicType;
        }
      }));
    }
    super(
      AlgebraicType.Sum({
        variants: variantsArrayFromVariantsObj(variants)
      })
    );
    this.variants = variants;
    this.typeName = name;
    for (const key of Object.keys(variants)) {
      const desc = Object.getOwnPropertyDescriptor(variants, key);
      const isAccessor = !!desc && (typeof desc.get === "function" || typeof desc.set === "function");
      let isUnit2 = false;
      if (!isAccessor) {
        const variant = variants[key];
        isUnit2 = variant instanceof UnitBuilder;
      }
      if (isUnit2) {
        const constant = this.create(key);
        Object.defineProperty(this, key, {
          value: constant,
          writable: false,
          enumerable: true,
          configurable: false
        });
      } else {
        const fn = (value) => this.create(key, value);
        Object.defineProperty(this, key, {
          value: fn,
          writable: false,
          enumerable: true,
          configurable: false
        });
      }
    }
  }
  create(tag, value) {
    return value === void 0 ? { tag } : { tag, value };
  }
  default(value) {
    return new SumColumnBuilder(
      this,
      set(defaultMetadata, { defaultValue: value })
    );
  }
  name(name) {
    return new SumColumnBuilder(this, set(defaultMetadata, { name }));
  }
  index(algorithm = "btree") {
    return new SumColumnBuilder(
      this,
      set(defaultMetadata, { indexType: algorithm })
    );
  }
  primaryKey() {
    return new SumColumnBuilder(
      this,
      set(defaultMetadata, { isPrimaryKey: true })
    );
  }
};
var SumBuilder = SumBuilderImpl;
var SimpleSumBuilderImpl = class extends SumBuilderImpl {
  index(algorithm = "btree") {
    return new SimpleSumColumnBuilder(
      this,
      set(defaultMetadata, { indexType: algorithm })
    );
  }
  primaryKey() {
    return new SimpleSumColumnBuilder(
      this,
      set(defaultMetadata, { isPrimaryKey: true })
    );
  }
};
var ScheduleAtBuilder = class extends TypeBuilder {
  constructor() {
    super(schedule_at_default.getAlgebraicType());
  }
  default(value) {
    return new ScheduleAtColumnBuilder(
      this,
      set(defaultMetadata, { defaultValue: value })
    );
  }
  name(name) {
    return new ScheduleAtColumnBuilder(this, set(defaultMetadata, { name }));
  }
};
var IdentityBuilder = class extends TypeBuilder {
  constructor() {
    super(Identity.getAlgebraicType());
  }
  index(algorithm = "btree") {
    return new IdentityColumnBuilder(
      this,
      set(defaultMetadata, { indexType: algorithm })
    );
  }
  unique() {
    return new IdentityColumnBuilder(
      this,
      set(defaultMetadata, { isUnique: true })
    );
  }
  primaryKey() {
    return new IdentityColumnBuilder(
      this,
      set(defaultMetadata, { isPrimaryKey: true })
    );
  }
  autoInc() {
    return new IdentityColumnBuilder(
      this,
      set(defaultMetadata, { isAutoIncrement: true })
    );
  }
  default(value) {
    return new IdentityColumnBuilder(
      this,
      set(defaultMetadata, { defaultValue: value })
    );
  }
  name(name) {
    return new IdentityColumnBuilder(this, set(defaultMetadata, { name }));
  }
};
var ConnectionIdBuilder = class extends TypeBuilder {
  constructor() {
    super(ConnectionId.getAlgebraicType());
  }
  index(algorithm = "btree") {
    return new ConnectionIdColumnBuilder(
      this,
      set(defaultMetadata, { indexType: algorithm })
    );
  }
  unique() {
    return new ConnectionIdColumnBuilder(
      this,
      set(defaultMetadata, { isUnique: true })
    );
  }
  primaryKey() {
    return new ConnectionIdColumnBuilder(
      this,
      set(defaultMetadata, { isPrimaryKey: true })
    );
  }
  autoInc() {
    return new ConnectionIdColumnBuilder(
      this,
      set(defaultMetadata, { isAutoIncrement: true })
    );
  }
  default(value) {
    return new ConnectionIdColumnBuilder(
      this,
      set(defaultMetadata, { defaultValue: value })
    );
  }
  name(name) {
    return new ConnectionIdColumnBuilder(this, set(defaultMetadata, { name }));
  }
};
var TimestampBuilder = class extends TypeBuilder {
  constructor() {
    super(Timestamp.getAlgebraicType());
  }
  index(algorithm = "btree") {
    return new TimestampColumnBuilder(
      this,
      set(defaultMetadata, { indexType: algorithm })
    );
  }
  unique() {
    return new TimestampColumnBuilder(
      this,
      set(defaultMetadata, { isUnique: true })
    );
  }
  primaryKey() {
    return new TimestampColumnBuilder(
      this,
      set(defaultMetadata, { isPrimaryKey: true })
    );
  }
  autoInc() {
    return new TimestampColumnBuilder(
      this,
      set(defaultMetadata, { isAutoIncrement: true })
    );
  }
  default(value) {
    return new TimestampColumnBuilder(
      this,
      set(defaultMetadata, { defaultValue: value })
    );
  }
  name(name) {
    return new TimestampColumnBuilder(this, set(defaultMetadata, { name }));
  }
};
var TimeDurationBuilder = class extends TypeBuilder {
  constructor() {
    super(TimeDuration.getAlgebraicType());
  }
  index(algorithm = "btree") {
    return new TimeDurationColumnBuilder(
      this,
      set(defaultMetadata, { indexType: algorithm })
    );
  }
  unique() {
    return new TimeDurationColumnBuilder(
      this,
      set(defaultMetadata, { isUnique: true })
    );
  }
  primaryKey() {
    return new TimeDurationColumnBuilder(
      this,
      set(defaultMetadata, { isPrimaryKey: true })
    );
  }
  autoInc() {
    return new TimeDurationColumnBuilder(
      this,
      set(defaultMetadata, { isAutoIncrement: true })
    );
  }
  default(value) {
    return new TimeDurationColumnBuilder(
      this,
      set(defaultMetadata, { defaultValue: value })
    );
  }
  name(name) {
    return new TimeDurationColumnBuilder(this, set(defaultMetadata, { name }));
  }
};
var UuidBuilder = class extends TypeBuilder {
  constructor() {
    super(Uuid.getAlgebraicType());
  }
  index(algorithm = "btree") {
    return new UuidColumnBuilder(
      this,
      set(defaultMetadata, { indexType: algorithm })
    );
  }
  unique() {
    return new UuidColumnBuilder(
      this,
      set(defaultMetadata, { isUnique: true })
    );
  }
  primaryKey() {
    return new UuidColumnBuilder(
      this,
      set(defaultMetadata, { isPrimaryKey: true })
    );
  }
  autoInc() {
    return new UuidColumnBuilder(
      this,
      set(defaultMetadata, { isAutoIncrement: true })
    );
  }
  default(value) {
    return new UuidColumnBuilder(
      this,
      set(defaultMetadata, { defaultValue: value })
    );
  }
  name(name) {
    return new UuidColumnBuilder(this, set(defaultMetadata, { name }));
  }
};
var defaultMetadata = {};
var ColumnBuilder = class {
  typeBuilder;
  columnMetadata;
  constructor(typeBuilder, metadata) {
    this.typeBuilder = typeBuilder;
    this.columnMetadata = metadata;
  }
  serialize(writer, value) {
    this.typeBuilder.serialize(writer, value);
  }
  deserialize(reader) {
    return this.typeBuilder.deserialize(reader);
  }
};
var U8ColumnBuilder = class _U8ColumnBuilder extends ColumnBuilder {
  index(algorithm = "btree") {
    return new _U8ColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { indexType: algorithm })
    );
  }
  unique() {
    return new _U8ColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { isUnique: true })
    );
  }
  primaryKey() {
    return new _U8ColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { isPrimaryKey: true })
    );
  }
  autoInc() {
    return new _U8ColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { isAutoIncrement: true })
    );
  }
  default(value) {
    return new _U8ColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, {
        defaultValue: value
      })
    );
  }
  name(name) {
    return new _U8ColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { name })
    );
  }
};
var U16ColumnBuilder = class _U16ColumnBuilder extends ColumnBuilder {
  index(algorithm = "btree") {
    return new _U16ColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { indexType: algorithm })
    );
  }
  unique() {
    return new _U16ColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { isUnique: true })
    );
  }
  primaryKey() {
    return new _U16ColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { isPrimaryKey: true })
    );
  }
  autoInc() {
    return new _U16ColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { isAutoIncrement: true })
    );
  }
  default(value) {
    return new _U16ColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, {
        defaultValue: value
      })
    );
  }
  name(name) {
    return new _U16ColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { name })
    );
  }
};
var U32ColumnBuilder = class _U32ColumnBuilder extends ColumnBuilder {
  index(algorithm = "btree") {
    return new _U32ColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { indexType: algorithm })
    );
  }
  unique() {
    return new _U32ColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { isUnique: true })
    );
  }
  primaryKey() {
    return new _U32ColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { isPrimaryKey: true })
    );
  }
  autoInc() {
    return new _U32ColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { isAutoIncrement: true })
    );
  }
  default(value) {
    return new _U32ColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, {
        defaultValue: value
      })
    );
  }
  name(name) {
    return new _U32ColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { name })
    );
  }
};
var U64ColumnBuilder = class _U64ColumnBuilder extends ColumnBuilder {
  index(algorithm = "btree") {
    return new _U64ColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { indexType: algorithm })
    );
  }
  unique() {
    return new _U64ColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { isUnique: true })
    );
  }
  primaryKey() {
    return new _U64ColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { isPrimaryKey: true })
    );
  }
  autoInc() {
    return new _U64ColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { isAutoIncrement: true })
    );
  }
  default(value) {
    return new _U64ColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, {
        defaultValue: value
      })
    );
  }
  name(name) {
    return new _U64ColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { name })
    );
  }
};
var U128ColumnBuilder = class _U128ColumnBuilder extends ColumnBuilder {
  index(algorithm = "btree") {
    return new _U128ColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { indexType: algorithm })
    );
  }
  unique() {
    return new _U128ColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { isUnique: true })
    );
  }
  primaryKey() {
    return new _U128ColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { isPrimaryKey: true })
    );
  }
  autoInc() {
    return new _U128ColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { isAutoIncrement: true })
    );
  }
  default(value) {
    return new _U128ColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, {
        defaultValue: value
      })
    );
  }
  name(name) {
    return new _U128ColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { name })
    );
  }
};
var U256ColumnBuilder = class _U256ColumnBuilder extends ColumnBuilder {
  index(algorithm = "btree") {
    return new _U256ColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { indexType: algorithm })
    );
  }
  unique() {
    return new _U256ColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { isUnique: true })
    );
  }
  primaryKey() {
    return new _U256ColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { isPrimaryKey: true })
    );
  }
  autoInc() {
    return new _U256ColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { isAutoIncrement: true })
    );
  }
  default(value) {
    return new _U256ColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, {
        defaultValue: value
      })
    );
  }
  name(name) {
    return new _U256ColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { name })
    );
  }
};
var I8ColumnBuilder = class _I8ColumnBuilder extends ColumnBuilder {
  index(algorithm = "btree") {
    return new _I8ColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { indexType: algorithm })
    );
  }
  unique() {
    return new _I8ColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { isUnique: true })
    );
  }
  primaryKey() {
    return new _I8ColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { isPrimaryKey: true })
    );
  }
  autoInc() {
    return new _I8ColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { isAutoIncrement: true })
    );
  }
  default(value) {
    return new _I8ColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, {
        defaultValue: value
      })
    );
  }
  name(name) {
    return new _I8ColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { name })
    );
  }
};
var I16ColumnBuilder = class _I16ColumnBuilder extends ColumnBuilder {
  index(algorithm = "btree") {
    return new _I16ColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { indexType: algorithm })
    );
  }
  unique() {
    return new _I16ColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { isUnique: true })
    );
  }
  primaryKey() {
    return new _I16ColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { isPrimaryKey: true })
    );
  }
  autoInc() {
    return new _I16ColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { isAutoIncrement: true })
    );
  }
  default(value) {
    return new _I16ColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, {
        defaultValue: value
      })
    );
  }
  name(name) {
    return new _I16ColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { name })
    );
  }
};
var I32ColumnBuilder = class _I32ColumnBuilder extends ColumnBuilder {
  index(algorithm = "btree") {
    return new _I32ColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { indexType: algorithm })
    );
  }
  unique() {
    return new _I32ColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { isUnique: true })
    );
  }
  primaryKey() {
    return new _I32ColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { isPrimaryKey: true })
    );
  }
  autoInc() {
    return new _I32ColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { isAutoIncrement: true })
    );
  }
  default(value) {
    return new _I32ColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, {
        defaultValue: value
      })
    );
  }
  name(name) {
    return new _I32ColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { name })
    );
  }
};
var I64ColumnBuilder = class _I64ColumnBuilder extends ColumnBuilder {
  index(algorithm = "btree") {
    return new _I64ColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { indexType: algorithm })
    );
  }
  unique() {
    return new _I64ColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { isUnique: true })
    );
  }
  primaryKey() {
    return new _I64ColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { isPrimaryKey: true })
    );
  }
  autoInc() {
    return new _I64ColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { isAutoIncrement: true })
    );
  }
  default(value) {
    return new _I64ColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, {
        defaultValue: value
      })
    );
  }
  name(name) {
    return new _I64ColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { name })
    );
  }
};
var I128ColumnBuilder = class _I128ColumnBuilder extends ColumnBuilder {
  index(algorithm = "btree") {
    return new _I128ColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { indexType: algorithm })
    );
  }
  unique() {
    return new _I128ColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { isUnique: true })
    );
  }
  primaryKey() {
    return new _I128ColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { isPrimaryKey: true })
    );
  }
  autoInc() {
    return new _I128ColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { isAutoIncrement: true })
    );
  }
  default(value) {
    return new _I128ColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, {
        defaultValue: value
      })
    );
  }
  name(name) {
    return new _I128ColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { name })
    );
  }
};
var I256ColumnBuilder = class _I256ColumnBuilder extends ColumnBuilder {
  index(algorithm = "btree") {
    return new _I256ColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { indexType: algorithm })
    );
  }
  unique() {
    return new _I256ColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { isUnique: true })
    );
  }
  primaryKey() {
    return new _I256ColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { isPrimaryKey: true })
    );
  }
  autoInc() {
    return new _I256ColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { isAutoIncrement: true })
    );
  }
  default(value) {
    return new _I256ColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, {
        defaultValue: value
      })
    );
  }
  name(name) {
    return new _I256ColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { name })
    );
  }
};
var F32ColumnBuilder = class _F32ColumnBuilder extends ColumnBuilder {
  default(value) {
    return new _F32ColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, {
        defaultValue: value
      })
    );
  }
  name(name) {
    return new _F32ColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { name })
    );
  }
};
var F64ColumnBuilder = class _F64ColumnBuilder extends ColumnBuilder {
  default(value) {
    return new _F64ColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, {
        defaultValue: value
      })
    );
  }
  name(name) {
    return new _F64ColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { name })
    );
  }
};
var BoolColumnBuilder = class _BoolColumnBuilder extends ColumnBuilder {
  index(algorithm = "btree") {
    return new _BoolColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { indexType: algorithm })
    );
  }
  unique() {
    return new _BoolColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { isUnique: true })
    );
  }
  primaryKey() {
    return new _BoolColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { isPrimaryKey: true })
    );
  }
  default(value) {
    return new _BoolColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, {
        defaultValue: value
      })
    );
  }
  name(name) {
    return new _BoolColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { name })
    );
  }
};
var StringColumnBuilder = class _StringColumnBuilder extends ColumnBuilder {
  index(algorithm = "btree") {
    return new _StringColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { indexType: algorithm })
    );
  }
  unique() {
    return new _StringColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { isUnique: true })
    );
  }
  primaryKey() {
    return new _StringColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { isPrimaryKey: true })
    );
  }
  default(value) {
    return new _StringColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, {
        defaultValue: value
      })
    );
  }
  name(name) {
    return new _StringColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { name })
    );
  }
};
var ArrayColumnBuilder = class _ArrayColumnBuilder extends ColumnBuilder {
  default(value) {
    return new _ArrayColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, {
        defaultValue: value
      })
    );
  }
  name(name) {
    return new _ArrayColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { name })
    );
  }
};
var ByteArrayColumnBuilder = class _ByteArrayColumnBuilder extends ColumnBuilder {
  constructor(metadata) {
    super(new TypeBuilder(AlgebraicType.Array(AlgebraicType.U8)), metadata);
  }
  default(value) {
    return new _ByteArrayColumnBuilder(
      set(this.columnMetadata, { defaultValue: value })
    );
  }
  name(name) {
    return new _ByteArrayColumnBuilder(set(this.columnMetadata, { name }));
  }
};
var OptionColumnBuilder = class _OptionColumnBuilder extends ColumnBuilder {
  default(value) {
    return new _OptionColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, {
        defaultValue: value
      })
    );
  }
  name(name) {
    return new _OptionColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { name })
    );
  }
};
var ResultColumnBuilder = class _ResultColumnBuilder extends ColumnBuilder {
  constructor(typeBuilder, metadata) {
    super(typeBuilder, metadata);
  }
  default(value) {
    return new _ResultColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, {
        defaultValue: value
      })
    );
  }
};
var ProductColumnBuilder = class _ProductColumnBuilder extends ColumnBuilder {
  default(value) {
    return new _ProductColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { defaultValue: value })
    );
  }
  name(name) {
    return new _ProductColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { name })
    );
  }
};
var SumColumnBuilder = class _SumColumnBuilder extends ColumnBuilder {
  default(value) {
    return new _SumColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { defaultValue: value })
    );
  }
  name(name) {
    return new _SumColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { name })
    );
  }
  index(algorithm = "btree") {
    return new _SumColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { indexType: algorithm })
    );
  }
  primaryKey() {
    return new _SumColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { isPrimaryKey: true })
    );
  }
};
var SimpleSumColumnBuilder = class _SimpleSumColumnBuilder extends SumColumnBuilder {
  index(algorithm = "btree") {
    return new _SimpleSumColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { indexType: algorithm })
    );
  }
  primaryKey() {
    return new _SimpleSumColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { isPrimaryKey: true })
    );
  }
};
var ScheduleAtColumnBuilder = class _ScheduleAtColumnBuilder extends ColumnBuilder {
  default(value) {
    return new _ScheduleAtColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { defaultValue: value })
    );
  }
  name(name) {
    return new _ScheduleAtColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { name })
    );
  }
};
var IdentityColumnBuilder = class _IdentityColumnBuilder extends ColumnBuilder {
  index(algorithm = "btree") {
    return new _IdentityColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { indexType: algorithm })
    );
  }
  unique() {
    return new _IdentityColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { isUnique: true })
    );
  }
  primaryKey() {
    return new _IdentityColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { isPrimaryKey: true })
    );
  }
  default(value) {
    return new _IdentityColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { defaultValue: value })
    );
  }
  name(name) {
    return new _IdentityColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { name })
    );
  }
};
var ConnectionIdColumnBuilder = class _ConnectionIdColumnBuilder extends ColumnBuilder {
  index(algorithm = "btree") {
    return new _ConnectionIdColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { indexType: algorithm })
    );
  }
  unique() {
    return new _ConnectionIdColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { isUnique: true })
    );
  }
  primaryKey() {
    return new _ConnectionIdColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { isPrimaryKey: true })
    );
  }
  default(value) {
    return new _ConnectionIdColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { defaultValue: value })
    );
  }
  name(name) {
    return new _ConnectionIdColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { name })
    );
  }
};
var TimestampColumnBuilder = class _TimestampColumnBuilder extends ColumnBuilder {
  index(algorithm = "btree") {
    return new _TimestampColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { indexType: algorithm })
    );
  }
  unique() {
    return new _TimestampColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { isUnique: true })
    );
  }
  primaryKey() {
    return new _TimestampColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { isPrimaryKey: true })
    );
  }
  default(value) {
    return new _TimestampColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { defaultValue: value })
    );
  }
  name(name) {
    return new _TimestampColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { name })
    );
  }
};
var TimeDurationColumnBuilder = class _TimeDurationColumnBuilder extends ColumnBuilder {
  index(algorithm = "btree") {
    return new _TimeDurationColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { indexType: algorithm })
    );
  }
  unique() {
    return new _TimeDurationColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { isUnique: true })
    );
  }
  primaryKey() {
    return new _TimeDurationColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { isPrimaryKey: true })
    );
  }
  default(value) {
    return new _TimeDurationColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { defaultValue: value })
    );
  }
  name(name) {
    return new _TimeDurationColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { name })
    );
  }
};
var UuidColumnBuilder = class _UuidColumnBuilder extends ColumnBuilder {
  index(algorithm = "btree") {
    return new _UuidColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { indexType: algorithm })
    );
  }
  unique() {
    return new _UuidColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { isUnique: true })
    );
  }
  primaryKey() {
    return new _UuidColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { isPrimaryKey: true })
    );
  }
  default(value) {
    return new _UuidColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { defaultValue: value })
    );
  }
  name(name) {
    return new _UuidColumnBuilder(
      this.typeBuilder,
      set(this.columnMetadata, { name })
    );
  }
};
var RefBuilder = class extends TypeBuilder {
  ref;
  /** The phantom type of the pointee of this ref. */
  __spacetimeType;
  constructor(ref) {
    super(AlgebraicType.Ref(ref));
    this.ref = ref;
  }
};
var enumImpl = (nameOrObj, maybeObj) => {
  let obj = nameOrObj;
  let name = void 0;
  if (typeof nameOrObj === "string") {
    if (!maybeObj) {
      throw new TypeError(
        "When providing a name, you must also provide the variants object or array."
      );
    }
    obj = maybeObj;
    name = nameOrObj;
  }
  if (Array.isArray(obj)) {
    const simpleVariantsObj = {};
    for (const variant of obj) {
      simpleVariantsObj[variant] = new UnitBuilder();
    }
    return new SimpleSumBuilderImpl(simpleVariantsObj, name);
  }
  return new SumBuilder(obj, name);
};
var t = {
  /**
   * Creates a new `Bool` {@link AlgebraicType} to be used in table definitions
   * Represented as `boolean` in TypeScript.
   * @returns A new {@link BoolBuilder} instance
   */
  bool: () => new BoolBuilder(),
  /**
   * Creates a new `String` {@link AlgebraicType} to be used in table definitions
   * Represented as `string` in TypeScript.
   * @returns A new {@link StringBuilder} instance
   */
  string: () => new StringBuilder(),
  /**
   * Creates a new `F64` {@link AlgebraicType} to be used in table definitions
   * Represented as `number` in TypeScript.
   * @returns A new {@link F64Builder} instance
   */
  number: () => new F64Builder(),
  /**
   * Creates a new `I8` {@link AlgebraicType} to be used in table definitions
   * Represented as `number` in TypeScript.
   * @returns A new {@link I8Builder} instance
   */
  i8: () => new I8Builder(),
  /**
   * Creates a new `U8` {@link AlgebraicType} to be used in table definitions
   * Represented as `number` in TypeScript.
   * @returns A new {@link U8Builder} instance
   */
  u8: () => new U8Builder(),
  /**
   * Creates a new `I16` {@link AlgebraicType} to be used in table definitions
   * Represented as `number` in TypeScript.
   * @returns A new {@link I16Builder} instance
   */
  i16: () => new I16Builder(),
  /**
   * Creates a new `U16` {@link AlgebraicType} to be used in table definitions
   * Represented as `number` in TypeScript.
   * @returns A new {@link U16Builder} instance
   */
  u16: () => new U16Builder(),
  /**
   * Creates a new `I32` {@link AlgebraicType} to be used in table definitions
   * Represented as `number` in TypeScript.
   * @returns A new {@link I32Builder} instance
   */
  i32: () => new I32Builder(),
  /**
   * Creates a new `U32` {@link AlgebraicType} to be used in table definitions
   * Represented as `number` in TypeScript.
   * @returns A new {@link U32Builder} instance
   */
  u32: () => new U32Builder(),
  /**
   * Creates a new `I64` {@link AlgebraicType} to be used in table definitions
   * Represented as `bigint` in TypeScript.
   * @returns A new {@link I64Builder} instance
   */
  i64: () => new I64Builder(),
  /**
   * Creates a new `U64` {@link AlgebraicType} to be used in table definitions
   * Represented as `bigint` in TypeScript.
   * @returns A new {@link U64Builder} instance
   */
  u64: () => new U64Builder(),
  /**
   * Creates a new `I128` {@link AlgebraicType} to be used in table definitions
   * Represented as `bigint` in TypeScript.
   * @returns A new {@link I128Builder} instance
   */
  i128: () => new I128Builder(),
  /**
   * Creates a new `U128` {@link AlgebraicType} to be used in table definitions
   * Represented as `bigint` in TypeScript.
   * @returns A new {@link U128Builder} instance
   */
  u128: () => new U128Builder(),
  /**
   * Creates a new `I256` {@link AlgebraicType} to be used in table definitions
   * Represented as `bigint` in TypeScript.
   * @returns A new {@link I256Builder} instance
   */
  i256: () => new I256Builder(),
  /**
   * Creates a new `U256` {@link AlgebraicType} to be used in table definitions
   * Represented as `bigint` in TypeScript.
   * @returns A new {@link U256Builder} instance
   */
  u256: () => new U256Builder(),
  /**
   * Creates a new `F32` {@link AlgebraicType} to be used in table definitions
   * Represented as `number` in TypeScript.
   * @returns A new {@link F32Builder} instance
   */
  f32: () => new F32Builder(),
  /**
   * Creates a new `F64` {@link AlgebraicType} to be used in table definitions
   * Represented as `number` in TypeScript.
   * @returns A new {@link F64Builder} instance
   */
  f64: () => new F64Builder(),
  /**
   * Creates a new `Product` {@link AlgebraicType} to be used in table definitions. Product types in SpacetimeDB
   * are essentially the same as objects in JavaScript/TypeScript.
   * Properties of the object must also be {@link TypeBuilder}s.
   * Represented as an object with specific properties in TypeScript.
   *
   * @param name (optional) A display name for the product type. If omitted, an anonymous product type is created.
   * @param obj The object defining the properties of the type, whose property
   * values must be {@link TypeBuilder}s.
   * @returns A new {@link ProductBuilder} instance.
   */
  object: (nameOrObj, maybeObj) => {
    if (typeof nameOrObj === "string") {
      if (!maybeObj) {
        throw new TypeError(
          "When providing a name, you must also provide the object."
        );
      }
      return new ProductBuilder(maybeObj, nameOrObj);
    }
    return new ProductBuilder(nameOrObj, void 0);
  },
  /**
   * Creates a new `Row` {@link AlgebraicType} to be used in table definitions. Row types in SpacetimeDB
   * are similar to `Product` types, but are specifically used to define the schema of a table row.
   * Properties of the object must also be {@link TypeBuilder} or {@link ColumnBuilder}s.
   *
   * You can represent a `Row` as either a {@link RowObj} or an {@link RowBuilder} type when
   * defining a table schema.
   *
   * The {@link RowBuilder} type is useful when you want to create a type which can be used anywhere
   * a {@link TypeBuilder} is accepted, such as in nested objects or arrays, or as the argument
   * to a scheduled function.
   *
   * @param obj The object defining the properties of the row, whose property
   * values must be {@link TypeBuilder}s or {@link ColumnBuilder}s.
   * @returns A new {@link RowBuilder} instance
   */
  row: (nameOrObj, maybeObj) => {
    const [obj, name] = typeof nameOrObj === "string" ? [maybeObj, nameOrObj] : [nameOrObj, void 0];
    return new RowBuilder(obj, name);
  },
  /**
   * Creates a new `Array` {@link AlgebraicType} to be used in table definitions.
   * Represented as an array in TypeScript.
   * @param element The element type of the array, which must be a `TypeBuilder`.
   * @returns A new {@link ArrayBuilder} instance
   */
  array(e) {
    return new ArrayBuilder(e);
  },
  enum: enumImpl,
  /**
   * This is a special helper function for conveniently creating `Product` type columns with no fields.
   *
   * @returns A new {@link ProductBuilder} instance with no fields.
   */
  unit() {
    return new UnitBuilder();
  },
  /**
   * Creates a lazily-evaluated {@link TypeBuilder}. This is useful for creating
   * recursive types, such as a tree or linked list.
   * @param thunk A function that returns a {@link TypeBuilder}.
   * @returns A proxy {@link TypeBuilder} that evaluates the thunk on first access.
   */
  lazy(thunk) {
    let cached = null;
    const get = () => cached ??= thunk();
    const proxy = new Proxy({}, {
      get(_t, prop, recv) {
        const target = get();
        const val = Reflect.get(target, prop, recv);
        return typeof val === "function" ? val.bind(target) : val;
      },
      set(_t, prop, value, recv) {
        return Reflect.set(get(), prop, value, recv);
      },
      has(_t, prop) {
        return prop in get();
      },
      ownKeys() {
        return Reflect.ownKeys(get());
      },
      getOwnPropertyDescriptor(_t, prop) {
        return Object.getOwnPropertyDescriptor(get(), prop);
      },
      getPrototypeOf() {
        return Object.getPrototypeOf(get());
      }
    });
    return proxy;
  },
  /**
   * This is a special helper function for conveniently creating {@link ScheduleAt} type columns.
   * @returns A new ColumnBuilder instance with the {@link ScheduleAt} type.
   */
  scheduleAt: () => {
    return new ScheduleAtBuilder();
  },
  /**
   * This is a convenience method for creating a column with the {@link Option} type.
   * You can create a column of the same type by constructing an enum with a `some` and `none` variant.
   * @param value The type of the value contained in the `some` variant of the `Option`.
   * @returns A new {@link OptionBuilder} instance with the {@link Option} type.
   */
  option(value) {
    return new OptionBuilder(value);
  },
  /**
   * This is a convenience method for creating a column with the {@link Result} type.
   * You can create a column of the same type by constructing an enum with an `ok` and `err` variant.
   * @param ok The type of the value contained in the `ok` variant of the `Result`.
   * @param err The type of the value contained in the `err` variant of the `Result`.
   * @returns A new {@link ResultBuilder} instance with the {@link Result} type.
   */
  result(ok, err) {
    return new ResultBuilder(ok, err);
  },
  /**
   * This is a convenience method for creating a column with the {@link Identity} type.
   * You can create a column of the same type by constructing an `object` with a single `__identity__` element.
   * @returns A new {@link TypeBuilder} instance with the {@link Identity} type.
   */
  identity: () => {
    return new IdentityBuilder();
  },
  /**
   * This is a convenience method for creating a column with the {@link ConnectionId} type.
   * You can create a column of the same type by constructing an `object` with a single `__connection_id__` element.
   * @returns A new {@link TypeBuilder} instance with the {@link ConnectionId} type.
   */
  connectionId: () => {
    return new ConnectionIdBuilder();
  },
  /**
   * This is a convenience method for creating a column with the {@link Timestamp} type.
   * You can create a column of the same type by constructing an `object` with a single `__timestamp_micros_since_unix_epoch__` element.
   * @returns A new {@link TypeBuilder} instance with the {@link Timestamp} type.
   */
  timestamp: () => {
    return new TimestampBuilder();
  },
  /**
   * This is a convenience method for creating a column with the {@link TimeDuration} type.
   * You can create a column of the same type by constructing an `object` with a single `__time_duration_micros__` element.
   * @returns A new {@link TypeBuilder} instance with the {@link TimeDuration} type.
   */
  timeDuration: () => {
    return new TimeDurationBuilder();
  },
  /**
   * This is a convenience method for creating a column with the {@link Uuid} type.
   * You can create a column of the same type by constructing an `object` with a single `__uuid__` element.
   * @returns A new {@link TypeBuilder} instance with the {@link Uuid} type.
   */
  uuid: () => {
    return new UuidBuilder();
  },
  /**
   * This is a convenience method for creating a column with the `ByteArray` type.
   * You can create a column of the same type by constructing an `array` of `u8`.
   * The TypeScript representation is {@link Uint8Array}.
   * @returns A new {@link ByteArrayBuilder} instance with the `ByteArray` type.
   */
  byteArray: () => {
    return new ByteArrayBuilder();
  }
};
var BsatnRowList = t.object("BsatnRowList", {
  get sizeHint() {
    return RowSizeHint;
  },
  rowsData: t.byteArray()
});
var CallProcedure = t.object("CallProcedure", {
  requestId: t.u32(),
  flags: t.u8(),
  procedure: t.string(),
  args: t.byteArray()
});
var CallReducer = t.object("CallReducer", {
  requestId: t.u32(),
  flags: t.u8(),
  reducer: t.string(),
  args: t.byteArray()
});
var ClientMessage = t.enum("ClientMessage", {
  get Subscribe() {
    return Subscribe;
  },
  get Unsubscribe() {
    return Unsubscribe;
  },
  get OneOffQuery() {
    return OneOffQuery;
  },
  get CallReducer() {
    return CallReducer;
  },
  get CallProcedure() {
    return CallProcedure;
  }
});
var EventTableRows = t.object("EventTableRows", {
  get events() {
    return BsatnRowList;
  }
});
var InitialConnection = t.object("InitialConnection", {
  identity: t.identity(),
  connectionId: t.connectionId(),
  token: t.string()
});
var OneOffQuery = t.object("OneOffQuery", {
  requestId: t.u32(),
  queryString: t.string()
});
var OneOffQueryResult = t.object("OneOffQueryResult", {
  requestId: t.u32(),
  get result() {
    return t.result(QueryRows, t.string());
  }
});
var PersistentTableRows = t.object("PersistentTableRows", {
  get inserts() {
    return BsatnRowList;
  },
  get deletes() {
    return BsatnRowList;
  }
});
var ProcedureResult = t.object("ProcedureResult", {
  get status() {
    return ProcedureStatus;
  },
  timestamp: t.timestamp(),
  totalHostExecutionDuration: t.timeDuration(),
  requestId: t.u32()
});
var ProcedureStatus = t.enum("ProcedureStatus", {
  Returned: t.byteArray(),
  InternalError: t.string()
});
var QueryRows = t.object("QueryRows", {
  get tables() {
    return t.array(SingleTableRows);
  }
});
var QuerySetId = t.object("QuerySetId", {
  id: t.u32()
});
var QuerySetUpdate = t.object("QuerySetUpdate", {
  get querySetId() {
    return QuerySetId;
  },
  get tables() {
    return t.array(TableUpdate);
  }
});
var ReducerOk = t.object("ReducerOk", {
  retValue: t.byteArray(),
  get transactionUpdate() {
    return TransactionUpdate;
  }
});
var ReducerOutcome = t.enum("ReducerOutcome", {
  get Ok() {
    return ReducerOk;
  },
  OkEmpty: t.unit(),
  Err: t.byteArray(),
  InternalError: t.string()
});
var ReducerResult = t.object("ReducerResult", {
  requestId: t.u32(),
  timestamp: t.timestamp(),
  get result() {
    return ReducerOutcome;
  }
});
var RowSizeHint = t.enum("RowSizeHint", {
  FixedSize: t.u16(),
  RowOffsets: t.array(t.u64())
});
var ServerMessage = t.enum("ServerMessage", {
  get InitialConnection() {
    return InitialConnection;
  },
  get SubscribeApplied() {
    return SubscribeApplied;
  },
  get UnsubscribeApplied() {
    return UnsubscribeApplied;
  },
  get SubscriptionError() {
    return SubscriptionError;
  },
  get TransactionUpdate() {
    return TransactionUpdate;
  },
  get OneOffQueryResult() {
    return OneOffQueryResult;
  },
  get ReducerResult() {
    return ReducerResult;
  },
  get ProcedureResult() {
    return ProcedureResult;
  }
});
var SingleTableRows = t.object("SingleTableRows", {
  table: t.string(),
  get rows() {
    return BsatnRowList;
  }
});
var Subscribe = t.object("Subscribe", {
  requestId: t.u32(),
  get querySetId() {
    return QuerySetId;
  },
  queryStrings: t.array(t.string())
});
var SubscribeApplied = t.object("SubscribeApplied", {
  requestId: t.u32(),
  get querySetId() {
    return QuerySetId;
  },
  get rows() {
    return QueryRows;
  }
});
var SubscriptionError = t.object("SubscriptionError", {
  requestId: t.option(t.u32()),
  get querySetId() {
    return QuerySetId;
  },
  error: t.string()
});
var TableUpdate = t.object("TableUpdate", {
  tableName: t.string(),
  get rows() {
    return t.array(TableUpdateRows);
  }
});
var TableUpdateRows = t.enum("TableUpdateRows", {
  get PersistentTable() {
    return PersistentTableRows;
  },
  get EventTable() {
    return EventTableRows;
  }
});
var TransactionUpdate = t.object("TransactionUpdate", {
  get querySets() {
    return t.array(QuerySetUpdate);
  }
});
var Unsubscribe = t.object("Unsubscribe", {
  requestId: t.u32(),
  get querySetId() {
    return QuerySetId;
  },
  get flags() {
    return UnsubscribeFlags;
  }
});
var UnsubscribeApplied = t.object("UnsubscribeApplied", {
  requestId: t.u32(),
  get querySetId() {
    return QuerySetId;
  },
  get rows() {
    return t.option(QueryRows);
  }
});
var UnsubscribeFlags = t.enum("UnsubscribeFlags", {
  Default: t.unit(),
  SendDroppedRows: t.unit()
});
var EventEmitter = class {
  #events = /* @__PURE__ */ new Map();
  on(event, callback) {
    let callbacks = this.#events.get(event);
    if (!callbacks) {
      callbacks = /* @__PURE__ */ new Set();
      this.#events.set(event, callbacks);
    }
    callbacks.add(callback);
  }
  off(event, callback) {
    const callbacks = this.#events.get(event);
    if (!callbacks) {
      return;
    }
    callbacks.delete(callback);
  }
  emit(event, ...args) {
    const callbacks = this.#events.get(event);
    if (!callbacks) {
      return;
    }
    for (const callback of callbacks) {
      callback(...args);
    }
  }
};
var LogLevelIdentifierIcon = {
  component: "\u{1F4E6}",
  info: "\u2139\uFE0F",
  warn: "\u26A0\uFE0F",
  error: "\u274C",
  debug: "\u{1F41B}",
  trace: "\u{1F50D}"
};
var LogStyle = {
  component: "color: #fff; background-color: #8D6FDD; padding: 2px 5px; border-radius: 3px;",
  info: "color: #fff; background-color: #007bff; padding: 2px 5px; border-radius: 3px;",
  warn: "color: #fff; background-color: #ffc107; padding: 2px 5px; border-radius: 3px;",
  error: "color: #fff; background-color: #dc3545; padding: 2px 5px; border-radius: 3px;",
  debug: "color: #fff; background-color: #28a745; padding: 2px 5px; border-radius: 3px;",
  trace: "color: #fff; background-color: #17a2b8; padding: 2px 5px; border-radius: 3px;"
};
var LogTextStyle = {
  component: "color: #8D6FDD;",
  info: "color: #007bff;",
  warn: "color: #ffc107;",
  error: "color: #dc3545;",
  debug: "color: #28a745;",
  trace: "color: #17a2b8;"
};
var LogLevelRank = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4
};
var globalLogLevel = "info";
var shouldLog = (level) => LogLevelRank[level] <= LogLevelRank[globalLogLevel];
var resolveLazy = (v) => typeof v === "function" ? v() : v;
var toHex = (bytes) => Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
var ARRAY_TRUNCATION_THRESHOLD = 25;
var ARRAY_PREVIEW_COUNT = 10;
var SENSITIVE_KEYS = /* @__PURE__ */ new Set([
  "token",
  "authToken",
  "authorization",
  "accessToken",
  "refreshToken"
]);
var stringify2 = (value) => stringify(value, (key, current) => {
  if (SENSITIVE_KEYS.has(key)) {
    return "[REDACTED]";
  }
  if (current && typeof current === "object" && "__identity__" in current && typeof current.__identity__ === "bigint") {
    return u256ToHexString(
      current.__identity__
    );
  }
  if (current && typeof current === "object" && "__connection_id__" in current && typeof current.__connection_id__ === "bigint") {
    return u128ToHexString(
      current.__connection_id__
    );
  }
  if (current instanceof Uint8Array) {
    if (current.length < 25) {
      return `0x${toHex(current)}`;
    }
    const head = current.subarray(0, 10);
    return `Uint8Array(len=${current.length}, head=0x${toHex(head)})`;
  }
  if (Array.isArray(current) && current.length >= ARRAY_TRUNCATION_THRESHOLD) {
    const head = stringify(current.slice(0, ARRAY_PREVIEW_COUNT));
    return `Array(len=${current.length}, head=${head ?? "[]"})`;
  }
  return current;
});
var stdbLogger = (level, message, ...args) => {
  if (!shouldLog(level)) {
    return;
  }
  const resolvedMessage = resolveLazy(message);
  const resolvedArgs = args.map(resolveLazy);
  console.log(
    `%c${LogLevelIdentifierIcon[level]} ${level.toUpperCase()}%c ${resolvedMessage}`,
    LogStyle[level],
    LogTextStyle[level],
    ...resolvedArgs
  );
};
var scalarCompare = (x, y) => {
  if (x === y) return 0;
  return x < y ? -1 : 1;
};
var TableCacheImpl = class {
  hasPrimaryKey;
  rows;
  tableDef;
  emitter;
  /**
   * @param name the table name
   * @param primaryKeyCol column index designated as `#[primarykey]`
   * @param primaryKey column name designated as `#[primarykey]`
   * @param entityClass the entityClass
   */
  constructor(tableDef) {
    this.tableDef = tableDef;
    this.rows = /* @__PURE__ */ new Map();
    this.emitter = new EventEmitter();
    this.hasPrimaryKey = Object.values(this.tableDef.columns).some(
      (col) => col.columnMetadata.isPrimaryKey === true
    );
    for (const idxDef of this.tableDef.resolvedIndexes) {
      const index = this.#makeReadonlyIndex(this.tableDef, idxDef);
      this[idxDef.name] = index;
    }
  }
  // TODO: this just scans the whole table; we should build proper index structures
  #makeReadonlyIndex(tableDef, idx) {
    if (idx.algorithm !== "btree") {
      throw new Error("Only btree indexes are supported in TableCacheImpl");
    }
    const columns = idx.columns;
    const getKey = (row) => columns.map((c) => row[c]);
    const matchRange = (row, rangeArg) => {
      const key = getKey(row);
      const arr = Array.isArray(rangeArg) ? rangeArg : [rangeArg];
      const prefixLen = Math.max(0, arr.length - 1);
      for (let i = 0; i < prefixLen; i++) {
        if (!deepEqual(key[i], arr[i])) return false;
      }
      const lastProvided = arr[arr.length - 1];
      const kLast = key[prefixLen];
      if (lastProvided && typeof lastProvided === "object" && "from" in lastProvided && "to" in lastProvided) {
        const from = lastProvided.from;
        const to = lastProvided.to;
        if (from.tag !== "unbounded") {
          const c = scalarCompare(kLast, from.value);
          if (c < 0) return false;
          if (c === 0 && from.tag === "excluded") return false;
        }
        if (to.tag !== "unbounded") {
          const c = scalarCompare(kLast, to.value);
          if (c > 0) return false;
          if (c === 0 && to.tag === "excluded") return false;
        }
        return true;
      } else {
        if (!deepEqual(kLast, lastProvided)) return false;
        return true;
      }
    };
    const isUnique = tableDef.constraints.some((constraint) => {
      if (constraint.constraint !== "unique") {
        return false;
      }
      return deepEqual(constraint.columns, idx.columns);
    });
    const self = this;
    if (isUnique) {
      const impl = {
        find: (colVal) => {
          const expected = Array.isArray(colVal) ? colVal : [colVal];
          for (const row of self.iter()) {
            if (deepEqual(getKey(row), expected)) return row;
          }
          return null;
        }
      };
      return impl;
    } else {
      const impl = {
        *filter(range) {
          for (const row of self.iter()) {
            if (matchRange(row, range)) yield row;
          }
        }
      };
      return impl;
    }
  }
  /**
   * @returns number of rows in the table
   */
  count() {
    return BigInt(this.rows.size);
  }
  /**
   * @returns The values of the rows in the table
   */
  iter() {
    function* generator(rows) {
      for (const [row] of rows.values()) {
        yield row;
      }
    }
    return generator(this.rows);
  }
  /**
   * Allows iteration over the rows in the table
   * @returns An iterator over the rows in the table
   */
  [Symbol.iterator]() {
    return this.iter();
  }
  applyOperations = (operations, ctx) => {
    const pendingCallbacks = [];
    if (this.tableDef.isEvent) {
      for (const op of operations) {
        if (op.type === "insert") {
          pendingCallbacks.push({
            type: "insert",
            table: this.tableDef.sourceName,
            cb: () => {
              this.emitter.emit("insert", ctx, op.row);
            }
          });
        }
      }
      return pendingCallbacks;
    }
    if (this.hasPrimaryKey) {
      const insertMap = /* @__PURE__ */ new Map();
      const deleteMap = /* @__PURE__ */ new Map();
      for (const op of operations) {
        if (op.type === "insert") {
          const [_, prevCount] = insertMap.get(op.rowId) || [op, 0];
          insertMap.set(op.rowId, [op, prevCount + 1]);
        } else {
          const [_, prevCount] = deleteMap.get(op.rowId) || [op, 0];
          deleteMap.set(op.rowId, [op, prevCount + 1]);
        }
      }
      for (const [primaryKey, [insertOp, refCount]] of insertMap) {
        const deleteEntry = deleteMap.get(primaryKey);
        if (deleteEntry) {
          const [_, deleteCount] = deleteEntry;
          const refCountDelta = refCount - deleteCount;
          const maybeCb = this.update(
            ctx,
            primaryKey,
            insertOp.row,
            refCountDelta
          );
          if (maybeCb) {
            pendingCallbacks.push(maybeCb);
          }
          deleteMap.delete(primaryKey);
        } else {
          const maybeCb = this.insert(ctx, insertOp, refCount);
          if (maybeCb) {
            pendingCallbacks.push(maybeCb);
          }
        }
      }
      for (const [deleteOp, refCount] of deleteMap.values()) {
        const maybeCb = this.delete(ctx, deleteOp, refCount);
        if (maybeCb) {
          pendingCallbacks.push(maybeCb);
        }
      }
    } else {
      for (const op of operations) {
        if (op.type === "insert") {
          const maybeCb = this.insert(ctx, op);
          if (maybeCb) {
            pendingCallbacks.push(maybeCb);
          }
        } else {
          const maybeCb = this.delete(ctx, op);
          if (maybeCb) {
            pendingCallbacks.push(maybeCb);
          }
        }
      }
    }
    return pendingCallbacks;
  };
  update = (ctx, rowId, newRow, refCountDelta = 0) => {
    const existingEntry = this.rows.get(rowId);
    if (!existingEntry) {
      stdbLogger(
        "error",
        `Updating a row that was not present in the cache. Table: ${this.tableDef.sourceName}, RowId: ${rowId}`
      );
      return void 0;
    }
    const [oldRow, previousCount] = existingEntry;
    const refCount = Math.max(1, previousCount + refCountDelta);
    if (previousCount + refCountDelta <= 0) {
      stdbLogger(
        "error",
        `Negative reference count for in table ${this.tableDef.sourceName} row ${rowId} (${previousCount} + ${refCountDelta})`
      );
      return void 0;
    }
    this.rows.set(rowId, [newRow, refCount]);
    if (previousCount === 0) {
      stdbLogger(
        "error",
        `Updating a row id in table ${this.tableDef.sourceName} which was not present in the cache (rowId: ${rowId})`
      );
      return {
        type: "insert",
        table: this.tableDef.sourceName,
        cb: () => {
          this.emitter.emit("insert", ctx, newRow);
        }
      };
    }
    return {
      type: "update",
      table: this.tableDef.sourceName,
      cb: () => {
        this.emitter.emit("update", ctx, oldRow, newRow);
      }
    };
  };
  insert = (ctx, operation, count = 1) => {
    const [_, previousCount] = this.rows.get(operation.rowId) || [
      operation.row,
      0
    ];
    this.rows.set(operation.rowId, [operation.row, previousCount + count]);
    if (previousCount === 0) {
      return {
        type: "insert",
        table: this.tableDef.sourceName,
        cb: () => {
          this.emitter.emit("insert", ctx, operation.row);
        }
      };
    }
    return void 0;
  };
  delete = (ctx, operation, count = 1) => {
    const [_, previousCount] = this.rows.get(operation.rowId) || [
      operation.row,
      0
    ];
    if (previousCount === 0) {
      stdbLogger("warn", "Deleting a row that was not present in the cache");
      return void 0;
    }
    if (previousCount <= count) {
      this.rows.delete(operation.rowId);
      return {
        type: "delete",
        table: this.tableDef.sourceName,
        cb: () => {
          this.emitter.emit("delete", ctx, operation.row);
        }
      };
    }
    this.rows.set(operation.rowId, [operation.row, previousCount - count]);
    return void 0;
  };
  /**
   * Register a callback for when a row is newly inserted into the database.
   *
   * ```ts
   * ctx.db.user.onInsert((reducerEvent, user) => {
   *   if (reducerEvent) {
   *      console.log("New user on reducer", reducerEvent, user);
   *   } else {
   *      console.log("New user received during subscription update on insert", user);
   *  }
   * });
   * ```
   *
   * @param cb Callback to be called when a new row is inserted
   */
  onInsert = (cb) => {
    this.emitter.on("insert", cb);
  };
  /**
   * Register a callback for when a row is deleted from the database.
   *
   * ```ts
   * ctx.db.user.onDelete((reducerEvent, user) => {
   *   if (reducerEvent) {
   *      console.log("Deleted user on reducer", reducerEvent, user);
   *   } else {
   *      console.log("Deleted user received during subscription update on update", user);
   *  }
   * });
   * ```
   *
   * @param cb Callback to be called when a new row is inserted
   */
  onDelete = (cb) => {
    this.emitter.on("delete", cb);
  };
  /**
   * Register a callback for when a row is updated into the database.
   *
   * ```ts
   * ctx.db.user.onInsert((reducerEvent, oldUser, user) => {
   *   if (reducerEvent) {
   *      console.log("Updated user on reducer", reducerEvent, user);
   *   } else {
   *      console.log("Updated user received during subscription update on delete", user);
   *  }
   * });
   * ```
   *
   * @param cb Callback to be called when a new row is inserted
   */
  onUpdate = (cb) => {
    this.emitter.on("update", cb);
  };
  /**
   * Remove a callback for when a row is newly inserted into the database.
   *
   * @param cb Callback to be removed
   */
  removeOnInsert = (cb) => {
    this.emitter.off("insert", cb);
  };
  /**
   * Remove a callback for when a row is deleted from the database.
   *
   * @param cb Callback to be removed
   */
  removeOnDelete = (cb) => {
    this.emitter.off("delete", cb);
  };
  /**
   * Remove a callback for when a row is updated into the database.
   *
   * @param cb Callback to be removed
   */
  removeOnUpdate = (cb) => {
    this.emitter.off("update", cb);
  };
};
var TableMap = class {
  map = /* @__PURE__ */ new Map();
  get(key) {
    return this.map.get(key);
  }
  set(key, value) {
    this.map.set(key, value);
    return this;
  }
  has(key) {
    return this.map.has(key);
  }
  delete(key) {
    return this.map.delete(key);
  }
  // optional: iteration stays broadly typed (cannot express per-key relation here)
  keys() {
    return this.map.keys();
  }
  values() {
    return this.map.values();
  }
  entries() {
    return this.map.entries();
  }
  [Symbol.iterator]() {
    return this.entries();
  }
};
var ClientCache = class {
  /**
   * The tables in the database.
   */
  tables = new TableMap();
  /**
   * Returns the table with the given name.
   * - If SchemaDef is a concrete schema, `name` is constrained to known table names,
   *   and the return type matches that table.
   * - If SchemaDef is undefined, `name` is string and the return type is untyped.
   */
  getTable(name) {
    const table2 = this.tables.get(name);
    if (!table2) {
      console.error(
        "The table has not been registered for this client. Please register the table before using it. If you have registered global tables using the SpacetimeDBClient.registerTables() or `registerTable()` method, please make sure that is executed first!"
      );
      throw new Error(`Table ${String(name)} does not exist`);
    }
    return table2;
  }
  /**
   * Returns the table with the given name, creating it if needed.
   * - Typed mode: `tableTypeInfo.tableName` is constrained to known names and
   *   the return type matches that table.
   * - Untyped mode: accepts any string and returns an untyped TableCache.
   */
  getOrCreateTable(tableDef) {
    const name = tableDef.accessorName;
    const table2 = this.tables.get(name);
    if (table2) {
      return table2;
    }
    const newTable = new TableCacheImpl(
      tableDef
    );
    this.tables.set(name, newTable);
    return newTable;
  }
};
function comparePreReleases(a, b) {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const aPart = a[i];
    const bPart = b[i];
    if (aPart === bPart) continue;
    if (typeof aPart === "number" && typeof bPart === "number") {
      return aPart - bPart;
    }
    if (typeof aPart === "string" && typeof bPart === "string") {
      return aPart.localeCompare(bPart);
    }
    return typeof aPart === "string" ? 1 : -1;
  }
  return a.length - b.length;
}
var SemanticVersion = class _SemanticVersion {
  major;
  minor;
  patch;
  preRelease;
  buildInfo;
  constructor(major, minor, patch, preRelease = null, buildInfo = null) {
    this.major = major;
    this.minor = minor;
    this.patch = patch;
    this.preRelease = preRelease;
    this.buildInfo = buildInfo;
  }
  toString() {
    let versionString = `${this.major}.${this.minor}.${this.patch}`;
    if (this.preRelease) {
      versionString += `-${this.preRelease.join(".")}`;
    }
    if (this.buildInfo) {
      versionString += `+${this.buildInfo}`;
    }
    return versionString;
  }
  compare(other) {
    if (this.major !== other.major) {
      return this.major - other.major;
    }
    if (this.minor !== other.minor) {
      return this.minor - other.minor;
    }
    if (this.patch !== other.patch) {
      return this.patch - other.patch;
    }
    if (this.preRelease && other.preRelease) {
      return comparePreReleases(this.preRelease, other.preRelease);
    }
    if (this.preRelease) {
      return -1;
    }
    if (other.preRelease) {
      return -1;
    }
    return 0;
  }
  clone() {
    return new _SemanticVersion(
      this.major,
      this.minor,
      this.patch,
      this.preRelease ? [...this.preRelease] : null,
      this.buildInfo
    );
  }
  static parseVersionString(version) {
    const regex = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?(?:\+([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?$/;
    const match = version.match(regex);
    if (!match) {
      throw new Error(`Invalid version string: ${version}`);
    }
    const major = parseInt(match[1], 10);
    const minor = parseInt(match[2], 10);
    const patch = parseInt(match[3], 10);
    const preRelease = match[4] ? match[4].split(".").map((id) => isNaN(Number(id)) ? id : Number(id)) : null;
    const buildInfo = match[5] || null;
    return new _SemanticVersion(major, minor, patch, preRelease, buildInfo);
  }
};
var _MINIMUM_CLI_VERSION = new SemanticVersion(
  1,
  4,
  0
);
function ensureMinimumVersionOrThrow(versionString) {
  if (versionString === void 0) {
    throw new Error(versionErrorMessage(versionString));
  }
  const version = SemanticVersion.parseVersionString(versionString);
  if (version.compare(_MINIMUM_CLI_VERSION) < 0) {
    throw new Error(versionErrorMessage(versionString));
  }
}
function versionErrorMessage(incompatibleVersion) {
  return `Module code was generated with an incompatible version of the spacetimedb cli (${incompatibleVersion}). Update the cli version to at least ${_MINIMUM_CLI_VERSION.toString()} and regenerate the bindings. You can upgrade to the latest cli version by running: spacetime version upgrade`;
}
async function decompress(buffer, type, chunkSize = 128 * 1024) {
  let offset = 0;
  const readableStream = new ReadableStream({
    pull(controller) {
      if (offset < buffer.length) {
        const chunk = buffer.subarray(
          offset,
          Math.min(offset + chunkSize, buffer.length)
        );
        controller.enqueue(chunk);
        offset += chunkSize;
      } else {
        controller.close();
      }
    }
  });
  const decompressionStream = new DecompressionStream(type);
  const decompressedStream = readableStream.pipeThrough(decompressionStream);
  const reader = decompressedStream.getReader();
  const chunks = [];
  let totalLength = 0;
  let result;
  while (!(result = await reader.read()).done) {
    chunks.push(result.value);
    totalLength += result.value.length;
  }
  const decompressedArray = new Uint8Array(totalLength);
  let chunkOffset = 0;
  for (const chunk of chunks) {
    decompressedArray.set(chunk, chunkOffset);
    chunkOffset += chunk.length;
  }
  return decompressedArray;
}
async function resolveWS() {
  if (typeof WebSocket !== "undefined") {
    return WebSocket;
  }
  const dynamicImport = new Function("m", "return import(m)");
  try {
    const { WebSocket: UndiciWS } = await dynamicImport("undici");
    return UndiciWS;
  } catch (err) {
    stdbLogger(
      "warn",
      "[spacetimedb-sdk] No global WebSocket found. On Node 18\u201321, please install `undici` (npm install undici) to enable WebSocket support."
    );
    throw err;
  }
}
async function openWebSocket({
  url,
  nameOrAddress,
  wsProtocol,
  authToken,
  compression,
  lightMode,
  confirmedReads
}) {
  const headers = new Headers();
  const WS = await resolveWS();
  let temporaryAuthToken;
  if (authToken) {
    headers.set("Authorization", `Bearer ${authToken}`);
    const tokenUrl = new URL("v1/identity/websocket-token", url);
    tokenUrl.protocol = url.protocol === "wss:" ? "https:" : "http:";
    const response = await fetch(tokenUrl, { method: "POST", headers });
    if (response.ok) {
      const { token } = await response.json();
      temporaryAuthToken = token;
    } else {
      throw new Error(`Failed to verify token: ${response.statusText}`);
    }
  }
  const databaseUrl = new URL(`v1/database/${nameOrAddress}/subscribe`, url);
  if (temporaryAuthToken) {
    databaseUrl.searchParams.set("token", temporaryAuthToken);
  }
  databaseUrl.searchParams.set(
    "compression",
    { gzip: "Gzip", brotli: "Brotli", none: "None" }[compression] ?? "None"
  );
  if (lightMode) {
    databaseUrl.searchParams.set("light", "true");
  }
  if (confirmedReads !== void 0) {
    databaseUrl.searchParams.set("confirmed", confirmedReads.toString());
  }
  const ws = new WS(databaseUrl.toString(), wsProtocol);
  ws.binaryType = "arraybuffer";
  return ws;
}
var WebsocketDecompressAdapter = class _WebsocketDecompressAdapter {
  get protocol() {
    return this.#ws.protocol;
  }
  get readyState() {
    return this.#ws.readyState;
  }
  set onclose(handler) {
    this.#ws.onclose = handler;
  }
  set onopen(handler) {
    this.#ws.onopen = handler;
  }
  set onmessage(handler) {
    this.#ws.onmessage = async (msg) => {
      let data;
      try {
        data = await this.#decompress(new Uint8Array(msg.data));
      } catch (e) {
        console.error(
          "[SpacetimeDB] WebSocket decompress failed, closing socket:",
          e
        );
        this.#ws.close();
        return;
      }
      handler({ data });
    };
  }
  set onerror(handler) {
    this.#ws.onerror = handler;
  }
  #ws;
  async #decompress(buffer) {
    const tag = buffer[0];
    const data = buffer.subarray(1);
    switch (tag) {
      case 0:
        return data;
      case 1:
        return await decompress(data, "brotli");
      case 2:
        return await decompress(data, "gzip");
      default:
        throw new Error(
          "Unexpected Compression Algorithm. Please use `gzip` or `none`"
        );
    }
  }
  send(msg) {
    this.#ws.send(msg);
  }
  close() {
    this.#ws.close();
  }
  constructor(ws) {
    this.#ws = ws;
  }
  static async openWebSocket(args) {
    return new _WebsocketDecompressAdapter(await openWebSocket(args));
  }
};
var DbConnectionBuilder = class {
  /**
   * Creates a new `DbConnectionBuilder` database client and set the initial parameters.
   *
   * Users are not expected to call this constructor directly. Instead, use the static method `DbConnection.builder()`.
   *
   * @param remoteModule The remote module to use to connect to the SpacetimeDB server.
   * @param dbConnectionConstructor The constructor to use to create a new `DbConnection`.
   */
  constructor(remoteModule, dbConnectionCtor) {
    this.remoteModule = remoteModule;
    this.dbConnectionCtor = dbConnectionCtor;
    this.#createWSFn = WebsocketDecompressAdapter.openWebSocket;
  }
  #uri;
  #nameOrAddress;
  #identity;
  #token;
  #emitter = new EventEmitter();
  #compression = "gzip";
  #lightMode = false;
  #confirmedReads;
  #createWSFn;
  /**
   * Set the URI of the SpacetimeDB server to connect to.
   *
   * @param uri The URI of the SpacetimeDB server to connect to.
   *
   **/
  withUri(uri) {
    this.#uri = new URL(uri);
    return this;
  }
  /**
   * Set the name or Identity of the remote database to connect to.
   *
   * @param nameOrAddress
   *
   * @returns The `DbConnectionBuilder` instance.
   */
  withDatabaseName(nameOrAddress) {
    this.#nameOrAddress = nameOrAddress;
    return this;
  }
  /**
   * Set the identity of the client to connect to the database.
   *
   * @param token The credentials to use to authenticate with SpacetimeDB. This
   * is optional. You can store the token returned by the `onConnect` callback
   * to use in future connections.
   *
   * @returns The `DbConnectionBuilder` instance.
   */
  withToken(token) {
    this.#token = token;
    return this;
  }
  withWSFn(createWSFn) {
    this.#createWSFn = createWSFn;
    return this;
  }
  /**
   * Set the compression algorithm to use for the connection.
   *
   * @param compression The compression algorithm to use for the connection.
   */
  withCompression(compression) {
    if (compression === "brotli") {
      try {
        new DecompressionStream("brotli");
      } catch (e) {
        throw new TypeError(
          `Brotli compression is not supported by the runtime. Please choose a different compression method.`,
          { cause: e }
        );
      }
    }
    this.#compression = compression;
    return this;
  }
  /**
   * Sets the connection to operate in light mode.
   *
   * Light mode is a mode that reduces the amount of data sent over the network.
   *
   * @param lightMode The light mode for the connection.
   */
  withLightMode(lightMode) {
    this.#lightMode = lightMode;
    return this;
  }
  /**
   * Sets the connection to use confirmed reads.
   *
   * When enabled, the server will send query results only after they are
   * confirmed to be durable.
   *
   * What durable means depends on the server configuration: a single node
   * server may consider a transaction durable once it is `fsync`'ed to disk,
   * whereas a cluster may require that some number of replicas have
   * acknowledge that they have stored the transactions.
   *
   * Note that enabling confirmed reads will increase the latency between a
   * reducer call and the corresponding subscription update arriving at the
   * client.
   *
   * If this method is not called, not preference is sent to the server, and
   * the server will choose the default.
   *
   * @param confirmedReads `true` to enable confirmed reads, `false` to disable.
   */
  withConfirmedReads(confirmedReads) {
    this.#confirmedReads = confirmedReads;
    return this;
  }
  /**
   * Register a callback to be invoked upon authentication with the database.
   *
   * @param identity A unique identifier for a client connected to a database.
   * @param token The credentials to use to authenticate with SpacetimeDB.
   *
   * @returns The `DbConnectionBuilder` instance.
   *
   * The callback will be invoked with the `Identity` and private authentication `token` provided by the database to identify this connection.
   *
   * If credentials were supplied to connect, those passed to the callback will be equivalent to the ones used to connect.
   *
   * If the initial connection was anonymous, a new set of credentials will be generated by the database to identify this user.
   *
   * The credentials passed to the callback can be saved and used to authenticate the same user in future connections.
   *
   * @example
   *
   * ```ts
   * DbConnection.builder().onConnect((ctx, identity, token) => {
   *  console.log("Connected to SpacetimeDB with identity:", identity.toHexString());
   * });
   * ```
   */
  onConnect(callback) {
    this.#emitter.on("connect", callback);
    return this;
  }
  /**
   * Register a callback to be invoked upon an error.
   *
   * @example
   *
   * ```ts
   * DbConnection.builder().onConnectError((ctx, error) => {
   *   console.log("Error connecting to SpacetimeDB:", error);
   * });
   * ```
   */
  onConnectError(callback) {
    this.#emitter.on("connectError", callback);
    return this;
  }
  /**
   * Registers a callback to run when a {@link DbConnection} whose connection initially succeeded
   * is disconnected, either after a {@link DbConnection.disconnect()} call or due to an error.
   *
   * If the connection ended because of an error, the error is passed to the callback.
   *
   * The `callback` will be installed on the `DbConnection` created by `build`
   * before initiating the connection, ensuring there's no opportunity for the disconnect to happen
   * before the callback is installed.
   *
   * Note that this does not trigger if `build` fails
   * or in cases where {@link DbConnectionBuilder.onConnectError} would trigger.
   * This callback only triggers if the connection closes after `build` returns successfully
   * and {@link DbConnectionBuilder.onConnect} is invoked, i.e., after the initial connection
   * message is received.
   *
   * To simplify SDK implementation, at most one such callback can be registered.
   * Calling `onDisconnect` on the same `DbConnectionBuilder` multiple times throws an error.
   *
   * Unlike callbacks registered via {@link DbConnection},
   * no mechanism is provided to unregister the provided callback.
   * This is a concession to ergonomics; there's no clean place to return a `CallbackId` from this method
   * or from `build`.
   *
   * @param {function(error?: Error): void} callback - The callback to invoke upon disconnection.
   * @throws {Error} Throws an error if called multiple times on the same `DbConnectionBuilder`.
   */
  onDisconnect(callback) {
    this.#emitter.on("disconnect", callback);
    return this;
  }
  getUri() {
    return this.#uri?.toString() ?? "";
  }
  getModuleName() {
    return this.#nameOrAddress ?? "";
  }
  /**
   * Builds a new `DbConnection` with the parameters set on this `DbConnectionBuilder` and attempts to connect to the SpacetimeDB server.
   *
   * @returns A new `DbConnection` with the parameters set on this `DbConnectionBuilder`.
   *
   * @example
   *
   * ```ts
   * const host = "http://localhost:3000";
   * const name_or_address = "database_name"
   * const auth_token = undefined;
   * DbConnection.builder().withUri(host).withDatabaseName(name_or_address).withToken(auth_token).build();
   * ```
   */
  build() {
    if (!this.#uri) {
      throw new Error("URI is required to connect to SpacetimeDB");
    }
    if (!this.#nameOrAddress) {
      throw new Error(
        "Database name or address is required to connect to SpacetimeDB"
      );
    }
    ensureMinimumVersionOrThrow(this.remoteModule.versionInfo?.cliVersion);
    return this.dbConnectionCtor({
      uri: this.#uri,
      nameOrAddress: this.#nameOrAddress,
      identity: this.#identity,
      token: this.#token,
      emitter: this.#emitter,
      compression: this.#compression,
      lightMode: this.#lightMode,
      confirmedReads: this.#confirmedReads,
      createWSFn: this.#createWSFn,
      remoteModule: this.remoteModule
    });
  }
};
var INTERNAL_REMOTE_MODULE = Symbol("INTERNAL_REMOTE_MODULE");
var SubscriptionBuilderImpl = class {
  constructor(db) {
    this.db = db;
  }
  #onApplied = void 0;
  #onError = void 0;
  /**
   * Registers `callback` to run when this query is successfully added to our subscribed set,
   * I.e. when its `SubscriptionApplied` message is received.
   *
   * The database state exposed via the `&EventContext` argument
   * includes all the rows added to the client cache as a result of the new subscription.
   *
   * The event in the `&EventContext` argument is `Event::SubscribeApplied`.
   *
   * Multiple `on_applied` callbacks for the same query may coexist.
   * No mechanism for un-registering `on_applied` callbacks is exposed.
   *
   * @param cb - Callback to run when the subscription is applied.
   * @returns The current `SubscriptionBuilder` instance.
   */
  onApplied(cb) {
    this.#onApplied = cb;
    return this;
  }
  /**
   * Registers `callback` to run when this query either:
   * - Fails to be added to our subscribed set.
   * - Is unexpectedly removed from our subscribed set.
   *
   * If the subscription had previously started and has been unexpectedly removed,
   * the database state exposed via the `&EventContext` argument contains no rows
   * from any subscriptions removed within the same error event.
   * As proposed, it must therefore contain no rows.
   *
   * The event in the `&EventContext` argument is `Event::SubscribeError`,
   * containing a dynamic error object with a human-readable description of the error
   * for diagnostic purposes.
   *
   * Multiple `on_error` callbacks for the same query may coexist.
   * No mechanism for un-registering `on_error` callbacks is exposed.
   *
   * @param cb - Callback to run when there is an error in subscription.
   * @returns The current `SubscriptionBuilder` instance.
   */
  onError(cb) {
    this.#onError = cb;
    return this;
  }
  subscribe(query_sql) {
    let queries;
    if (typeof query_sql === "function") {
      const tables2 = this.db.getFromBuilder();
      const result = query_sql(tables2);
      queries = Array.isArray(result) ? result : [result];
    } else {
      queries = Array.isArray(query_sql) ? query_sql : [query_sql];
    }
    if (queries.length === 0) {
      throw new Error("Subscriptions must have at least one query");
    }
    const queryStrings = queries.map((q) => {
      if (typeof q === "string") return q;
      if (isRowTypedQuery(q)) return toSql(q);
      throw new Error("Subscriptions must be SQL strings or typed queries");
    });
    return new SubscriptionHandleImpl(
      this.db,
      queryStrings,
      this.#onApplied,
      this.#onError
    );
  }
  /**
   * Subscribes to all rows from all tables.
   *
   * This method is intended as a convenience
   * for applications where client-side memory use and network bandwidth are not concerns.
   * Applications where these resources are a constraint
   * should register more precise queries via `subscribe`
   * in order to replicate only the subset of data which the client needs to function.
   *
   * This method should not be combined with `subscribe` on the same `DbConnection`.
   * A connection may either `subscribe` to particular queries,
   * or `subscribeToAllTables`, but not both.
   * Attempting to call `subscribe`
   * on a `DbConnection` that has previously used `subscribeToAllTables`,
   * or vice versa, may misbehave in any number of ways,
   * including dropping subscriptions, corrupting the client cache, or throwing errors.
   */
  subscribeToAllTables() {
    const remoteModule = this.db[INTERNAL_REMOTE_MODULE]();
    const queries = Object.values(remoteModule.tables).map(
      (table2) => `SELECT * FROM ${table2.sourceName}`
    );
    this.subscribe(queries);
  }
};
var SubscriptionManager = class {
  subscriptions = /* @__PURE__ */ new Map();
};
var SubscriptionHandleImpl = class {
  constructor(db, querySql, onApplied, onError) {
    this.db = db;
    this.#emitter.on(
      "applied",
      (ctx) => {
        this.#activeState = true;
        if (onApplied) {
          onApplied(ctx);
        }
      }
    );
    this.#emitter.on(
      "error",
      (ctx, error) => {
        this.#activeState = false;
        this.#endedState = true;
        if (onError) {
          onError(ctx, error);
        }
      }
    );
    this.#querySetId = this.db.registerSubscription(
      this,
      this.#emitter,
      querySql
    );
  }
  #querySetId;
  #unsubscribeCalled = false;
  #endedState = false;
  #activeState = false;
  #emitter = new EventEmitter();
  /**
   * Consumes self and issues an `Unsubscribe` message,
   * removing this query from the client's set of subscribed queries.
   * It is only valid to call this method if `is_active()` is `true`.
   */
  unsubscribe() {
    if (this.#unsubscribeCalled) {
      throw new Error("Unsubscribe has already been called");
    }
    this.#unsubscribeCalled = true;
    this.db.unregisterSubscription(this.#querySetId);
    this.#emitter.on(
      "end",
      (_ctx) => {
        this.#endedState = true;
        this.#activeState = false;
      }
    );
  }
  /**
   * Unsubscribes and also registers a callback to run upon success.
   * I.e. when an `UnsubscribeApplied` message is received.
   *
   * If `Unsubscribe` returns an error,
   * or if the `on_error` callback(s) are invoked before this subscription would end normally,
   * the `on_end` callback is not invoked.
   *
   * @param onEnd - Callback to run upon successful unsubscribe.
   */
  unsubscribeThen(onEnd) {
    if (this.#endedState) {
      throw new Error("Subscription has already ended");
    }
    if (this.#unsubscribeCalled) {
      throw new Error("Unsubscribe has already been called");
    }
    this.#unsubscribeCalled = true;
    this.db.unregisterSubscription(this.#querySetId);
    this.#emitter.on(
      "end",
      (ctx) => {
        this.#endedState = true;
        this.#activeState = false;
        onEnd(ctx);
      }
    );
  }
  /**
   * True if this `SubscriptionHandle` has ended,
   * either due to an error or a call to `unsubscribe`.
   *
   * This is initially false, and becomes true when either the `on_end` or `on_error` callback is invoked.
   * A subscription which has not yet been applied is not active, but is also not ended.
   */
  isEnded() {
    return this.#endedState;
  }
  /**
   * True if this `SubscriptionHandle` is active, meaning it has been successfully applied
   * and has not since ended, either due to an error or a complete `unsubscribe` request-response pair.
   *
   * This corresponds exactly to the interval bounded at the start by the `on_applied` callback
   * and at the end by either the `on_end` or `on_error` callback.
   */
  isActive() {
    return this.#activeState;
  }
};
var V2_WS_PROTOCOL = "v2.bsatn.spacetimedb";
var V3_WS_PROTOCOL = "v3.bsatn.spacetimedb";
var PREFERRED_WS_PROTOCOLS = [V3_WS_PROTOCOL, V2_WS_PROTOCOL];
function normalizeWsProtocol(protocol) {
  if (protocol === V3_WS_PROTOCOL) {
    return V3_WS_PROTOCOL;
  }
  if (protocol === "" || protocol === V2_WS_PROTOCOL) {
    return V2_WS_PROTOCOL;
  }
  stdbLogger(
    "warn",
    `Unexpected websocket subprotocol "${protocol}", falling back to ${V2_WS_PROTOCOL}.`
  );
  return V2_WS_PROTOCOL;
}
var EMPTY_V3_PAYLOAD_ERR = "v3 websocket payloads must contain at least one message";
function ensureMessages(messages) {
  if (messages.length === 0) {
    throw new RangeError(EMPTY_V3_PAYLOAD_ERR);
  }
}
function ensureMessageCount(messages, messageCount) {
  ensureMessages(messages);
  if (messageCount < 1 || messageCount > messages.length) {
    throw new RangeError(
      `v3 websocket payload requested ${messageCount} messages from ${messages.length}`
    );
  }
}
function concatenateMessagesV3(writer, messages, messageCount = messages.length) {
  ensureMessageCount(messages, messageCount);
  writer.clear();
  for (let i = 0; i < messageCount; i++) {
    writer.writeBytes(messages[i]);
  }
  return writer.getBuffer();
}
function countClientMessagesForV3Frame(messages, maxFrameBytes) {
  ensureMessages(messages);
  const firstMessage = messages[0];
  if (firstMessage.length > maxFrameBytes) {
    return 1;
  }
  let count = 1;
  let frameSize = firstMessage.length;
  while (count < messages.length) {
    const nextMessage = messages[count];
    const nextFrameSize = frameSize + nextMessage.length;
    if (nextFrameSize > maxFrameBytes) {
      break;
    }
    frameSize = nextFrameSize;
    count += 1;
  }
  return count;
}
function encodeClientMessagesV3(writer, messages, messageCount = messages.length) {
  return concatenateMessagesV3(writer, messages, messageCount);
}
function forEachServerMessageV3(reader, data, visit) {
  reader.reset(data);
  if (reader.remaining === 0) {
    throw new RangeError(EMPTY_V3_PAYLOAD_ERR);
  }
  let count = 0;
  while (reader.remaining > 0) {
    visit(ServerMessage.deserialize(reader));
    count += 1;
  }
  return count;
}
var TEXT_ENCODER = new TextEncoder();
function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
function getClientMessageVariantTag(name) {
  if (ClientMessage.algebraicType.tag !== "Sum") {
    throw new TypeError("ClientMessage must be a sum type");
  }
  const tag = ClientMessage.algebraicType.value.variants.findIndex(
    (variant) => variant.name === name
  );
  if (tag === -1) {
    throw new RangeError(`Unknown ClientMessage variant: ${name}`);
  }
  return tag;
}
var CLIENT_MESSAGE_CALL_REDUCER_TAG = getClientMessageVariantTag("CallReducer");
var CLIENT_MESSAGE_CALL_PROCEDURE_TAG = getClientMessageVariantTag("CallProcedure");
var MAX_V3_OUTBOUND_FRAME_BYTES = 256 * 1024;
var WS_READY_STATE_CLOSING = 2;
var WS_READY_STATE_CLOSED = 3;
var DbConnectionImpl = class {
  /**
   * Whether or not the connection is active.
   */
  isActive = false;
  /**
   * Whether `disconnect()` has been called on this connection.
   * Once requested, the connection will not be reused: managed environments
   * (such as the React `SpacetimeDBProvider`) use this to avoid reconnecting
   * after an intentional disconnect.
   */
  isDisconnectRequested = false;
  /**
   * Whether the underlying websocket has entered `CLOSING` (2) or `CLOSED`
   * (3). This becomes true even when the browser never delivered an
   * `onclose` event, for example if the socket was torn down while the tab was
   * frozen or the machine was asleep. The `ConnectionManager` uses this to detect
   * such "zombie" connections when the page resumes and to force a reconnect.
   *
   * Returns false while the socket is still `CONNECTING`/`OPEN`, or before
   * the socket has been created.
   */
  get isSocketClosed() {
    const ws = this.ws;
    if (!ws) {
      return false;
    }
    return ws.readyState === WS_READY_STATE_CLOSING || ws.readyState === WS_READY_STATE_CLOSED;
  }
  /**
   * This connection's public identity.
   */
  identity = void 0;
  /**
   * This connection's private authentication token.
   */
  token = void 0;
  /** @internal */
  [INTERNAL_REMOTE_MODULE]() {
    return this.#remoteModule;
  }
  /**
   * The accessor field to access the tables in the database and associated
   * callback functions.
   */
  db;
  /**
   * The accessor field to access the reducers in the database.
   */
  reducers;
  /**
   * The accessor field to access the procedures in the database.
   */
  procedures;
  /**
   * The `ConnectionId` of the connection to to the database.
   */
  connectionId = ConnectionId.random();
  #connectionIdHex = this.connectionId.toHexString();
  // These fields are meant to be strictly private.
  #queryId = 0;
  #requestId = 0;
  #eventId = 0;
  #emitter;
  #inboundQueue = [];
  #inboundQueueOffset = 0;
  #isDrainingInboundQueue = false;
  #outboundQueue = [];
  #isOutboundFlushScheduled = false;
  #negotiatedWsProtocol = V2_WS_PROTOCOL;
  #subscriptionManager = new SubscriptionManager();
  #remoteModule;
  #reducerCallbacks = /* @__PURE__ */ new Map();
  #reducerCallInfo = /* @__PURE__ */ new Map();
  #procedureCallbacks = /* @__PURE__ */ new Map();
  #rowDeserializers;
  #rowIdMetadata;
  #reducerArgsSerializers;
  #procedureSerializers;
  #reducerNameBytes;
  #procedureNameBytes;
  #sourceNameToTableDef;
  #messageReader = new BinaryReader(new Uint8Array());
  #rowListReader = new BinaryReader(new Uint8Array());
  #clientFrameEncoder = new BinaryWriter(1024);
  #boundSubscriptionBuilder;
  #boundDisconnect;
  // These fields are not part of the public API, but in a pinch you
  // could use JavaScript to access them by bypassing TypeScript's
  // private fields.
  // We use them in testing.
  clientCache;
  ws;
  wsPromise;
  constructor({
    uri,
    nameOrAddress,
    identity,
    token,
    emitter,
    remoteModule,
    createWSFn,
    compression,
    lightMode,
    confirmedReads
  }) {
    stdbLogger("info", "Connecting to SpacetimeDB WS...");
    const url = new URL(uri.toString());
    if (!/^wss?:/.test(uri.protocol)) {
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    }
    this.identity = identity;
    this.token = token;
    this.#remoteModule = remoteModule;
    this.#emitter = emitter;
    this.#boundSubscriptionBuilder = this.subscriptionBuilder.bind(this);
    this.#boundDisconnect = this.disconnect.bind(this);
    this.#rowDeserializers = /* @__PURE__ */ Object.create(null);
    this.#rowIdMetadata = /* @__PURE__ */ Object.create(null);
    this.#sourceNameToTableDef = /* @__PURE__ */ Object.create(null);
    for (const table2 of Object.values(remoteModule.tables)) {
      this.#rowDeserializers[table2.sourceName] = ProductType.makeDeserializer(
        table2.rowType
      );
      this.#sourceNameToTableDef[table2.sourceName] = table2;
      const primaryKeyColumn = Object.entries(table2.columns).find(
        ([, column]) => column.columnMetadata.isPrimaryKey
      );
      this.#rowIdMetadata[table2.sourceName] = primaryKeyColumn ? {
        primaryKeyColName: primaryKeyColumn[0],
        primaryKeyColType: primaryKeyColumn[1].typeBuilder.algebraicType
      } : {};
    }
    this.#reducerArgsSerializers = /* @__PURE__ */ Object.create(null);
    this.#reducerNameBytes = /* @__PURE__ */ Object.create(null);
    for (const reducer of remoteModule.reducers) {
      this.#reducerArgsSerializers[reducer.name] = {
        serialize: ProductType.makeSerializer(reducer.paramsType),
        deserialize: ProductType.makeDeserializer(reducer.paramsType)
      };
      this.#reducerNameBytes[reducer.name] = TEXT_ENCODER.encode(reducer.name);
    }
    this.#procedureSerializers = /* @__PURE__ */ Object.create(null);
    this.#procedureNameBytes = /* @__PURE__ */ Object.create(null);
    for (const procedure of remoteModule.procedures) {
      this.#procedureSerializers[procedure.name] = {
        serializeArgs: ProductType.makeSerializer(
          new ProductBuilder(procedure.params).algebraicType.value
        ),
        deserializeReturn: AlgebraicType.makeDeserializer(
          procedure.returnType.algebraicType
        )
      };
      this.#procedureNameBytes[procedure.name] = TEXT_ENCODER.encode(
        procedure.name
      );
    }
    url.searchParams.set("connection_id", this.#connectionIdHex);
    this.clientCache = new ClientCache();
    this.db = this.#makeDbView();
    this.reducers = this.#makeReducers(remoteModule);
    this.procedures = this.#makeProcedures(remoteModule);
    this.wsPromise = createWSFn({
      url,
      nameOrAddress,
      wsProtocol: [...PREFERRED_WS_PROTOCOLS],
      authToken: token,
      compression,
      lightMode,
      confirmedReads
    }).then((v) => {
      this.ws = v;
      this.ws.onclose = () => {
        this.isActive = false;
        this.#emitter.emit("disconnect", this);
      };
      this.ws.onerror = (e) => {
        this.isActive = false;
        this.#emitter.emit("connectError", this, e);
      };
      this.ws.onopen = this.#handleOnOpen.bind(this);
      this.ws.onmessage = this.#handleOnMessage.bind(this);
      return v;
    }).catch((e) => {
      stdbLogger("error", "Error connecting to SpacetimeDB WS");
      this.#emitter.emit("connectError", this, e);
      return void 0;
    });
  }
  #getNextQueryId = () => {
    const queryId = this.#queryId;
    this.#queryId += 1;
    return queryId;
  };
  #getNextRequestId = () => this.#requestId++;
  #makeDbView() {
    const view = /* @__PURE__ */ Object.create(null);
    for (const tbl of Object.values(this.#sourceNameToTableDef)) {
      const key = tbl.accessorName;
      Object.defineProperty(view, key, {
        enumerable: true,
        configurable: false,
        get: () => this.clientCache.getOrCreateTable(tbl)
      });
    }
    return view;
  }
  #makeReducers(def) {
    const out = {};
    for (const reducer of def.reducers) {
      const reducerName = reducer.name;
      const encodedReducerName = this.#reducerNameBytes[reducerName];
      const key = reducer.accessorName;
      const { serialize: serializeArgs } = this.#reducerArgsSerializers[reducerName];
      out[key] = (params) => {
        const writer = this.#reducerArgsEncoder;
        writer.clear();
        serializeArgs(writer, params);
        const argsBuffer = writer.getBuffer();
        return this.#callReducerWithEncodedName(
          reducerName,
          encodedReducerName,
          argsBuffer,
          params
        );
      };
    }
    return out;
  }
  #makeProcedures(def) {
    const out = {};
    const writer = new BinaryWriter(1024);
    for (const procedure of def.procedures) {
      const procedureName = procedure.name;
      const encodedProcedureName = this.#procedureNameBytes[procedureName];
      const key = procedure.accessorName;
      const { serializeArgs, deserializeReturn } = this.#procedureSerializers[procedureName];
      out[key] = (params) => {
        writer.clear();
        serializeArgs(writer, params);
        const argsBuffer = writer.getBuffer();
        return this.#callProcedureWithEncodedName(
          procedureName,
          encodedProcedureName,
          argsBuffer
        ).then((returnBuf) => {
          return deserializeReturn(new BinaryReader(returnBuf));
        });
      };
    }
    return out;
  }
  #makeEventContext(event) {
    return {
      db: this.db,
      reducers: this.reducers,
      isActive: this.isActive,
      subscriptionBuilder: this.#boundSubscriptionBuilder,
      disconnect: this.#boundDisconnect,
      event
    };
  }
  // NOTE: This is very important!!! This is the actual function that
  // gets called when you call `connection.subscriptionBuilder()`.
  // The `subscriptionBuilder` function which is generated, just shadows
  // this function in the type system, but not the actual implementation!
  // Do not remove this function, or shoot yourself in the foot please.
  // It's not clear what would be a better way to do this at this exact
  // moment.
  subscriptionBuilder = () => {
    return new SubscriptionBuilderImpl(this);
  };
  getFromBuilder() {
    return makeFromBuilder(
      this.#remoteModule.tables
    );
  }
  registerSubscription(handle, handleEmitter, querySql) {
    const querySetId = this.#getNextQueryId();
    this.#subscriptionManager.subscriptions.set(querySetId, {
      handle,
      emitter: handleEmitter
    });
    const requestId = this.#getNextRequestId();
    this.#sendMessage(
      ClientMessage.Subscribe({
        queryStrings: querySql,
        querySetId: { id: querySetId },
        requestId
      })
    );
    return querySetId;
  }
  unregisterSubscription(querySetId) {
    const requestId = this.#getNextRequestId();
    this.#sendMessage(
      ClientMessage.Unsubscribe({
        querySetId: { id: querySetId },
        requestId,
        flags: UnsubscribeFlags.SendDroppedRows
      })
    );
  }
  #parseRowList(type, tableName, rowList) {
    const buffer = rowList.rowsData;
    const reader = this.#rowListReader;
    reader.reset(buffer);
    const rows = [];
    const deserializeRow = this.#rowDeserializers[tableName];
    const { primaryKeyColName, primaryKeyColType } = this.#rowIdMetadata[tableName];
    let previousOffset = 0;
    while (reader.remaining > 0) {
      const row = deserializeRow(reader);
      let rowId = void 0;
      if (primaryKeyColName !== void 0 && primaryKeyColType !== void 0) {
        rowId = AlgebraicType.intoMapKey(
          primaryKeyColType,
          row[primaryKeyColName]
        );
      } else {
        const rowBytes = buffer.subarray(previousOffset, reader.offset);
        const asBase64 = (0, import_base64_js.fromByteArray)(rowBytes);
        rowId = asBase64;
      }
      previousOffset = reader.offset;
      rows.push({
        type,
        rowId,
        row
      });
    }
    return rows;
  }
  // Take a bunch of table updates and ensure that there is at most one update per table.
  #mergeTableUpdates(updates) {
    const merged = /* @__PURE__ */ new Map();
    for (const update of updates) {
      const ops = merged.get(update.tableName);
      if (ops) {
        for (const op of update.operations) ops.push(op);
      } else {
        merged.set(update.tableName, update.operations.slice());
      }
    }
    return Array.from(merged, ([tableName, operations]) => ({
      tableName,
      operations
    }));
  }
  #queryRowsToTableUpdates(rows, opType) {
    const updates = [];
    for (const tableRows of rows.tables) {
      updates.push({
        tableName: tableRows.table,
        operations: this.#parseRowList(opType, tableRows.table, tableRows.rows)
      });
    }
    return this.#mergeTableUpdates(updates);
  }
  #tableUpdateRowsToOperations(tableName, rows) {
    if (rows.tag === "PersistentTable") {
      const inserts = this.#parseRowList(
        "insert",
        tableName,
        rows.value.inserts
      );
      const deletes = this.#parseRowList(
        "delete",
        tableName,
        rows.value.deletes
      );
      return inserts.concat(deletes);
    }
    if (rows.tag === "EventTable") {
      return this.#parseRowList("insert", tableName, rows.value.events);
    }
    return [];
  }
  #querySetUpdateToTableUpdates(querySetUpdate) {
    const updates = [];
    for (const tableUpdate of querySetUpdate.tables) {
      let operations = [];
      for (const rows of tableUpdate.rows) {
        operations = operations.concat(
          this.#tableUpdateRowsToOperations(tableUpdate.tableName, rows)
        );
      }
      updates.push({
        tableName: tableUpdate.tableName,
        operations
      });
    }
    return this.#mergeTableUpdates(updates);
  }
  #flushOutboundQueue(wsResolved) {
    if (this.#negotiatedWsProtocol === V3_WS_PROTOCOL) {
      this.#flushOutboundQueueV3(wsResolved);
      return;
    }
    this.#flushOutboundQueueV2(wsResolved);
  }
  #flushOutboundQueueV2(wsResolved) {
    const pending = this.#outboundQueue.splice(0);
    for (const message of pending) {
      wsResolved.send(message);
    }
  }
  #flushOutboundQueueV3(wsResolved) {
    if (this.#outboundQueue.length === 0) {
      return;
    }
    const batchSize = countClientMessagesForV3Frame(
      this.#outboundQueue,
      MAX_V3_OUTBOUND_FRAME_BYTES
    );
    wsResolved.send(
      encodeClientMessagesV3(
        this.#clientFrameEncoder,
        this.#outboundQueue,
        batchSize
      )
    );
    if (batchSize === this.#outboundQueue.length) {
      this.#outboundQueue.length = 0;
      return;
    }
    this.#outboundQueue.copyWithin(0, batchSize);
    this.#outboundQueue.length -= batchSize;
    if (this.#outboundQueue.length > 0) {
      this.#scheduleDeferredOutboundFlush();
    }
  }
  #scheduleOutboundFlush() {
    this.#scheduleOutboundFlushWith("microtask");
  }
  #scheduleDeferredOutboundFlush() {
    this.#scheduleOutboundFlushWith("next-task");
  }
  #scheduleOutboundFlushWith(schedule) {
    if (this.#isOutboundFlushScheduled) {
      return;
    }
    this.#isOutboundFlushScheduled = true;
    const flush = () => {
      this.#isOutboundFlushScheduled = false;
      if (this.ws && this.isActive) {
        this.#flushOutboundQueue(this.ws);
      }
    };
    if (schedule === "next-task") {
      setTimeout(flush, 0);
    } else {
      queueMicrotask(flush);
    }
  }
  #reducerArgsEncoder = new BinaryWriter(1024);
  #clientMessageEncoder = new BinaryWriter(1024);
  #sendEncodedMessage(encoded, describe) {
    stdbLogger("trace", describe);
    if (this.ws && this.isActive) {
      if (this.#negotiatedWsProtocol === V2_WS_PROTOCOL) {
        if (this.#outboundQueue.length) this.#flushOutboundQueue(this.ws);
        this.ws.send(encoded);
        return;
      }
      this.#outboundQueue.push(encoded.slice());
      this.#scheduleOutboundFlush();
    } else {
      this.#outboundQueue.push(encoded.slice());
    }
  }
  #sendMessage(message) {
    const writer = this.#clientMessageEncoder;
    writer.clear();
    ClientMessage.serialize(writer, message);
    const encoded = writer.getBuffer();
    const isLive = !!(this.ws && this.isActive);
    this.#sendEncodedMessage(
      encoded,
      () => isLive ? `Sending message to server: ${stringify2(message)}` : `Queuing message to server: ${stringify2(message)}`
    );
  }
  #sendCallReducerMessage(requestId, reducerNameBytes, argsBuffer) {
    const writer = this.#clientMessageEncoder;
    writer.clear();
    writer.writeByte(CLIENT_MESSAGE_CALL_REDUCER_TAG);
    writer.writeU32(requestId);
    writer.writeU8(0);
    writer.writeUInt8Array(reducerNameBytes);
    writer.writeUInt8Array(argsBuffer);
    const encoded = writer.getBuffer();
    this.#sendEncodedMessage(
      encoded,
      () => `Sending reducer call message to server: requestId=${requestId}`
    );
  }
  #sendCallProcedureMessage(requestId, procedureNameBytes, argsBuffer) {
    const writer = this.#clientMessageEncoder;
    writer.clear();
    writer.writeByte(CLIENT_MESSAGE_CALL_PROCEDURE_TAG);
    writer.writeU32(requestId);
    writer.writeU8(0);
    writer.writeUInt8Array(procedureNameBytes);
    writer.writeUInt8Array(argsBuffer);
    const encoded = writer.getBuffer();
    this.#sendEncodedMessage(
      encoded,
      () => `Sending procedure call message to server: requestId=${requestId}`
    );
  }
  #setConnectionId(connectionId) {
    this.connectionId = connectionId;
    this.#connectionIdHex = connectionId.toHexString();
  }
  #nextEventId() {
    this.#eventId += 1;
    return `${this.#connectionIdHex}:${this.#eventId}`;
  }
  /**
   * Handles WebSocket onOpen event.
   */
  #handleOnOpen() {
    if (this.ws) {
      this.#negotiatedWsProtocol = normalizeWsProtocol(this.ws.protocol);
    }
    this.isActive = true;
    if (this.ws) {
      this.#flushOutboundQueue(this.ws);
    }
  }
  #applyTableUpdates(tableUpdates, eventContext) {
    const pendingCallbacks = [];
    for (const tableUpdate of tableUpdates) {
      const tableName = tableUpdate.tableName;
      const tableDef = this.#sourceNameToTableDef[tableName];
      const table2 = this.clientCache.getOrCreateTable(tableDef);
      const newCallbacks = table2.applyOperations(
        tableUpdate.operations,
        eventContext
      );
      for (const callback of newCallbacks) {
        pendingCallbacks.push(callback);
      }
    }
    return pendingCallbacks;
  }
  #applyTransactionUpdates(eventContext, tu) {
    const allUpdates = [];
    for (const querySetUpdate of tu.querySets) {
      const tableUpdates = this.#querySetUpdateToTableUpdates(querySetUpdate);
      for (const update of tableUpdates) {
        allUpdates.push(update);
      }
    }
    return this.#applyTableUpdates(
      this.#mergeTableUpdates(allUpdates),
      eventContext
    );
  }
  #dispatchPendingCallbacks(callbacks) {
    stdbLogger(
      "trace",
      () => `Calling ${callbacks.length} triggered row callbacks`
    );
    for (const callback of callbacks) {
      callback.cb();
    }
  }
  #processServerMessage(serverMessage) {
    stdbLogger(
      "trace",
      () => `Processing server message: ${stringify2(serverMessage)}`
    );
    switch (serverMessage.tag) {
      case "InitialConnection": {
        this.identity = serverMessage.value.identity;
        if (!this.token && serverMessage.value.token) {
          this.token = serverMessage.value.token;
        }
        this.#setConnectionId(serverMessage.value.connectionId);
        this.#emitter.emit("connect", this, this.identity, this.token);
        break;
      }
      case "SubscribeApplied": {
        const querySetId = serverMessage.value.querySetId.id;
        const subscription = this.#subscriptionManager.subscriptions.get(querySetId);
        if (!subscription) {
          stdbLogger(
            "error",
            `Received SubscribeApplied for unknown querySetId ${querySetId}.`
          );
          return;
        }
        const event = {
          id: this.#nextEventId(),
          tag: "SubscribeApplied"
        };
        const eventContext = this.#makeEventContext(event);
        const tableUpdates = this.#queryRowsToTableUpdates(
          serverMessage.value.rows,
          "insert"
        );
        const callbacks = this.#applyTableUpdates(tableUpdates, eventContext);
        const { event: _, ...subscriptionEventContext } = eventContext;
        subscription.emitter.emit("applied", subscriptionEventContext);
        this.#dispatchPendingCallbacks(callbacks);
        break;
      }
      case "UnsubscribeApplied": {
        const querySetId = serverMessage.value.querySetId.id;
        const subscription = this.#subscriptionManager.subscriptions.get(querySetId);
        if (!subscription) {
          stdbLogger(
            "error",
            `Received UnsubscribeApplied for unknown querySetId ${querySetId}.`
          );
          return;
        }
        const event = {
          id: this.#nextEventId(),
          tag: "UnsubscribeApplied"
        };
        const eventContext = this.#makeEventContext(event);
        const tableUpdates = serverMessage.value.rows ? this.#queryRowsToTableUpdates(serverMessage.value.rows, "delete") : [];
        const callbacks = this.#applyTableUpdates(tableUpdates, eventContext);
        const { event: _, ...subscriptionEventContext } = eventContext;
        subscription.emitter.emit("end", subscriptionEventContext);
        this.#subscriptionManager.subscriptions.delete(querySetId);
        this.#dispatchPendingCallbacks(callbacks);
        break;
      }
      case "SubscriptionError": {
        const querySetId = serverMessage.value.querySetId.id;
        const requestId = serverMessage.value.requestId;
        const error = Error(serverMessage.value.error);
        const event = {
          id: this.#nextEventId(),
          tag: "Error",
          value: error
        };
        const eventContext = this.#makeEventContext(event);
        const errorContext = {
          ...eventContext,
          event: error
        };
        if (requestId == null) {
          stdbLogger(
            "error",
            `Disconnecting due to error for a previously applied subscription: ${serverMessage.value.error}`
          );
          this.disconnect();
          break;
        }
        const subscription = this.#subscriptionManager.subscriptions.get(querySetId);
        if (subscription) {
          subscription.emitter.emit("error", errorContext, error);
          this.#subscriptionManager.subscriptions.delete(querySetId);
        } else {
          stdbLogger(
            "error",
            `Received SubscriptionError for unknown querySetId ${querySetId}:`,
            error
          );
        }
        break;
      }
      case "TransactionUpdate": {
        const event = {
          id: this.#nextEventId(),
          tag: "Transaction"
        };
        const eventContext = this.#makeEventContext(event);
        const callbacks = this.#applyTransactionUpdates(
          eventContext,
          serverMessage.value
        );
        this.#dispatchPendingCallbacks(callbacks);
        break;
      }
      case "ReducerResult": {
        const { requestId, result } = serverMessage.value;
        if (result.tag === "Ok") {
          const reducerInfo = this.#reducerCallInfo.get(requestId);
          const eventId = this.#nextEventId();
          const event = reducerInfo ? {
            id: eventId,
            tag: "Reducer",
            value: {
              timestamp: serverMessage.value.timestamp,
              outcome: result,
              reducer: {
                name: reducerInfo.name,
                args: reducerInfo.args
              }
            }
          } : {
            id: eventId,
            tag: "Transaction"
          };
          const eventContext = this.#makeEventContext(event);
          const callbacks = this.#applyTransactionUpdates(
            eventContext,
            result.value.transactionUpdate
          );
          this.#dispatchPendingCallbacks(callbacks);
        }
        this.#reducerCallInfo.delete(requestId);
        const cb = this.#reducerCallbacks.get(requestId);
        this.#reducerCallbacks.delete(requestId);
        cb?.(result);
        break;
      }
      case "ProcedureResult": {
        const { status, requestId } = serverMessage.value;
        const result = status.tag === "Returned" ? { tag: "Ok", value: status.value } : { tag: "Err", value: status.value };
        const cb = this.#procedureCallbacks.get(requestId);
        this.#procedureCallbacks.delete(requestId);
        cb?.(result);
        break;
      }
      case "OneOffQueryResult": {
        stdbLogger(
          "warn",
          "Received OneOffQueryResult but SDK does not expose one-off query APIs yet."
        );
        break;
      }
    }
  }
  #processV2Message(data) {
    const reader = this.#messageReader;
    reader.reset(data);
    this.#processServerMessage(ServerMessage.deserialize(reader));
  }
  #processMessage(data) {
    if (this.#negotiatedWsProtocol !== V3_WS_PROTOCOL) {
      this.#processV2Message(data);
      return;
    }
    const messageCount = forEachServerMessageV3(
      this.#messageReader,
      data,
      (serverMessage) => {
        this.#processServerMessage(serverMessage);
      }
    );
    stdbLogger(
      "trace",
      () => `Processing server v3 payload with ${messageCount} message(s)`
    );
  }
  /**
   * Handles WebSocket onMessage event.
   * @param wsMessage MessageEvent object.
   */
  #handleOnMessage(wsMessage) {
    this.#inboundQueue.push(wsMessage.data);
    if (this.#isDrainingInboundQueue) {
      return;
    }
    this.#isDrainingInboundQueue = true;
    try {
      while (this.#inboundQueueOffset < this.#inboundQueue.length) {
        const data = this.#inboundQueue[this.#inboundQueueOffset];
        this.#inboundQueueOffset += 1;
        if (data) {
          this.#processMessage(data);
        }
      }
    } finally {
      if (this.#inboundQueueOffset >= this.#inboundQueue.length) {
        this.#inboundQueue.length = 0;
      } else if (this.#inboundQueueOffset > 0) {
        this.#inboundQueue = this.#inboundQueue.slice(this.#inboundQueueOffset);
      }
      this.#inboundQueueOffset = 0;
      this.#isDrainingInboundQueue = false;
    }
  }
  /**
   * Call a reducer on your SpacetimeDB module.
   *
   * @param reducerName The name of the reducer to call
   * @param argsSerializer The arguments to pass to the reducer
   */
  callReducer(reducerName, argsBuffer, reducerArgs) {
    const encodedReducerName = this.#reducerNameBytes[reducerName];
    if (encodedReducerName) {
      return this.#callReducerWithEncodedName(
        reducerName,
        encodedReducerName,
        argsBuffer,
        reducerArgs
      );
    }
    return this.#callReducerGeneric(reducerName, argsBuffer, reducerArgs);
  }
  #callReducerWithEncodedName(reducerName, encodedReducerName, argsBuffer, reducerArgs) {
    const { promise, resolve, reject } = createDeferred();
    const requestId = this.#getNextRequestId();
    this.#sendCallReducerMessage(requestId, encodedReducerName, argsBuffer);
    if (reducerArgs) {
      this.#reducerCallInfo.set(requestId, {
        name: reducerName,
        args: reducerArgs
      });
    }
    this.#reducerCallbacks.set(requestId, (result) => {
      if (result.tag === "Ok" || result.tag === "OkEmpty") {
        resolve();
      } else {
        if (result.tag === "Err") {
          const reader = new BinaryReader(result.value);
          const errorString = reader.readString();
          reject(new SenderError(errorString));
        } else if (result.tag === "InternalError") {
          reject(new InternalError(result.value));
        } else {
          reject(new Error("Unexpected reducer result"));
        }
      }
    });
    return promise;
  }
  #callReducerGeneric(reducerName, argsBuffer, reducerArgs) {
    const { promise, resolve, reject } = createDeferred();
    const requestId = this.#getNextRequestId();
    const message = ClientMessage.CallReducer({
      reducer: reducerName,
      args: argsBuffer,
      requestId,
      flags: 0
    });
    this.#sendMessage(message);
    if (reducerArgs) {
      this.#reducerCallInfo.set(requestId, {
        name: reducerName,
        args: reducerArgs
      });
    }
    this.#reducerCallbacks.set(requestId, (result) => {
      if (result.tag === "Ok" || result.tag === "OkEmpty") {
        resolve();
      } else {
        if (result.tag === "Err") {
          const reader = new BinaryReader(result.value);
          const errorString = reader.readString();
          reject(new SenderError(errorString));
        } else if (result.tag === "InternalError") {
          reject(new InternalError(result.value));
        } else {
          reject(new Error("Unexpected reducer result"));
        }
      }
    });
    return promise;
  }
  /**
   * Call a reducer on your SpacetimeDB module with typed arguments.
   * @param reducerSchema The schema of the reducer to call
   * @param callReducerFlags The flags for the reducer call
   * @param params The arguments to pass to the reducer
   */
  callReducerWithParams(reducerName, _paramsType, params) {
    const writer = this.#reducerArgsEncoder;
    writer.clear();
    this.#reducerArgsSerializers[reducerName].serialize(writer, params);
    const argsBuffer = writer.getBuffer();
    return this.callReducer(reducerName, argsBuffer, params);
  }
  /**
   * Call a reducer on your SpacetimeDB module.
   *
   * @param procedureName The name of the reducer to call
   * @param argsBuffer The arguments to pass to the reducer
   */
  callProcedure(procedureName, argsBuffer) {
    const encodedProcedureName = this.#procedureNameBytes[procedureName];
    if (encodedProcedureName) {
      return this.#callProcedureWithEncodedName(
        procedureName,
        encodedProcedureName,
        argsBuffer
      );
    }
    return this.#callProcedureGeneric(procedureName, argsBuffer);
  }
  #callProcedureWithEncodedName(procedureName, encodedProcedureName, argsBuffer) {
    const { promise, resolve, reject } = createDeferred();
    const requestId = this.#getNextRequestId();
    this.#sendCallProcedureMessage(requestId, encodedProcedureName, argsBuffer);
    this.#procedureCallbacks.set(requestId, (result) => {
      if (result.tag === "Ok") {
        resolve(result.value);
      } else {
        reject(result.value);
      }
    });
    return promise;
  }
  #callProcedureGeneric(procedureName, argsBuffer) {
    const { promise, resolve, reject } = createDeferred();
    const requestId = this.#getNextRequestId();
    const message = ClientMessage.CallProcedure({
      procedure: procedureName,
      args: argsBuffer,
      requestId,
      // reserved for future use - 0 is the only valid value
      flags: 0
    });
    this.#sendMessage(message);
    this.#procedureCallbacks.set(requestId, (result) => {
      if (result.tag === "Ok") {
        resolve(result.value);
      } else {
        reject(result.value);
      }
    });
    return promise;
  }
  /**
   * Call a reducer on your SpacetimeDB module with typed arguments.
   * @param reducerSchema The schema of the reducer to call
   * @param callReducerFlags The flags for the reducer call
   * @param params The arguments to pass to the reducer
   */
  callProcedureWithParams(procedureName, _paramsType, params, _returnType) {
    const writer = new BinaryWriter(1024);
    const { serializeArgs, deserializeReturn } = this.#procedureSerializers[procedureName];
    serializeArgs(writer, params);
    const argsBuffer = writer.getBuffer();
    return this.callProcedure(procedureName, argsBuffer).then((returnBuf) => {
      return deserializeReturn(new BinaryReader(returnBuf));
    });
  }
  /**
   * Close the current connection.
   *
   * @example
   *
   * ```ts
   * const connection = DbConnection.builder().build();
   * connection.disconnect()
   * ```
   */
  disconnect() {
    this.isDisconnectRequested = true;
    this.wsPromise.then((ws) => ws?.close());
  }
  on(eventName, callback) {
    this.#emitter.on(eventName, callback);
  }
  off(eventName, callback) {
    this.#emitter.off(eventName, callback);
  }
  onConnect(callback) {
    this.#emitter.on("connect", callback);
  }
  onDisconnect(callback) {
    this.#emitter.on("disconnect", callback);
  }
  onConnectError(callback) {
    this.#emitter.on("connectError", callback);
  }
  removeOnConnect(callback) {
    this.#emitter.off("connect", callback);
  }
  removeOnDisconnect(callback) {
    this.#emitter.off("disconnect", callback);
  }
  removeOnConnectError(callback) {
    this.#emitter.off("connectError", callback);
  }
};
function tablesToSchema(ctx, tables2) {
  const tableDefs = /* @__PURE__ */ Object.create(null);
  for (const [accName, schema2] of Object.entries(tables2)) {
    tableDefs[accName] = tableToSchema(
      accName,
      schema2,
      schema2.tableDef(ctx, accName)
    );
  }
  return {
    tables: tableDefs
  };
}
function tableToSchema(accName, schema2, tableDef) {
  const getColName = (i) => schema2.rowType.algebraicType.value.elements[i].name;
  const resolvedIndexes = tableDef.indexes.map(
    (idx) => {
      const accessorName = idx.accessorName;
      if (typeof accessorName !== "string" || accessorName.length === 0) {
        throw new TypeError(
          `Index '${idx.sourceName ?? "<unknown>"}' on table '${tableDef.sourceName}' is missing accessor name`
        );
      }
      const columnIds = idx.algorithm.tag === "Direct" ? [idx.algorithm.value] : idx.algorithm.value;
      const unique = tableDef.constraints.some(
        (c) => c.data.tag === "Unique" && c.data.value.columns.every((col) => columnIds.includes(col))
      );
      const algorithm = {
        BTree: "btree",
        Hash: "hash",
        Direct: "direct"
      }[idx.algorithm.tag];
      return {
        name: accessorName,
        unique,
        algorithm,
        columns: columnIds.map(getColName)
      };
    }
  );
  return {
    // For client,`schama.tableName` will always be there as canonical name.
    // For module, if explicit name is not provided via `name`, accessor name will
    // be used, it is stored as alias in database, hence works in query builder.
    sourceName: schema2.tableName || accName,
    accessorName: accName,
    columns: schema2.rowType.row,
    // typed as T[i]['rowType']['row'] under TablesToSchema<T>
    rowType: schema2.rowSpacetimeType,
    // Keep declarative indexes in their original shape for type-level consumers.
    indexes: schema2.idxs,
    constraints: tableDef.constraints.map((c) => ({
      name: c.sourceName,
      constraint: "unique",
      columns: c.data.value.columns.map(getColName)
    })),
    // Expose resolved runtime indexes separately so runtime users don't have to
    // reinterpret `indexes` with unsafe casts.
    resolvedIndexes,
    tableDef,
    ...tableDef.isEvent ? { isEvent: true } : {}
  };
}
var ModuleContext = class {
  #compoundTypes = /* @__PURE__ */ new Map();
  /**
   * The global module definition that gets populated by calls to `reducer()` and lifecycle hooks.
   */
  #moduleDef = {
    typespace: { types: [] },
    tables: [],
    reducers: [],
    types: [],
    rowLevelSecurity: [],
    schedules: [],
    procedures: [],
    views: [],
    viewPrimaryKeys: [],
    lifeCycleReducers: [],
    httpHandlers: [],
    httpRoutes: [],
    caseConversionPolicy: { tag: "SnakeCase" },
    explicitNames: {
      entries: []
    },
    submodules: []
  };
  get moduleDef() {
    return this.#moduleDef;
  }
  rawModuleDefV10() {
    const sections = [];
    const push = (s) => {
      if (s) sections.push(s);
    };
    const module = this.#moduleDef;
    push(module.typespace && { tag: "Typespace", value: module.typespace });
    push(module.types && { tag: "Types", value: module.types });
    push(module.tables && { tag: "Tables", value: module.tables });
    push(module.reducers && { tag: "Reducers", value: module.reducers });
    push(module.procedures && { tag: "Procedures", value: module.procedures });
    push(module.views && { tag: "Views", value: module.views });
    push(
      module.viewPrimaryKeys && {
        tag: "ViewPrimaryKeys",
        value: module.viewPrimaryKeys
      }
    );
    push(module.schedules && { tag: "Schedules", value: module.schedules });
    push(
      module.lifeCycleReducers && {
        tag: "LifeCycleReducers",
        value: module.lifeCycleReducers
      }
    );
    push(
      module.httpHandlers && {
        tag: "HttpHandlers",
        value: module.httpHandlers
      }
    );
    push(
      module.httpRoutes && {
        tag: "HttpRoutes",
        value: module.httpRoutes
      }
    );
    push(
      module.rowLevelSecurity && {
        tag: "RowLevelSecurity",
        value: module.rowLevelSecurity
      }
    );
    push(
      module.explicitNames && {
        tag: "ExplicitNames",
        value: module.explicitNames
      }
    );
    push(
      module.caseConversionPolicy && {
        tag: "CaseConversionPolicy",
        value: module.caseConversionPolicy
      }
    );
    push(
      module.submodules && {
        tag: "Submodules",
        value: module.submodules
      }
    );
    return { sections };
  }
  addSubmodule(submodule) {
    this.#moduleDef.submodules.push(submodule);
  }
  /**
   * Set the case conversion policy for this module.
   * Called by the settings mechanism.
   */
  setCaseConversionPolicy(policy) {
    this.#moduleDef.caseConversionPolicy = policy;
  }
  get typespace() {
    return this.#moduleDef.typespace;
  }
  /**
   * Resolves the actual type of a TypeBuilder by following its references until it reaches a non-ref type.
   * @param typespace The typespace to resolve types against.
   * @param typeBuilder The TypeBuilder to resolve.
   * @returns The resolved algebraic type.
   */
  resolveType(typeBuilder) {
    let ty = typeBuilder.algebraicType;
    while (ty.tag === "Ref") {
      ty = this.typespace.types[ty.value];
    }
    return ty;
  }
  /**
   * Adds a type to the module definition's typespace as a `Ref` if it is a named compound type (Product or Sum).
   * Otherwise, returns the type as is.
   * @param name
   * @param ty
   * @returns
   */
  registerTypesRecursively(typeBuilder) {
    if (typeBuilder instanceof ProductBuilder && !isUnit(typeBuilder) || typeBuilder instanceof SumBuilder || typeBuilder instanceof RowBuilder) {
      return this.#registerCompoundTypeRecursively(typeBuilder);
    } else if (typeBuilder instanceof OptionBuilder) {
      return new OptionBuilder(
        this.registerTypesRecursively(typeBuilder.value)
      );
    } else if (typeBuilder instanceof ResultBuilder) {
      return new ResultBuilder(
        this.registerTypesRecursively(typeBuilder.ok),
        this.registerTypesRecursively(typeBuilder.err)
      );
    } else if (typeBuilder instanceof ArrayBuilder) {
      return new ArrayBuilder(
        this.registerTypesRecursively(typeBuilder.element)
      );
    } else {
      return typeBuilder;
    }
  }
  #registerCompoundTypeRecursively(typeBuilder) {
    const ty = typeBuilder.algebraicType;
    const name = typeBuilder.typeName;
    if (name === void 0) {
      throw new Error(
        `Missing type name for ${typeBuilder.constructor.name ?? "TypeBuilder"} ${JSON.stringify(typeBuilder)}`
      );
    }
    let r = this.#compoundTypes.get(ty);
    if (r != null) {
      return r;
    }
    const newTy = typeBuilder instanceof RowBuilder || typeBuilder instanceof ProductBuilder ? {
      tag: "Product",
      value: { elements: [] }
    } : {
      tag: "Sum",
      value: { variants: [] }
    };
    r = new RefBuilder(this.#moduleDef.typespace.types.length);
    this.#moduleDef.typespace.types.push(newTy);
    this.#compoundTypes.set(ty, r);
    if (typeBuilder instanceof RowBuilder) {
      for (const [name2, elem] of Object.entries(typeBuilder.row)) {
        newTy.value.elements.push({
          name: name2,
          algebraicType: this.registerTypesRecursively(elem.typeBuilder).algebraicType
        });
      }
    } else if (typeBuilder instanceof ProductBuilder) {
      for (const [name2, elem] of Object.entries(typeBuilder.elements)) {
        newTy.value.elements.push({
          name: name2,
          algebraicType: this.registerTypesRecursively(elem).algebraicType
        });
      }
    } else if (typeBuilder instanceof SumBuilder) {
      for (const [name2, variant] of Object.entries(typeBuilder.variants)) {
        newTy.value.variants.push({
          name: name2,
          algebraicType: this.registerTypesRecursively(variant).algebraicType
        });
      }
    }
    this.#moduleDef.types.push({
      sourceName: splitName(name),
      ty: r.ref,
      customOrdering: true
    });
    return r;
  }
};
function isUnit(typeBuilder) {
  return typeBuilder.typeName == null && typeBuilder.algebraicType.value.elements.length === 0;
}
function splitName(name) {
  const scope = name.split(".");
  return { sourceName: scope.pop(), scope };
}
var Tables = class {
  constructor(schemaType) {
    this.schemaType = schemaType;
  }
};
function schema(tables2) {
  const ctx = new ModuleContext();
  return new Tables(tablesToSchema(ctx, tables2));
}
function convertToAccessorMap(arr) {
  return Object.fromEntries(
    arr.map((v) => [v.accessorName, v])
  );
}
var AlgebraicType2 = t.enum("AlgebraicType", {
  Ref: t.u32(),
  get Sum() {
    return SumType2;
  },
  get Product() {
    return ProductType2;
  },
  get Array() {
    return AlgebraicType2;
  },
  String: t.unit(),
  Bool: t.unit(),
  I8: t.unit(),
  U8: t.unit(),
  I16: t.unit(),
  U16: t.unit(),
  I32: t.unit(),
  U32: t.unit(),
  I64: t.unit(),
  U64: t.unit(),
  I128: t.unit(),
  U128: t.unit(),
  I256: t.unit(),
  U256: t.unit(),
  F32: t.unit(),
  F64: t.unit()
});
var CaseConversionPolicy = t.enum("CaseConversionPolicy", {
  None: t.unit(),
  SnakeCase: t.unit()
});
var ExplicitNameEntry = t.enum("ExplicitNameEntry", {
  get Table() {
    return NameMapping;
  },
  get Function() {
    return NameMapping;
  },
  get Index() {
    return NameMapping;
  }
});
var ExplicitNames = t.object("ExplicitNames", {
  get entries() {
    return t.array(ExplicitNameEntry);
  }
});
var FunctionVisibility = t.enum("FunctionVisibility", {
  Private: t.unit(),
  ClientCallable: t.unit()
});
var HttpHeaderPair = t.object("HttpHeaderPair", {
  name: t.string(),
  value: t.byteArray()
});
var HttpHeaders = t.object("HttpHeaders", {
  get entries() {
    return t.array(HttpHeaderPair);
  }
});
var HttpMethod = t.enum("HttpMethod", {
  Get: t.unit(),
  Head: t.unit(),
  Post: t.unit(),
  Put: t.unit(),
  Delete: t.unit(),
  Connect: t.unit(),
  Options: t.unit(),
  Trace: t.unit(),
  Patch: t.unit(),
  Extension: t.string()
});
t.object("HttpRequest", {
  get method() {
    return HttpMethod;
  },
  get headers() {
    return HttpHeaders;
  },
  timeout: t.option(t.timeDuration()),
  uri: t.string(),
  get version() {
    return HttpVersion;
  }
});
t.object("HttpResponse", {
  get headers() {
    return HttpHeaders;
  },
  get version() {
    return HttpVersion;
  },
  code: t.u16()
});
var HttpVersion = t.enum("HttpVersion", {
  Http09: t.unit(),
  Http10: t.unit(),
  Http11: t.unit(),
  Http2: t.unit(),
  Http3: t.unit()
});
var IndexType = t.enum("IndexType", {
  BTree: t.unit(),
  Hash: t.unit()
});
var Lifecycle = t.enum("Lifecycle", {
  Init: t.unit(),
  OnConnect: t.unit(),
  OnDisconnect: t.unit()
});
var MethodOrAny = t.enum("MethodOrAny", {
  Any: t.unit(),
  get Method() {
    return HttpMethod;
  }
});
var MiscModuleExport = t.enum("MiscModuleExport", {
  get TypeAlias() {
    return TypeAlias;
  }
});
var NameMapping = t.object("NameMapping", {
  sourceName: t.string(),
  canonicalName: t.string()
});
var ProductType2 = t.object("ProductType", {
  get elements() {
    return t.array(ProductTypeElement);
  }
});
var ProductTypeElement = t.object("ProductTypeElement", {
  name: t.option(t.string()),
  get algebraicType() {
    return AlgebraicType2;
  }
});
var RawColumnDefV8 = t.object("RawColumnDefV8", {
  colName: t.string(),
  get colType() {
    return AlgebraicType2;
  }
});
var RawColumnDefaultValueV10 = t.object("RawColumnDefaultValueV10", {
  colId: t.u16(),
  value: t.byteArray()
});
var RawColumnDefaultValueV9 = t.object("RawColumnDefaultValueV9", {
  table: t.string(),
  colId: t.u16(),
  value: t.byteArray()
});
var RawConstraintDataV9 = t.enum("RawConstraintDataV9", {
  get Unique() {
    return RawUniqueConstraintDataV9;
  }
});
var RawConstraintDefV10 = t.object("RawConstraintDefV10", {
  sourceName: t.option(t.string()),
  get data() {
    return RawConstraintDataV9;
  }
});
var RawConstraintDefV8 = t.object("RawConstraintDefV8", {
  constraintName: t.string(),
  constraints: t.u8(),
  columns: t.array(t.u16())
});
var RawConstraintDefV9 = t.object("RawConstraintDefV9", {
  name: t.option(t.string()),
  get data() {
    return RawConstraintDataV9;
  }
});
var RawHttpHandlerDefV10 = t.object("RawHttpHandlerDefV10", {
  sourceName: t.string()
});
var RawHttpRouteDefV10 = t.object("RawHttpRouteDefV10", {
  handlerFunction: t.string(),
  get method() {
    return MethodOrAny;
  },
  path: t.string()
});
var RawIndexAlgorithm = t.enum("RawIndexAlgorithm", {
  BTree: t.array(t.u16()),
  Hash: t.array(t.u16()),
  Direct: t.u16()
});
var RawIndexDefV10 = t.object("RawIndexDefV10", {
  sourceName: t.option(t.string()),
  accessorName: t.option(t.string()),
  get algorithm() {
    return RawIndexAlgorithm;
  }
});
var RawIndexDefV8 = t.object("RawIndexDefV8", {
  indexName: t.string(),
  isUnique: t.bool(),
  get indexType() {
    return IndexType;
  },
  columns: t.array(t.u16())
});
var RawIndexDefV9 = t.object("RawIndexDefV9", {
  name: t.option(t.string()),
  accessorName: t.option(t.string()),
  get algorithm() {
    return RawIndexAlgorithm;
  }
});
var RawLifeCycleReducerDefV10 = t.object(
  "RawLifeCycleReducerDefV10",
  {
    get lifecycleSpec() {
      return Lifecycle;
    },
    functionName: t.string()
  }
);
var RawMiscModuleExportV9 = t.enum("RawMiscModuleExportV9", {
  get ColumnDefaultValue() {
    return RawColumnDefaultValueV9;
  },
  get Procedure() {
    return RawProcedureDefV9;
  },
  get View() {
    return RawViewDefV9;
  }
});
t.enum("RawModuleDef", {
  get V8BackCompat() {
    return RawModuleDefV8;
  },
  get V9() {
    return RawModuleDefV9;
  },
  get V10() {
    return RawModuleDefV10;
  }
});
var RawModuleDefV10 = t.object("RawModuleDefV10", {
  get sections() {
    return t.array(RawModuleDefV10Section);
  }
});
var RawModuleDefV10Section = t.enum("RawModuleDefV10Section", {
  get Typespace() {
    return Typespace;
  },
  get Types() {
    return t.array(RawTypeDefV10);
  },
  get Tables() {
    return t.array(RawTableDefV10);
  },
  get Reducers() {
    return t.array(RawReducerDefV10);
  },
  get Procedures() {
    return t.array(RawProcedureDefV10);
  },
  get Views() {
    return t.array(RawViewDefV10);
  },
  get Schedules() {
    return t.array(RawScheduleDefV10);
  },
  get LifeCycleReducers() {
    return t.array(RawLifeCycleReducerDefV10);
  },
  get RowLevelSecurity() {
    return t.array(RawRowLevelSecurityDefV9);
  },
  get CaseConversionPolicy() {
    return CaseConversionPolicy;
  },
  get ExplicitNames() {
    return ExplicitNames;
  },
  get HttpHandlers() {
    return t.array(RawHttpHandlerDefV10);
  },
  get HttpRoutes() {
    return t.array(RawHttpRouteDefV10);
  },
  get ViewPrimaryKeys() {
    return t.array(RawViewPrimaryKeyDefV10);
  },
  get Submodules() {
    return t.array(RawSubmoduleV10);
  }
});
var RawModuleDefV8 = t.object("RawModuleDefV8", {
  get typespace() {
    return Typespace;
  },
  get tables() {
    return t.array(TableDesc);
  },
  get reducers() {
    return t.array(ReducerDef);
  },
  get miscExports() {
    return t.array(MiscModuleExport);
  }
});
var RawModuleDefV9 = t.object("RawModuleDefV9", {
  get typespace() {
    return Typespace;
  },
  get tables() {
    return t.array(RawTableDefV9);
  },
  get reducers() {
    return t.array(RawReducerDefV9);
  },
  get types() {
    return t.array(RawTypeDefV9);
  },
  get miscExports() {
    return t.array(RawMiscModuleExportV9);
  },
  get rowLevelSecurity() {
    return t.array(RawRowLevelSecurityDefV9);
  }
});
var RawProcedureDefV10 = t.object("RawProcedureDefV10", {
  sourceName: t.string(),
  get params() {
    return ProductType2;
  },
  get returnType() {
    return AlgebraicType2;
  },
  get visibility() {
    return FunctionVisibility;
  }
});
var RawProcedureDefV9 = t.object("RawProcedureDefV9", {
  name: t.string(),
  get params() {
    return ProductType2;
  },
  get returnType() {
    return AlgebraicType2;
  }
});
var RawReducerDefV10 = t.object("RawReducerDefV10", {
  sourceName: t.string(),
  get params() {
    return ProductType2;
  },
  get visibility() {
    return FunctionVisibility;
  },
  get okReturnType() {
    return AlgebraicType2;
  },
  get errReturnType() {
    return AlgebraicType2;
  }
});
var RawReducerDefV9 = t.object("RawReducerDefV9", {
  name: t.string(),
  get params() {
    return ProductType2;
  },
  get lifecycle() {
    return t.option(Lifecycle);
  }
});
var RawRowLevelSecurityDefV9 = t.object("RawRowLevelSecurityDefV9", {
  sql: t.string()
});
var RawScheduleDefV10 = t.object("RawScheduleDefV10", {
  sourceName: t.option(t.string()),
  tableName: t.string(),
  scheduleAtCol: t.u16(),
  functionName: t.string()
});
var RawScheduleDefV9 = t.object("RawScheduleDefV9", {
  name: t.option(t.string()),
  reducerName: t.string(),
  scheduledAtColumn: t.u16()
});
var RawScopedTypeNameV10 = t.object("RawScopedTypeNameV10", {
  scope: t.array(t.string()),
  sourceName: t.string()
});
var RawScopedTypeNameV9 = t.object("RawScopedTypeNameV9", {
  scope: t.array(t.string()),
  name: t.string()
});
var RawSequenceDefV10 = t.object("RawSequenceDefV10", {
  sourceName: t.option(t.string()),
  column: t.u16(),
  start: t.option(t.i128()),
  minValue: t.option(t.i128()),
  maxValue: t.option(t.i128()),
  increment: t.i128()
});
var RawSequenceDefV8 = t.object("RawSequenceDefV8", {
  sequenceName: t.string(),
  colPos: t.u16(),
  increment: t.i128(),
  start: t.option(t.i128()),
  minValue: t.option(t.i128()),
  maxValue: t.option(t.i128()),
  allocated: t.i128()
});
var RawSequenceDefV9 = t.object("RawSequenceDefV9", {
  name: t.option(t.string()),
  column: t.u16(),
  start: t.option(t.i128()),
  minValue: t.option(t.i128()),
  maxValue: t.option(t.i128()),
  increment: t.i128()
});
var RawSubmoduleV10 = t.object("RawSubmoduleV10", {
  namespace: t.string(),
  get module() {
    return RawModuleDefV10;
  }
});
var RawTableDefV10 = t.object("RawTableDefV10", {
  sourceName: t.string(),
  productTypeRef: t.u32(),
  primaryKey: t.array(t.u16()),
  get indexes() {
    return t.array(RawIndexDefV10);
  },
  get constraints() {
    return t.array(RawConstraintDefV10);
  },
  get sequences() {
    return t.array(RawSequenceDefV10);
  },
  get tableType() {
    return TableType;
  },
  get tableAccess() {
    return TableAccess;
  },
  get defaultValues() {
    return t.array(RawColumnDefaultValueV10);
  },
  isEvent: t.bool()
});
var RawTableDefV8 = t.object("RawTableDefV8", {
  tableName: t.string(),
  get columns() {
    return t.array(RawColumnDefV8);
  },
  get indexes() {
    return t.array(RawIndexDefV8);
  },
  get constraints() {
    return t.array(RawConstraintDefV8);
  },
  get sequences() {
    return t.array(RawSequenceDefV8);
  },
  tableType: t.string(),
  tableAccess: t.string(),
  scheduled: t.option(t.string())
});
var RawTableDefV9 = t.object("RawTableDefV9", {
  name: t.string(),
  productTypeRef: t.u32(),
  primaryKey: t.array(t.u16()),
  get indexes() {
    return t.array(RawIndexDefV9);
  },
  get constraints() {
    return t.array(RawConstraintDefV9);
  },
  get sequences() {
    return t.array(RawSequenceDefV9);
  },
  get schedule() {
    return t.option(RawScheduleDefV9);
  },
  get tableType() {
    return TableType;
  },
  get tableAccess() {
    return TableAccess;
  }
});
var RawTypeDefV10 = t.object("RawTypeDefV10", {
  get sourceName() {
    return RawScopedTypeNameV10;
  },
  ty: t.u32(),
  customOrdering: t.bool()
});
var RawTypeDefV9 = t.object("RawTypeDefV9", {
  get name() {
    return RawScopedTypeNameV9;
  },
  ty: t.u32(),
  customOrdering: t.bool()
});
var RawUniqueConstraintDataV9 = t.object(
  "RawUniqueConstraintDataV9",
  {
    columns: t.array(t.u16())
  }
);
var RawViewDefV10 = t.object("RawViewDefV10", {
  sourceName: t.string(),
  index: t.u32(),
  isPublic: t.bool(),
  isAnonymous: t.bool(),
  get params() {
    return ProductType2;
  },
  get returnType() {
    return AlgebraicType2;
  }
});
var RawViewDefV9 = t.object("RawViewDefV9", {
  name: t.string(),
  index: t.u32(),
  isPublic: t.bool(),
  isAnonymous: t.bool(),
  get params() {
    return ProductType2;
  },
  get returnType() {
    return AlgebraicType2;
  }
});
var RawViewPrimaryKeyDefV10 = t.object("RawViewPrimaryKeyDefV10", {
  viewSourceName: t.string(),
  columns: t.array(t.string())
});
var ReducerDef = t.object("ReducerDef", {
  name: t.string(),
  get args() {
    return t.array(ProductTypeElement);
  }
});
var SumType2 = t.object("SumType", {
  get variants() {
    return t.array(SumTypeVariant);
  }
});
var SumTypeVariant = t.object("SumTypeVariant", {
  name: t.option(t.string()),
  get algebraicType() {
    return AlgebraicType2;
  }
});
var TableAccess = t.enum("TableAccess", {
  Public: t.unit(),
  Private: t.unit()
});
var TableDesc = t.object("TableDesc", {
  get schema() {
    return RawTableDefV8;
  },
  data: t.u32()
});
var TableType = t.enum("TableType", {
  System: t.unit(),
  User: t.unit()
});
var TypeAlias = t.object("TypeAlias", {
  name: t.string(),
  ty: t.u32()
});
var Typespace = t.object("Typespace", {
  get types() {
    return t.array(AlgebraicType2);
  }
});
t.enum("ViewResultHeader", {
  RowData: t.unit(),
  RawSql: t.string()
});
function table(opts, row, ..._) {
  const {
    name,
    public: isPublic = false,
    indexes: userIndexes = [],
    scheduled,
    event: isEvent = false
  } = opts;
  const colIds = /* @__PURE__ */ new Map();
  const colNameList = [];
  if (!(row instanceof RowBuilder)) {
    row = new RowBuilder(row);
  }
  row.algebraicType.value.elements.forEach((elem, i) => {
    colIds.set(elem.name, i);
    colNameList.push(elem.name);
  });
  const pk = [];
  const indexes = [];
  const constraints = [];
  const sequences = [];
  let scheduleAtCol;
  const defaultValues = [];
  for (const [name2, builder] of Object.entries(row.row)) {
    const meta = builder.columnMetadata;
    if (meta.isPrimaryKey) {
      pk.push(colIds.get(name2));
    }
    const isUnique = meta.isUnique || meta.isPrimaryKey;
    if (meta.indexType || isUnique) {
      const algo = meta.indexType ?? "btree";
      const id = colIds.get(name2);
      let algorithm;
      switch (algo) {
        case "btree":
          algorithm = RawIndexAlgorithm.BTree([id]);
          break;
        case "hash":
          algorithm = RawIndexAlgorithm.Hash([id]);
          break;
        case "direct":
          algorithm = RawIndexAlgorithm.Direct(id);
          break;
      }
      indexes.push({
        sourceName: void 0,
        // Unnamed indexes will be assigned a globally unique name
        accessorName: name2,
        algorithm
      });
    }
    if (isUnique) {
      constraints.push({
        sourceName: void 0,
        data: { tag: "Unique", value: { columns: [colIds.get(name2)] } }
      });
    }
    if (meta.isAutoIncrement) {
      sequences.push({
        sourceName: void 0,
        start: void 0,
        minValue: void 0,
        maxValue: void 0,
        column: colIds.get(name2),
        increment: 1n
      });
    }
    if (Object.prototype.hasOwnProperty.call(meta, "defaultValue")) {
      const writer = new BinaryWriter(16);
      builder.serialize(writer, meta.defaultValue);
      defaultValues.push({
        colId: colIds.get(name2),
        value: writer.getBuffer()
      });
    }
    const algebraicType = builder.typeBuilder.algebraicType;
    if (schedule_at_default.isScheduleAt(algebraicType)) {
      scheduleAtCol = colIds.get(name2);
    }
  }
  for (const indexOpts of userIndexes ?? []) {
    const accessor = indexOpts.accessor;
    if (typeof accessor !== "string" || accessor.length === 0) {
      const tableLabel = name ?? "<unnamed>";
      const indexLabel = indexOpts.name ?? "<unnamed>";
      throw new TypeError(
        `Index '${indexLabel}' on table '${tableLabel}' must define a non-empty 'accessor'`
      );
    }
    let algorithm;
    switch (indexOpts.algorithm) {
      case "btree":
        algorithm = {
          tag: "BTree",
          value: indexOpts.columns.map((c) => colIds.get(c))
        };
        break;
      case "hash":
        algorithm = {
          tag: "Hash",
          value: indexOpts.columns.map((c) => colIds.get(c))
        };
        break;
      case "direct":
        algorithm = { tag: "Direct", value: colIds.get(indexOpts.column) };
        break;
    }
    indexes.push({
      sourceName: void 0,
      accessorName: accessor,
      algorithm,
      canonicalName: indexOpts.name
    });
  }
  for (const constraintOpts of opts.constraints ?? []) {
    if (constraintOpts.constraint === "unique") {
      const data = {
        tag: "Unique",
        value: { columns: constraintOpts.columns.map((c) => colIds.get(c)) }
      };
      constraints.push({ sourceName: constraintOpts.name, data });
      continue;
    }
  }
  const productType = row.algebraicType.value;
  const schedule = scheduled && scheduleAtCol !== void 0 ? { scheduleAtCol, reducer: scheduled } : void 0;
  return {
    rowType: row,
    tableName: name,
    rowSpacetimeType: productType,
    tableDef: (ctx, accName) => {
      const tableName = name ?? accName;
      if (row.typeName === void 0) {
        row.typeName = toPascalCase(tableName);
      }
      for (const index of indexes) {
        const cols = index.algorithm.tag === "Direct" ? [index.algorithm.value] : index.algorithm.value;
        const colS = cols.map((i) => colNameList[i]).join("_");
        const sourceName = index.sourceName = `${accName}_${colS}_idx_${index.algorithm.tag.toLowerCase()}`;
        const { canonicalName } = index;
        if (canonicalName !== void 0) {
          ctx.moduleDef.explicitNames.entries.push(
            ExplicitNameEntry.Index({ sourceName, canonicalName })
          );
        }
      }
      return {
        sourceName: accName,
        productTypeRef: ctx.registerTypesRecursively(row).ref,
        primaryKey: pk,
        indexes,
        constraints,
        sequences,
        tableType: { tag: "User" },
        tableAccess: { tag: isPublic ? "Public" : "Private" },
        defaultValues,
        isEvent
      };
    },
    // Preserve the declared index options as runtime data so `tableToSchema`
    // can expose them without type-smuggling.
    idxs: userIndexes,
    constraints,
    scheduleAtCol,
    schedule
  };
}
var Reducers = class {
  reducersType;
  constructor(handles) {
    this.reducersType = reducersToSchema(handles);
  }
};
function reducersToSchema(reducers22) {
  const mapped = reducers22.map((r) => {
    const paramsRow = r.params.row;
    return {
      name: r.reducerName,
      // Prefer the schema's own accessorName if present at runtime; otherwise derive it.
      accessorName: r.accessorName,
      params: paramsRow,
      paramsType: r.paramsSpacetimeType
    };
  });
  const result = { reducers: mapped };
  return result;
}
function reducers(...args) {
  const handles = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
  return new Reducers(handles);
}
function reducerSchema(name, params) {
  const paramType = {
    elements: Object.entries(params).map(([n, c]) => ({
      name: n,
      algebraicType: "typeBuilder" in c ? c.typeBuilder.algebraicType : c.algebraicType
    }))
  };
  return {
    reducerName: name,
    accessorName: toCamelCase(name),
    params: new RowBuilder(params),
    paramsSpacetimeType: paramType,
    reducerDef: {
      name,
      params: paramType,
      lifecycle: void 0
    }
  };
}
function procedures(...args) {
  const procedures22 = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
  return { procedures: procedures22 };
}

// static/netplay/bindings/close_session_reducer.ts
var close_session_reducer_default = {};

// static/netplay/bindings/leave_session_reducer.ts
var leave_session_reducer_default = {};

// static/netplay/bindings/open_session_reducer.ts
var open_session_reducer_default = {
  gameId: t.string(),
  title: t.string(),
  players: t.u32(),
  joinable: t.bool()
};

// static/netplay/bindings/publish_snapshot_reducer.ts
var publish_snapshot_reducer_default = {
  seq: t.u32(),
  blob: t.string()
};

// static/netplay/bindings/request_join_reducer.ts
var request_join_reducer_default = {
  host: t.identity()
};

// static/netplay/bindings/send_input_reducer.ts
var send_input_reducer_default = {
  seq: t.u32(),
  bits: t.u32()
};

// static/netplay/bindings/update_session_reducer.ts
var update_session_reducer_default = {
  stage: t.u32(),
  score: t.u64(),
  players: t.u32(),
  joinable: t.bool()
};

// static/netplay/bindings/input_table.ts
var input_table_default = t.row({
  guest: t.identity().primaryKey(),
  host: t.identity(),
  seq: t.u32(),
  bits: t.u32(),
  at: t.timestamp()
});

// static/netplay/bindings/session_table.ts
var session_table_default = t.row({
  host: t.identity().primaryKey(),
  gameId: t.string().name("game_id"),
  title: t.string(),
  stage: t.u32(),
  score: t.u64(),
  players: t.u32(),
  joinable: t.bool(),
  guest: t.option(t.identity()),
  startedAt: t.timestamp().name("started_at"),
  updatedAt: t.timestamp().name("updated_at")
});

// static/netplay/bindings/snapshot_table.ts
var snapshot_table_default = t.row({
  host: t.identity().primaryKey(),
  seq: t.u32(),
  at: t.timestamp(),
  blob: t.string()
});

// static/netplay/bindings/index.ts
var tablesSchema = schema({
  input: table({
    name: "input",
    indexes: [
      { accessor: "guest", name: "input_guest_idx_btree", algorithm: "btree", columns: [
        "guest"
      ] },
      { accessor: "by_host", name: "input_host_idx_btree", algorithm: "btree", columns: [
        "host"
      ] }
    ],
    constraints: [
      { name: "input_guest_key", constraint: "unique", columns: ["guest"] }
    ]
  }, input_table_default),
  session: table({
    name: "session",
    indexes: [
      { accessor: "by_game", name: "session_game_id_idx_btree", algorithm: "btree", columns: [
        "gameId"
      ] },
      { accessor: "host", name: "session_host_idx_btree", algorithm: "btree", columns: [
        "host"
      ] }
    ],
    constraints: [
      { name: "session_host_key", constraint: "unique", columns: ["host"] }
    ]
  }, session_table_default),
  snapshot: table({
    name: "snapshot",
    indexes: [
      { accessor: "host", name: "snapshot_host_idx_btree", algorithm: "btree", columns: [
        "host"
      ] }
    ],
    constraints: [
      { name: "snapshot_host_key", constraint: "unique", columns: ["host"] }
    ]
  }, snapshot_table_default)
});
var reducersSchema = reducers(
  reducerSchema("close_session", close_session_reducer_default),
  reducerSchema("leave_session", leave_session_reducer_default),
  reducerSchema("open_session", open_session_reducer_default),
  reducerSchema("publish_snapshot", publish_snapshot_reducer_default),
  reducerSchema("request_join", request_join_reducer_default),
  reducerSchema("send_input", send_input_reducer_default),
  reducerSchema("update_session", update_session_reducer_default)
);
var proceduresSchema = procedures();
var REMOTE_MODULE = {
  versionInfo: {
    cliVersion: "2.8.3"
  },
  tables: tablesSchema.schemaType.tables,
  reducers: reducersSchema.reducersType.reducers,
  ...proceduresSchema
};
var tables = makeQueryBuilder(tablesSchema.schemaType);
var reducers2 = convertToAccessorMap(reducersSchema.reducersType.reducers);
var procedures2 = convertToAccessorMap(proceduresSchema.procedures);
var SubscriptionBuilder = class extends SubscriptionBuilderImpl {
};
var DbConnectionBuilder2 = class extends DbConnectionBuilder {
};
var DbConnection = class _DbConnection extends DbConnectionImpl {
  /** Creates a new {@link DbConnectionBuilder} to configure and connect to the remote SpacetimeDB instance. */
  static builder = () => {
    return new DbConnectionBuilder2(REMOTE_MODULE, (config) => new _DbConnection(config));
  };
  /** Creates a new {@link SubscriptionBuilder} to configure a subscription to the remote SpacetimeDB instance. */
  subscriptionBuilder = () => {
    return new SubscriptionBuilder(this);
  };
};

// static/netplay/src/snapshot.ts
var SNAPSHOT_MAGIC = 83;
var SNAPSHOT_VERSION = 1;
var MAX_PLAYERS = 2;
var MAX_ENEMIES = 64;
var MAX_BULLETS = 96;
var MAX_ENEMY_BULLETS = 128;
var FLAG_STARTED = 1 << 0;
var FLAG_BOSS = 1 << 1;
var FLAG_CLEARED = 1 << 2;
var FLAG_FROZEN = 1 << 3;
var B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function toBase64(bytes) {
  let out = "";
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < bytes.length; i++) {
    acc = acc << 8 | bytes[i];
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      out += B64[acc >> bits & 63];
    }
  }
  if (bits) out += B64[acc << 6 - bits & 63];
  while (out.length % 4) out += "=";
  return out;
}
function fromBase64(s) {
  const clean = s.replace(/=+$/, "");
  const out = new Uint8Array(clean.length * 3 >> 2);
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < clean.length; i++) {
    acc = acc << 6 | B64.indexOf(clean[i]);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = acc >> bits & 255;
    }
  }
  return out;
}
var clampByte = (v) => v < 0 ? 0 : v > 255 ? 255 : v | 0;
function encodeSnapshot(s) {
  const ships = s.ships.slice(0, MAX_PLAYERS);
  const enemies = s.enemies.slice(0, MAX_ENEMIES);
  const bullets = s.bullets.slice(0, MAX_BULLETS);
  const eb = s.enemyBullets.slice(0, MAX_ENEMY_BULLETS);
  const bytes = new Uint8Array(
    12 + ships.length * 6 + enemies.length * 3 + bullets.length * 2 + eb.length * 2
  );
  const dv = new DataView(bytes.buffer);
  bytes[0] = SNAPSHOT_MAGIC;
  bytes[1] = SNAPSHOT_VERSION;
  bytes[2] = s.flags & 255;
  bytes[3] = s.stage & 255;
  dv.setUint32(4, Math.min(4294967295, Math.max(0, Math.floor(s.score))), true);
  bytes[8] = ships.length;
  bytes[9] = enemies.length;
  bytes[10] = bullets.length;
  bytes[11] = eb.length;
  let p = 12;
  for (const sh of ships) {
    dv.setUint16(p, Math.max(0, Math.min(65535, Math.round(sh.x * 8))), true);
    dv.setUint16(p + 2, Math.max(0, Math.min(65535, Math.round(sh.y * 8))), true);
    bytes[p + 4] = clampByte(sh.hp);
    bytes[p + 5] = clampByte(sh.maxHp) & 127 | (sh.dead ? 128 : 0);
    p += 6;
  }
  for (const e of enemies) {
    bytes[p] = clampByte(e.x);
    bytes[p + 1] = clampByte(e.y >> 1);
    bytes[p + 2] = clampByte(e.kind);
    p += 3;
  }
  for (const b of bullets) {
    bytes[p] = clampByte(b.x);
    bytes[p + 1] = clampByte(b.y >> 1);
    p += 2;
  }
  for (const b of eb) {
    bytes[p] = clampByte(b.x);
    bytes[p + 1] = clampByte(b.y >> 1);
    p += 2;
  }
  return toBase64(bytes);
}
function decodeSnapshot(blob) {
  if (!blob) return null;
  let bytes;
  try {
    bytes = fromBase64(blob);
  } catch {
    return null;
  }
  if (bytes.length < 12) return null;
  if (bytes[0] !== SNAPSHOT_MAGIC || bytes[1] !== SNAPSHOT_VERSION) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const nShips = bytes[8];
  const nEnemies = bytes[9];
  const nBullets = bytes[10];
  const nEb = bytes[11];
  const need = 12 + nShips * 6 + nEnemies * 3 + nBullets * 2 + nEb * 2;
  if (bytes.length < need) return null;
  let p = 12;
  const ships = [];
  for (let i = 0; i < nShips; i++) {
    ships.push({
      x: dv.getUint16(p, true) / 8,
      y: dv.getUint16(p + 2, true) / 8,
      hp: bytes[p + 4],
      maxHp: bytes[p + 5] & 127,
      dead: (bytes[p + 5] & 128) !== 0
    });
    p += 6;
  }
  const enemies = [];
  for (let i = 0; i < nEnemies; i++) {
    enemies.push({ x: bytes[p], y: bytes[p + 1] << 1, kind: bytes[p + 2] });
    p += 3;
  }
  const bullets = [];
  for (let i = 0; i < nBullets; i++) {
    bullets.push({ x: bytes[p], y: bytes[p + 1] << 1 });
    p += 2;
  }
  const enemyBullets = [];
  for (let i = 0; i < nEb; i++) {
    enemyBullets.push({ x: bytes[p], y: bytes[p + 1] << 1 });
    p += 2;
  }
  return {
    flags: bytes[2],
    stage: bytes[3],
    score: dv.getUint32(4, true),
    ships,
    enemies,
    bullets,
    enemyBullets
  };
}
var IN_LEFT = 1 << 0;
var IN_RIGHT = 1 << 1;
var IN_UP = 1 << 2;
var IN_DOWN = 1 << 3;
var IN_FIRE = 1 << 4;
var IN_CHARGE = 1 << 5;
function packInput(i) {
  return (i.left ? IN_LEFT : 0) | (i.right ? IN_RIGHT : 0) | (i.up ? IN_UP : 0) | (i.down ? IN_DOWN : 0) | (i.fire ? IN_FIRE : 0) | (i.charge ? IN_CHARGE : 0);
}
function unpackInput(bits) {
  return {
    left: (bits & IN_LEFT) !== 0,
    right: (bits & IN_RIGHT) !== 0,
    up: (bits & IN_UP) !== 0,
    down: (bits & IN_DOWN) !== 0,
    fire: (bits & IN_FIRE) !== 0,
    charge: (bits & IN_CHARGE) !== 0
  };
}

// static/netplay/src/client.ts
var DEFAULT_URI = "wss://maincloud.spacetimedb.com";
var DEFAULT_MODULE = "shmupx-netplay";
function reason(err) {
  if (!err) return "unknown error";
  const msg = err.message ?? String(err);
  return msg.replace(/^Error:\s*/, "");
}
function emit(set2, value) {
  for (const fn of [...set2]) {
    try {
      fn(value);
    } catch (err) {
      console.warn("[netplay] listener threw", err);
    }
  }
}
var Netplay = class {
  conn = null;
  identity = null;
  sessionListeners = /* @__PURE__ */ new Set();
  snapshotListeners = /* @__PURE__ */ new Map();
  inputListeners = /* @__PURE__ */ new Set();
  seatListeners = /* @__PURE__ */ new Set();
  gameId;
  status = "offline";
  onStatus;
  hosting = false;
  seatedOn = null;
  inputSeq = 0;
  snapshotSeq = 0;
  lastSentBits = -1;
  lastOpen = null;
  reopening = false;
  get online() {
    return this.status === "online";
  }
  get identityHex() {
    return this.identity ? this.identity.toHexString() : null;
  }
  get isHosting() {
    return this.hosting;
  }
  get joinedHost() {
    return this.seatedOn;
  }
  connect(opts = {}) {
    this.gameId = opts.gameId;
    this.onStatus = opts.onStatus;
    this.setStatus("connecting");
    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      try {
        DbConnection.builder().withUri(opts.uri ?? DEFAULT_URI).withDatabaseName(opts.moduleName ?? DEFAULT_MODULE).onConnect((conn, identity) => {
          this.conn = conn;
          this.identity = identity;
          this.setStatus("online");
          this.wire(conn);
          done();
        }).onConnectError((_ctx, err) => {
          this.setStatus("offline", String(err));
          done();
        }).onDisconnect(() => {
          this.conn = null;
          this.hosting = false;
          this.seatedOn = null;
          this.setStatus("offline");
          emit(this.sessionListeners, []);
          done();
        }).build();
      } catch (err) {
        this.setStatus("offline", String(err));
        done();
      }
    });
  }
  /**
   * Reducer calls are async and reject when the module refuses. Nothing here
   * is worth interrupting a game for — a dropped heartbeat or a lost input
   * frame is corrected by the next one — so failures are logged and swallowed
   * rather than left to surface as unhandled rejections.
   */
  fire(label, p) {
    if (!p || typeof p.then !== "function") return;
    p.catch((err) => {
      const why = reason(err);
      if (this.hosting && why.includes("no session for this identity")) {
        this.reopen();
        return;
      }
      if (label !== "sendInput" && label !== "publishSnapshot") {
        console.warn(`[netplay] ${label} refused: ${why}`);
      }
    });
  }
  /** Re-announce a session the server no longer has. At most one in flight. */
  reopen() {
    if (!this.conn || !this.lastOpen || this.reopening) return;
    this.reopening = true;
    const o = this.lastOpen;
    this.fireRaw(
      this.conn.reducers.openSession({
        gameId: o.gameId,
        title: o.title,
        players: o.players,
        joinable: o.joinable
      })
    );
    setTimeout(() => {
      this.reopening = false;
    }, 1e3);
  }
  fireRaw(p) {
    if (p && typeof p.then === "function") p.catch(() => {
    });
  }
  setStatus(status, detail) {
    this.status = status;
    try {
      this.onStatus?.(status, detail);
    } catch {
    }
  }
  wire(conn) {
    conn.subscriptionBuilder().onError((_ctx, err) => console.warn("[netplay] subscription error", err)).subscribe(["SELECT * FROM session", "SELECT * FROM snapshot", "SELECT * FROM input"]);
    const push = () => this.pushSessions();
    conn.db.session.onInsert(push);
    conn.db.session.onUpdate((_ctx, old, row) => {
      push();
      if (!this.hosting || !this.identity || !row.host.isEqual(this.identity)) return;
      const before = old.guest ? old.guest.toHexString() : null;
      const after = row.guest ? row.guest.toHexString() : null;
      if (before === after) return;
      emit(this.seatListeners, { guestHex: after });
    });
    conn.db.session.onDelete(push);
    const onSnap = (_ctx, row) => {
      const hostHex = row.host.toHexString();
      const set2 = this.snapshotListeners.get(hostHex);
      if (!set2 || !set2.size) return;
      const decoded = decodeSnapshot(row.blob);
      if (decoded) emit(set2, decoded);
    };
    conn.db.snapshot.onInsert(onSnap);
    conn.db.snapshot.onUpdate((ctx, _o, row) => onSnap(ctx, row));
    const onInput = (_ctx, row) => {
      if (!this.hosting || !this.identity || !row.host.isEqual(this.identity)) return;
      emit(this.inputListeners, { seq: row.seq, bits: row.bits, input: unpackInput(row.bits) });
    };
    conn.db.input.onInsert(onInput);
    conn.db.input.onUpdate((ctx, _o, row) => onInput(ctx, row));
  }
  pushSessions() {
    if (!this.conn) return;
    const rows = [];
    for (const row of this.conn.db.session.iter()) {
      if (this.gameId && row.gameId !== this.gameId) continue;
      const hostHex = row.host.toHexString();
      rows.push({
        hostHex,
        gameId: row.gameId,
        title: row.title,
        stage: row.stage,
        score: Number(row.score),
        players: row.players,
        joinable: row.joinable,
        updatedAt: Number(row.updatedAt.microsSinceUnixEpoch / 1000n),
        mine: this.identityHex === hostHex
      });
    }
    rows.sort((a, b) => b.score - a.score);
    emit(this.sessionListeners, rows);
  }
  /** Live list of runs, filtered to this client's game when one was given. */
  onSessions(fn) {
    this.sessionListeners.add(fn);
    if (this.conn) this.pushSessions();
    return () => this.sessionListeners.delete(fn);
  }
  /** Frames from one host — the lobby preview and the guest's view alike. */
  watch(hostHex, fn) {
    let set2 = this.snapshotListeners.get(hostHex);
    if (!set2) {
      set2 = /* @__PURE__ */ new Set();
      this.snapshotListeners.set(hostHex, set2);
    }
    set2.add(fn);
    const cached = this.conn?.db.snapshot.iter();
    if (cached) {
      for (const row of cached) {
        if (row.host.toHexString() !== hostHex) continue;
        const decoded = decodeSnapshot(row.blob);
        if (decoded) {
          try {
            fn(decoded);
          } catch {
          }
        }
      }
    }
    return () => {
      const s = this.snapshotListeners.get(hostHex);
      if (!s) return;
      s.delete(fn);
      if (!s.size) this.snapshotListeners.delete(hostHex);
    };
  }
  // --- hosting ------------------------------------------------------------
  openSession(gameId, title, players, joinable) {
    if (!this.conn) return;
    this.hosting = true;
    this.snapshotSeq = 0;
    this.lastOpen = { gameId, title, players, joinable };
    this.fire("openSession", this.conn.reducers.openSession({ gameId, title, players, joinable }));
  }
  updateSession(stage, score, players, joinable) {
    if (!this.conn || !this.hosting) return;
    if (this.lastOpen) this.lastOpen = { ...this.lastOpen, players, joinable };
    this.fire(
      "updateSession",
      this.conn.reducers.updateSession({
        stage,
        score: BigInt(Math.max(0, Math.floor(score))),
        players,
        joinable
      })
    );
  }
  publishSnapshot(world) {
    if (!this.conn || !this.hosting) return;
    this.fire(
      "publishSnapshot",
      this.conn.reducers.publishSnapshot({
        seq: this.snapshotSeq++ >>> 0,
        blob: encodeSnapshot(world)
      })
    );
  }
  closeSession() {
    if (!this.conn || !this.hosting) return;
    this.hosting = false;
    this.lastOpen = null;
    this.fire("closeSession", this.conn.reducers.closeSession());
  }
  /** Fires when a guest takes or frees this host's second seat. */
  onSeat(fn) {
    this.seatListeners.add(fn);
    return () => this.seatListeners.delete(fn);
  }
  /** The guest's buttons, as they arrive. The host feeds these to player 2. */
  onGuestInput(fn) {
    this.inputListeners.add(fn);
    return () => this.inputListeners.delete(fn);
  }
  // --- guesting -----------------------------------------------------------
  /**
   * Take the second seat. Resolves with the module's own refusal reason when
   * it says no ("the second seat is taken", "that run has ended"), so the UI
   * can say something true rather than a generic failure.
   */
  async join(hostHex) {
    if (!this.conn) return { ok: false, error: "offline" };
    try {
      await this.conn.reducers.requestJoin({ host: Identity.fromString(hostHex) });
      this.seatedOn = hostHex;
      this.inputSeq = 0;
      this.lastSentBits = -1;
      return { ok: true };
    } catch (err) {
      return { ok: false, error: reason(err) };
    }
  }
  leave() {
    if (!this.conn || !this.seatedOn) return;
    this.seatedOn = null;
    this.fire("leaveSession", this.conn.reducers.leaveSession());
  }
  /**
   * Stream one frame of buttons. Unchanged input is not resent — the host
   * holds the last value, so a still stick costs nothing.
   */
  sendInput(input) {
    if (!this.conn || !this.seatedOn) return;
    const bits = packInput(input);
    if (bits === this.lastSentBits) return;
    this.lastSentBits = bits;
    this.fire("sendInput", this.conn.reducers.sendInput({ seq: ++this.inputSeq >>> 0, bits }));
  }
  disconnect() {
    if (!this.conn) return;
    this.closeSession();
    this.leave();
    try {
      this.conn.disconnect();
    } catch {
    }
    this.conn = null;
    this.setStatus("offline");
  }
};
var shared = null;
var sharedReady = null;
function netplay(opts = {}) {
  if (sharedReady) return sharedReady;
  shared = new Netplay();
  sharedReady = shared.connect(opts).then(() => shared);
  return sharedReady;
}
function currentNetplay() {
  return shared;
}
export {
  DEFAULT_MODULE,
  DEFAULT_URI,
  FLAG_BOSS,
  FLAG_CLEARED,
  FLAG_FROZEN,
  FLAG_STARTED,
  IN_CHARGE,
  IN_DOWN,
  IN_FIRE,
  IN_LEFT,
  IN_RIGHT,
  IN_UP,
  MAX_BULLETS,
  MAX_ENEMIES,
  MAX_ENEMY_BULLETS,
  MAX_PLAYERS,
  Netplay,
  SNAPSHOT_MAGIC,
  SNAPSHOT_VERSION,
  currentNetplay,
  decodeSnapshot,
  encodeSnapshot,
  netplay,
  packInput,
  unpackInput
};
