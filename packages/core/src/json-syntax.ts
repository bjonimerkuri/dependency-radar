export interface JsonSyntaxIssue {
  index: number;
  message: string;
}

class JsonSyntaxFailure extends Error {
  readonly index: number;

  constructor(index: number, message: string) {
    super(message);
    this.index = index;
  }
}

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const HEX_QUAD = /^[0-9A-Fa-f]{4}$/;
const LITERALS = ['true', 'false', 'null'] as const;

export function findJsonSyntaxError(text: string): JsonSyntaxIssue | undefined {
  let i = 0;

  function fail(index: number, message: string): never {
    throw new JsonSyntaxFailure(index, message);
  }

  function endOrMessage(message: string): string {
    return i >= text.length ? 'Unexpected end of input' : message;
  }

  function skipWhitespace(): void {
    while (i < text.length) {
      const code = text.charCodeAt(i);
      if (code === 32 || code === 9 || code === 10 || code === 13) i++;
      else break;
    }
  }

  function parseString(): void {
    const start = i;
    i++;
    for (;;) {
      if (i >= text.length) fail(start, 'Unterminated string');
      const code = text.charCodeAt(i);
      if (code === 34) {
        i++;
        return;
      }
      if (code < 32) fail(i, 'Control character inside a string');
      if (code === 92) {
        const escape = text.charAt(i + 1);
        if (escape === 'u') {
          if (!HEX_QUAD.test(text.slice(i + 2, i + 6))) fail(i, 'Invalid unicode escape');
          i += 6;
        } else if (escape !== '' && '"\\/bfnrt'.includes(escape)) {
          i += 2;
        } else {
          fail(i, 'Invalid escape sequence');
        }
      } else {
        i++;
      }
    }
  }

  function parseNumber(): void {
    NUMBER.lastIndex = i;
    if (!NUMBER.exec(text)) fail(i, 'Invalid number');
    i = NUMBER.lastIndex;
  }

  function parseObject(): void {
    i++;
    skipWhitespace();
    if (text.charAt(i) === '}') {
      i++;
      return;
    }
    for (;;) {
      skipWhitespace();
      if (text.charAt(i) !== '"') fail(i, endOrMessage('Expected a property name in double quotes'));
      parseString();
      skipWhitespace();
      if (text.charAt(i) !== ':') fail(i, endOrMessage("Expected ':' after the property name"));
      i++;
      parseValue();
      skipWhitespace();
      const next = text.charAt(i);
      if (next === ',') {
        i++;
        continue;
      }
      if (next === '}') {
        i++;
        return;
      }
      fail(i, endOrMessage("Expected ',' or '}'"));
    }
  }

  function parseArray(): void {
    i++;
    skipWhitespace();
    if (text.charAt(i) === ']') {
      i++;
      return;
    }
    for (;;) {
      parseValue();
      skipWhitespace();
      const next = text.charAt(i);
      if (next === ',') {
        i++;
        continue;
      }
      if (next === ']') {
        i++;
        return;
      }
      fail(i, endOrMessage("Expected ',' or ']'"));
    }
  }

  function parseValue(): void {
    skipWhitespace();
    if (i >= text.length) fail(i, 'Unexpected end of input');
    const char = text.charAt(i);
    if (char === '{') return parseObject();
    if (char === '[') return parseArray();
    if (char === '"') return parseString();
    if (char === '-' || (char >= '0' && char <= '9')) return parseNumber();
    for (const literal of LITERALS) {
      if (text.startsWith(literal, i)) {
        i += literal.length;
        return;
      }
    }
    fail(i, `Unexpected character ${JSON.stringify(char)}`);
  }

  try {
    parseValue();
    skipWhitespace();
    if (i < text.length) fail(i, 'Unexpected content after the JSON value');
    return undefined;
  } catch (error) {
    if (error instanceof JsonSyntaxFailure) return { index: error.index, message: error.message };
    throw error;
  }
}
