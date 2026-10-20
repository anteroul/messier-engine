// Minimal TypeScript -> JavaScript compiler for behaviour scripts. It only
// *erases* types (the same "erasable syntax" subset as `node --strip-types`):
// annotations, generics, `as`/`satisfies`/`!`, interfaces, type aliases,
// overloads, modifiers and `declare`. Erased code is replaced by spaces, so
// every surviving token keeps its line and column and runtime errors point at
// the right place in the source. Syntax that needs real codegen (enums,
// namespaces, parameter properties, decorators) is rejected with an error.

export type TokenKind = 'ident' | 'keyword' | 'number' | 'string' | 'template' | 'regex' | 'punct' | 'comment' | 'eof';

export interface Token {
  kind: TokenKind;
  value: string;
  start: number;
  end: number;
  /** A line break separates this token from the previous significant one. */
  nl: boolean;
}

export class TranspileError extends Error {
  constructor(
    message: string,
    readonly line: number,
    readonly column: number,
  ) {
    super(message);
    this.name = 'TranspileError';
  }
}

const KEYWORDS = new Set(
  ('break case catch class const continue debugger default delete do else export extends finally for function if import in instanceof ' +
    'new return super switch this throw try typeof var void while with yield let static await async of get set true false null undefined ' +
    'type interface enum declare abstract implements private protected public readonly namespace module keyof infer is as satisfies override unique asserts').split(' '),
);

// Words after which a `/` starts a regex rather than a division.
const REGEX_AFTER_WORD = new Set('return typeof instanceof in of new delete void throw case do else yield await'.split(' '));

const PUNCTUATORS = [
  '>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '&&=', '||=', '??=',
  '=>', '==', '!=', '<=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '&&', '||', '??', '?.', '++', '--', '<<', '**',
];

const isIdStart = (c: string) => /[A-Za-z_$\u00a0-\uffff]/.test(c);
const isIdPart = (c: string) => /[\w$\u00a0-\uffff]/.test(c);

/**
 * Splits source into tokens. `>` is always emitted on its own (so `>>` can close
 * two type argument lists), and template literals are split at `${` / `}` so the
 * expressions inside them are tokens too. With `tolerant`, unterminated strings
 * and comments become tokens instead of errors (used for syntax highlighting).
 */
export function tokenize(src: string, tolerant = false): Token[] {
  const out: Token[] = [];
  // Brace stack: true marks the `${` of a template, so its `}` resumes the template.
  const braces: boolean[] = [];
  let i = 0;
  let nl = false;
  let prev: Token | null = null;
  const fail = (msg: string, at: number) => {
    const { line, column } = lineColumn(src, at);
    throw new TranspileError(msg, line, column);
  };
  const push = (kind: TokenKind, start: number, end: number) => {
    const t: Token = { kind, value: src.slice(start, end), start, end, nl };
    out.push(t);
    if (kind !== 'comment') {
      prev = t;
      nl = false;
    }
  };
  const regexAllowed = () => {
    const p = prev as Token | null;
    if (!p) return true;
    if (p.kind === 'number' || p.kind === 'string' || p.kind === 'regex') return false;
    if (p.kind === 'template') return !p.value.endsWith('`');
    if (p.kind === 'ident') return false;
    if (p.kind === 'keyword') return REGEX_AFTER_WORD.has(p.value);
    return !(p.value === ')' || p.value === ']' || p.value === '}' || p.value === '++' || p.value === '--');
  };
  // Scans template characters from `i` (just after a backtick or `}`) to the closing backtick or `${`.
  const scanTemplate = (start: number) => {
    while (i < src.length) {
      const c = src[i];
      if (c === '\\') i += 2;
      else if (c === '`') {
        i++;
        push('template', start, i);
        return;
      } else if (c === '$' && src[i + 1] === '{') {
        i += 2;
        braces.push(true);
        push('template', start, i);
        return;
      } else i++;
    }
    if (!tolerant) fail('Unterminated template literal', start);
    push('template', start, src.length);
  };

  while (i < src.length) {
    const c = src[i];
    const start = i;
    if (c === '\n') {
      nl = true;
      i++;
    } else if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v' || c === '\u00a0' || c === '\ufeff' || c === '\u2028' || c === '\u2029') {
      if (c === '\u2028' || c === '\u2029') nl = true;
      i++;
    } else if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      push('comment', start, i);
    } else if (c === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2);
      if (close < 0 && !tolerant) fail('Unterminated comment', start);
      i = close < 0 ? src.length : close + 2;
      if (src.slice(start, i).includes('\n')) nl = true;
      push('comment', start, i);
    } else if (c === '"' || c === "'") {
      i++;
      while (i < src.length && src[i] !== c && src[i] !== '\n') i += src[i] === '\\' ? 2 : 1;
      if (src[i] !== c) {
        if (!tolerant) fail('Unterminated string', start);
      } else i++;
      push('string', start, Math.min(i, src.length));
    } else if (c === '`') {
      i++;
      scanTemplate(start);
    } else if (c === '}' && braces.length && braces[braces.length - 1]) {
      braces.pop();
      i++;
      scanTemplate(start);
    } else if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      if (c === '0' && /[xXoObB]/.test(src[i + 1] ?? '')) i += 2;
      while (i < src.length && /[\w.]/.test(src[i])) {
        // Exponent sign: 1e-5
        if ((src[i] === 'e' || src[i] === 'E') && (src[i + 1] === '-' || src[i + 1] === '+') && !/[xX]/.test(src[start + 1] ?? '')) i++;
        i++;
      }
      push('number', start, i);
    } else if (isIdStart(c) || c === '#' || c === '\\') {
      i++;
      while (i < src.length && (isIdPart(src[i]) || src[i] === '\\')) i++;
      const word = src.slice(start, i);
      // Property names after `.` are never keywords (`a.type`, `x.default`).
      const afterDot = (prev as Token | null)?.value === '.' || (prev as Token | null)?.value === '?.';
      push(KEYWORDS.has(word) && !afterDot ? 'keyword' : 'ident', start, i);
    } else if (c === '/' && regexAllowed()) {
      i++;
      let inClass = false;
      while (i < src.length && src[i] !== '\n') {
        const ch = src[i];
        if (ch === '\\') i++;
        else if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        else if (ch === '/' && !inClass) break;
        i++;
      }
      if (src[i] !== '/') {
        if (!tolerant) fail('Unterminated regular expression', start);
      } else i++;
      while (i < src.length && isIdPart(src[i])) i++;
      push('regex', start, i);
    } else {
      let p = '';
      if (c !== '>') for (const cand of PUNCTUATORS) if (src.startsWith(cand, i)) { p = cand; break; }
      // `?.5` is a conditional followed by a number, not optional chaining.
      if (p === '?.' && /[0-9]/.test(src[i + 2] ?? '')) p = '';
      if (!p) p = c;
      i += p.length;
      if (p === '{' || p === '${') braces.push(false);
      else if (p === '}') braces.pop();
      push('punct', start, i);
    }
  }
  out.push({ kind: 'eof', value: '', start: src.length, end: src.length, nl: true });
  return out;
}

export function lineColumn(src: string, offset: number): { line: number; column: number } {
  let line = 1, last = -1;
  for (let i = 0; i < offset && i < src.length; i++) if (src[i] === '\n') {
    line++;
    last = i;
  }
  return { line, column: offset - last };
}

export interface ImportBinding {
  imported: string;
  local: string;
}

export interface ModuleImport {
  from: string;
  /** Named imports (`import { a as b }`). */
  names: ImportBinding[];
  /** `import * as ns`. */
  namespace?: string;
  /** `import x from` */
  defaultName?: string;
  start: number;
}

export interface StripResult {
  code: string;
  imports: ModuleImport[];
  /**
   * How the default export is reached after the rewrite: the declared name of
   * `export default class Foo`, or `__default` for `export default <expr>`.
   */
  defaultExport: string | null;
  /** Names of class members declared `private` or `protected`. */
  privateMembers: Set<string>;
}

export interface StripOptions {
  /**
   * Rewrite the module syntax for evaluation inside a function body:
   * imports are blanked (and reported), `export` is removed and
   * `export default <expr>` assigns `__default`.
   */
  module?: boolean;
}

// Tokens that can continue an expression onto the next line (otherwise a
// line break ends it, following JavaScript's automatic semicolon insertion).
const CONTINUES = new Set([
  '.', '?.', '(', '[', '`', '?', ':', '=', ',', ')', ']', '}', '=>', '+', '-', '*', '/', '%', '**', '<', '>', '<=', '==', '!=', '===', '!==',
  '&', '|', '^', '&&', '||', '??', '<<', '+=', '-=', '*=', '/=', '%=', '**=', '<<=', '>>=', '>>>=', '&=', '|=', '^=', '&&=', '||=', '??=',
  'in', 'instanceof',
]);

const MODIFIERS = new Set(['public', 'private', 'protected', 'readonly', 'abstract', 'override', 'declare', 'static', 'accessor', 'async']);
const TS_ONLY_MODIFIERS = new Set(['public', 'private', 'protected', 'readonly', 'abstract', 'override', 'declare']);

/** Erases TypeScript syntax from `src`. Throws TranspileError on unsupported or malformed input. */
export function stripTypes(src: string, options: StripOptions = {}): StripResult {
  return new Stripper(src, options).run();
}

class Stripper {
  private readonly toks: Token[];
  private p = 0;
  private readonly out: string[];
  private readonly imports: ModuleImport[] = [];
  private defaultExport: string | null = null;
  private readonly privateMembers = new Set<string>();

  constructor(
    private readonly src: string,
    private readonly options: StripOptions,
  ) {
    this.toks = tokenize(src).filter((t) => t.kind !== 'comment');
    this.out = src.split('');
  }

  run(): StripResult {
    this.statements(null);
    return { code: this.out.join(''), imports: this.imports, defaultExport: this.defaultExport, privateMembers: this.privateMembers };
  }

  // ---------------------------------------------------------------- helpers

  private get t(): Token {
    return this.toks[this.p];
  }
  private peek(n = 1): Token {
    return this.toks[Math.min(this.p + n, this.toks.length - 1)];
  }
  private is(v: string, tok = this.t): boolean {
    return tok.value === v && tok.kind !== 'string' && tok.kind !== 'template';
  }
  private next(): Token {
    const t = this.t;
    if (t.kind !== 'eof') this.p++;
    return t;
  }
  private eat(v: string): boolean {
    if (!this.is(v)) return false;
    this.p++;
    return true;
  }
  private expect(v: string): Token {
    if (!this.is(v)) this.error(`Expected '${v}' but found ${this.describe(this.t)}`);
    return this.next();
  }
  private describe(t: Token): string {
    return t.kind === 'eof' ? 'end of file' : `'${t.value}'`;
  }
  private error(msg: string, tok = this.t): never {
    const { line, column } = lineColumn(this.src, tok.start);
    throw new TranspileError(msg, line, column);
  }
  /** Replaces source offsets [start, end) with spaces, keeping line breaks. */
  private blank(start: number, end: number): void {
    for (let i = start; i < end; i++) if (this.out[i] !== '\n' && this.out[i] !== '\r') this.out[i] = ' ';
  }
  /** Blanks tokens [fromIndex, this.p). */
  private blankFrom(fromIndex: number): void {
    if (fromIndex < this.p) this.blank(this.toks[fromIndex].start, this.toks[this.p - 1].end);
  }
  /** Overwrites [start, end) with `text` padded by spaces, so later columns don't move. */
  private replaceRange(start: number, end: number, text: string): void {
    if (text.length > end - start) throw new Error('replacement too long');
    for (let i = start; i < end; i++) this.out[i] = text[i - start] ?? ' ';
  }
  /** True when `tok` can end an expression (so a following `/`, `!`, `as`, `<` are operators). */
  private endsExpression(tok: Token): boolean {
    if (tok.kind === 'ident' || tok.kind === 'number' || tok.kind === 'string' || tok.kind === 'regex') return true;
    if (tok.kind === 'template') return tok.value.endsWith('`') && (tok.value.length > 1 || tok.value === '`');
    if (tok.kind === 'keyword') return ['this', 'super', 'true', 'false', 'null', 'undefined'].includes(tok.value) || contextualIdent(tok.value);
    return tok.value === ')' || tok.value === ']' || tok.value === '}';
  }
  /** A line break before the current token ends the expression (ASI). */
  private asiBreak(prev: Token | undefined): boolean {
    const t = this.t;
    if (!t.nl || !prev || !this.endsExpression(prev)) return false;
    if (t.kind === 'template') return false;
    return !(t.kind === 'punct' || (t.kind === 'keyword' && (t.value === 'in' || t.value === 'instanceof'))) || !CONTINUES.has(t.value);
  }
  private matching(index: number): number {
    const open = this.toks[index].value;
    const close = open === '(' ? ')' : open === '[' ? ']' : open === '{' ? '}' : '>';
    let depth = 0;
    for (let i = index; i < this.toks.length; i++) {
      const tok = this.toks[i];
      if (tok.kind === 'string') continue;
      if (tok.kind === 'template') {
        // `${` opens and `}...` closes a brace level.
        if (tok.value.endsWith('${')) depth += open === '{' ? 1 : 0;
        if (tok.value.startsWith('}')) depth -= open === '{' ? 1 : 0;
        continue;
      }
      if (tok.value === open) depth++;
      else if (tok.value === close) {
        depth--;
        if (depth === 0) return i;
      } else if (open === '<' && tok.value === ';') return -1;
    }
    return -1;
  }

  // ------------------------------------------------------------ statements

  /** Statements until `end` (a closing punctuator) or EOF. Leaves `end` unconsumed. */
  private statements(end: string | null): void {
    while (this.t.kind !== 'eof' && !(end && this.is(end))) this.statement();
    if (end && !this.is(end)) this.error(`Expected '${end}' but found end of file`);
  }

  private statement(): void {
    const t = this.t;
    if (t.kind === 'punct') {
      if (t.value === ';') return void this.next();
      if (t.value === '{') {
        this.next();
        this.statements('}');
        this.next();
        return;
      }
      if (t.value === '@') this.error('Decorators are not supported');
    }
    if (t.kind === 'keyword' || t.kind === 'ident') {
      const v = t.value;
      const n = this.peek();
      switch (v) {
        case 'import':
          if (!this.is('(', n) && !this.is('.', n)) return this.importDecl();
          break;
        case 'export':
          return this.exportDecl();
        case 'type':
          if ((n.kind === 'ident' || n.kind === 'keyword') && !n.nl && (this.is('=', this.peek(2)) || this.is('<', this.peek(2)))) return this.eraseTypeAlias();
          break;
        case 'interface':
          if ((n.kind === 'ident' || n.kind === 'keyword') && !n.nl) return this.eraseInterface();
          break;
        case 'declare':
          if (!n.nl && (n.kind === 'keyword' || n.kind === 'ident') && !this.is('=', n) && !this.is('(', n)) return this.eraseDeclare();
          break;
        case 'abstract':
          if (this.is('class', n) && !n.nl) {
            this.blank(t.start, t.end);
            this.next();
            return this.classDecl();
          }
          break;
        case 'enum':
          this.error('Enums are not supported in scripts; use a const object instead');
          break;
        case 'const':
          if (this.is('enum', n)) this.error('Enums are not supported in scripts; use a const object instead');
          return this.varDecl();
        case 'namespace':
        case 'module':
          if ((n.kind === 'ident' || n.kind === 'string') && !n.nl && this.is('{', this.peek(2))) this.error('Namespaces are not supported in scripts');
          break;
        case 'let':
        case 'var':
          if (n.kind === 'ident' || n.kind === 'keyword' || this.is('{', n) || this.is('[', n)) return this.varDecl();
          break;
        case 'function':
          return this.functionDecl();
        case 'async':
          if (this.is('function', n) && !n.nl) {
            this.next();
            return this.functionDecl();
          }
          break;
        case 'class':
          return this.classDecl();
        case 'if':
        case 'while':
        case 'with':
          this.next();
          this.parenExpression();
          return this.statement();
        case 'for':
          return this.forStatement();
        case 'do':
          this.next();
          this.statement();
          if (this.eat('while')) this.parenExpression();
          return;
        case 'else':
        case 'finally':
          this.next();
          return this.statement();
        case 'try':
          this.next();
          return this.statement();
        case 'catch':
          this.next();
          if (this.is('(')) {
            this.next();
            this.bindingElement([')']);
            this.expect(')');
          }
          return this.statement();
        case 'switch':
          return this.switchStatement();
        case 'return':
        case 'throw':
          this.next();
          if (!this.t.nl || v === 'throw') this.expression([';', '}']);
          return;
        case 'break':
        case 'continue':
          this.next();
          if (this.t.kind === 'ident' && !this.t.nl) this.next();
          return;
        case 'debugger':
          this.next();
          return;
        case 'case':
        case 'default':
          // Only reached inside switch bodies.
          this.next();
          if (v === 'case') this.expression([':']);
          this.expect(':');
          return;
      }
      // Label
      if (t.kind === 'ident' && this.is(':', n)) {
        this.next();
        this.next();
        return this.statement();
      }
    }
    this.expression([';', '}']);
  }

  private parenExpression(): void {
    this.expect('(');
    this.expression([')']);
    this.expect(')');
  }

  private switchStatement(): void {
    this.next();
    this.parenExpression();
    this.expect('{');
    this.statements('}');
    this.next();
  }

  private forStatement(): void {
    this.next();
    this.eat('await');
    this.expect('(');
    if (this.is('let') || this.is('const') || this.is('var')) this.varDecl([';', 'of', 'in', ')']);
    else this.expression([';', 'of', 'in', ')']);
    while (this.eat(';') || this.eat('of') || this.eat('in')) this.expression([';', ')']);
    this.expect(')');
    this.statement();
  }

  private varDecl(stops: string[] = [';', '}']): void {
    this.next(); // let / const / var
    for (;;) {
      this.bindingElement([...stops, ',']);
      if (!this.eat(',')) break;
    }
  }

  /**
   * A binding (`name`, `{ a, b }`, `[x]`), with optional `?`/`!`, type annotation and
   * default/initializer. Used for declarations and parameters.
   */
  private bindingElement(stops: string[]): void {
    this.eat('...');
    const t = this.t;
    if (this.is('{') || this.is('[')) this.expression(stops.concat(':', '=', '?', '!'), true);
    else if (t.kind === 'ident' || t.kind === 'keyword') this.next();
    else this.error(`Unexpected ${this.describe(t)}`);
    const mark = this.p;
    if (this.is('?') || (this.is('!') && !this.t.nl)) {
      if (this.is('?', this.peek()) || this.is(':', this.peek()) || this.is(',', this.peek()) || this.is(')', this.peek()) || this.is('=', this.peek())) this.next();
    }
    if (this.is(':')) {
      this.next();
      this.type();
    }
    this.blankFrom(mark);
    if (this.eat('=')) this.expression(stops);
  }

  private importDecl(): void {
    const start = this.p;
    this.next();
    if (this.is('type') && !this.is(',', this.peek()) && !this.is('from', this.peek())) {
      this.skipToStatementEnd();
      this.blankFrom(start);
      return;
    }
    if (this.is('=', this.peek()) || (this.is('type') && this.is('=', this.peek(2)))) this.error("'import x = require()' is not supported; use an import declaration");
    const imp: ModuleImport = { from: '', names: [], start: this.t.start };
    if (this.t.kind === 'string') {
      // Side-effect import.
    } else {
      if (this.t.kind === 'ident' || (this.t.kind === 'keyword' && !this.is('{'))) {
        if (!this.is('*')) imp.defaultName = this.next().value;
        this.eat(',');
      }
      if (this.eat('*')) {
        this.expect('as');
        imp.namespace = this.next().value;
      } else if (this.is('{')) {
        this.next();
        while (!this.is('}')) {
          const specStart = this.p;
          const isType = this.is('type') && !this.is(',', this.peek()) && !this.is('}', this.peek()) && !this.is('as', this.peek());
          if (isType) this.next();
          const imported = this.next().value;
          const local = this.eat('as') ? this.next().value : imported;
          if (isType) {
            this.eat(',');
            this.blankFrom(specStart);
          } else {
            imp.names.push({ imported, local });
            if (!this.is('}')) this.expect(',');
          }
        }
        this.next();
      }
      this.expect('from');
    }
    if (this.t.kind !== 'string') this.error('Expected module name string');
    imp.from = this.next().value.slice(1, -1);
    if (this.is('with') || this.is('assert')) {
      this.next();
      this.p = this.matching(this.p) + 1;
    }
    this.eat(';');
    if (this.options.module) {
      this.imports.push(imp);
      this.blankFrom(start);
    }
  }

  private exportDecl(): void {
    const exp = this.t;
    const n = this.peek();
    if (this.is('type', n) && (this.is('{', this.peek(2)) || this.is('*', this.peek(2)))) {
      const start = this.p;
      this.skipToStatementEnd();
      return this.blankFrom(start);
    }
    if (this.is('{', n) || this.is('*', n)) {
      const start = this.p;
      this.next();
      if (this.options.module && this.is('*')) this.error("Scripts can't re-export modules");
      if (this.eat('{')) {
        while (!this.is('}') && this.t.kind !== 'eof') {
          const specStart = this.p;
          if (this.is('type') && !this.is(',', this.peek()) && !this.is('}', this.peek()) && !this.is('as', this.peek())) {
            this.next();
            this.next();
            if (this.eat('as')) this.next();
            this.eat(',');
            this.blankFrom(specStart);
          } else this.next();
        }
        this.expect('}');
      } else {
        this.next();
        if (this.eat('as')) this.next();
      }
      if (this.eat('from')) {
        if (this.options.module) this.error("Scripts can't re-export modules");
        this.next();
      }
      this.eat(';');
      if (this.options.module) this.blankFrom(start);
      return;
    }
    if (this.is('=', n)) this.error("'export =' is not supported");
    if (this.is('as', n)) this.error("'export as namespace' is not supported");
    this.next();
    if (this.is('default')) {
      const def = this.next();
      const t = this.t;
      if (this.options.module) {
        if (this.is('interface')) return this.eraseInterface(exp);
        const declared = this.declaredName();
        if (declared) {
          // `export default class Foo`: keep the declaration, return Foo.
          this.blank(exp.start, def.end);
          this.defaultExport = declared;
        } else {
          // Expression or anonymous class/function: `export default` (15 chars) fits `__default=`.
          this.replaceRange(exp.start, def.end, '__default=');
          this.defaultExport = '__default';
        }
      }
      if (this.is('interface', t)) return this.eraseInterface(exp);
      if (this.is('abstract') && this.is('class', this.peek())) {
        this.blank(this.t.start, this.t.end);
        this.next();
      }
      if (this.is('class')) return this.classDecl(true);
      if (this.is('function') || (this.is('async') && this.is('function', this.peek()))) {
        this.eat('async');
        return this.functionDecl(true);
      }
      this.expression([';', '}']);
      return;
    }
    if (this.is('declare') || this.is('type') && (this.peek().kind === 'ident' || this.peek().kind === 'keyword') || this.is('interface')) {
      // `export type X = …`, `export interface …`, `export declare …`: erase together with `export`.
      const before = this.p;
      this.statement();
      const erased = this.toks.slice(before, this.p).every((tok) => this.out.slice(tok.start, tok.end).join('').trim() === '');
      if (erased || this.options.module) this.blank(exp.start, exp.end);
      return;
    }
    if (this.options.module) this.blank(exp.start, exp.end);
    this.statement();
  }

  /** For `export default <decl>`: the class/function name, '' if anonymous, undefined if an expression. */
  private declaredName(): string | undefined {
    let i = this.p;
    if (this.is('abstract', this.toks[i]) && this.is('class', this.toks[i + 1])) i++;
    if (this.is('async', this.toks[i]) && this.is('function', this.toks[i + 1])) i++;
    const kw = this.toks[i];
    if (!this.is('class', kw) && !this.is('function', kw)) return undefined;
    i++;
    if (this.is('*', this.toks[i])) i++;
    const name = this.toks[i];
    if (name.kind === 'ident' || (name.kind === 'keyword' && contextualIdent(name.value) && !this.is('implements', name) && !this.is('extends', name))) return name.value;
    return '';
  }

  private skipToStatementEnd(): void {
    // Erased declarations end at `;`, or at a line break outside brackets.
    let depth = 0;
    const startTok = this.t;
    while (this.t.kind !== 'eof') {
      const t = this.t;
      if (t !== startTok && depth === 0 && t.nl && !this.continuesType(t)) return;
      if (t.kind === 'punct') {
        if (t.value === '(' || t.value === '[' || t.value === '{' || t.value === '<') depth++;
        else if (t.value === ')' || t.value === ']' || t.value === '}' || t.value === '>') depth--;
        else if (t.value === ';' && depth === 0) {
          this.next();
          return;
        }
        if (depth < 0) return;
      }
      this.next();
    }
  }
  private continuesType(t: Token): boolean {
    return t.kind === 'punct' && ['|', '&', '=', '.', '?', ':', '=>', ',', '>', '['].includes(t.value) || this.is('extends', t);
  }

  private eraseTypeAlias(exportTok?: Token): void {
    const start = this.p;
    this.next(); // type
    this.next(); // name
    if (this.is('<')) this.typeParams();
    this.expect('=');
    this.type();
    this.eat(';');
    this.blankFrom(start);
    if (exportTok) this.blank(exportTok.start, exportTok.end);
  }

  private eraseInterface(exportTok?: Token): void {
    const start = this.p;
    this.next(); // interface
    this.next(); // name
    if (this.is('<')) this.typeParams();
    if (this.eat('extends')) {
      for (;;) {
        this.typeReference();
        if (!this.eat(',')) break;
      }
    }
    this.skipBalanced('{');
    this.blankFrom(start);
    if (exportTok) this.blank(exportTok.start, exportTok.end);
  }

  private eraseDeclare(): void {
    const start = this.p;
    this.next(); // declare
    if (this.is('global') || this.is('module') || this.is('namespace')) {
      this.next();
      if (this.t.kind === 'string' || this.t.kind === 'ident') this.next();
      while (this.eat('.')) this.next();
      if (this.is('{')) this.skipBalanced('{');
      else this.eat(';');
    } else if (this.is('class') || this.is('abstract')) {
      while (!this.is('{') && this.t.kind !== 'eof') this.next();
      this.skipBalanced('{');
    } else if (this.is('enum') || this.is('const') && this.is('enum', this.peek())) {
      while (!this.is('{') && this.t.kind !== 'eof') this.next();
      this.skipBalanced('{');
    } else if (this.is('interface')) {
      this.eraseInterface();
    } else if (this.is('type')) {
      this.eraseTypeAlias();
    } else if (this.is('function')) {
      this.next();
      this.next();
      if (this.is('<')) this.typeParams();
      this.skipBalanced('(');
      if (this.eat(':')) this.returnType();
      this.eat(';');
    } else {
      // declare const/let/var
      this.next();
      for (;;) {
        if (this.is('{') || this.is('[')) this.skipBalanced(this.t.value);
        else this.next();
        if (this.eat(':')) this.type();
        if (!this.eat(',')) break;
      }
      this.eat(';');
    }
    this.blankFrom(start);
  }

  private functionDecl(allowAnonymous = false): void {
    let first = this.p;
    this.expect('function');
    this.eat('*');
    if (this.t.kind === 'ident' || (this.t.kind === 'keyword' && !this.is('('))) this.next();
    else if (!allowAnonymous && !this.is('(') && !this.is('<')) this.error('Expected function name');
    if (this.is('<')) this.blankTypeParams();
    this.params();
    if (this.is(':')) this.blankReturnType();
    if (this.is('{')) return this.functionBody();
    // Overload signature (no body): erase it, including `export` / `async` before it.
    this.eat(';');
    while (first > 0 && (this.is('async', this.toks[first - 1]) || this.is('export', this.toks[first - 1]))) first--;
    this.blank(this.toks[first].start, this.toks[this.p - 1].end);
  }

  private functionBody(): void {
    this.expect('{');
    this.statements('}');
    this.next();
  }

  /** `( params )` with annotations erased. */
  private params(): void {
    this.expect('(');
    let first = true;
    while (!this.is(')')) {
      if (this.t.kind === 'eof') this.error("Expected ')'");
      const paramStart = this.p;
      if (this.is('@')) this.error('Decorators are not supported');
      // Parameter properties need codegen (`this.x = x`), so they're out of the erasable subset.
      if (TS_ONLY_MODIFIERS.has(this.t.value) && this.t.kind === 'keyword' && (this.peek().kind === 'ident' || this.peek().kind === 'keyword' || this.is('{', this.peek()) || this.is('[', this.peek())) && !this.is(':', this.peek()) && !this.is(',', this.peek()) && !this.is(')', this.peek()) && !this.is('?', this.peek()) && !this.is('=', this.peek())) {
        this.error('Parameter properties are not supported; declare the field and assign it in the constructor');
      }
      // `this: Type` pseudo-parameter: erase together with its comma.
      if (first && this.is('this') && this.is(':', this.peek())) {
        this.next();
        this.next();
        this.type();
        this.eat(',');
        this.blankFrom(paramStart);
        first = false;
        continue;
      }
      first = false;
      this.bindingElement([',', ')']);
      if (!this.is(')')) this.expect(',');
    }
    this.next();
  }

  private blankTypeParams(): void {
    const start = this.p;
    this.typeParams();
    this.blankFrom(start);
  }

  private blankReturnType(): void {
    const start = this.p;
    this.expect(':');
    this.returnType();
    this.blankFrom(start);
  }

  private returnType(): void {
    // `asserts x is T`, `x is T`, `asserts x`
    if (this.is('asserts') && (this.peek().kind === 'ident' || this.is('this', this.peek())) && !this.peek().nl) {
      this.next();
      this.next();
      if (this.eat('is')) this.type();
      return;
    }
    if ((this.t.kind === 'ident' || this.is('this')) && this.is('is', this.peek())) {
      this.next();
      this.next();
    }
    this.type();
  }

  private classDecl(allowAnonymous = false): void {
    this.expect('class');
    if ((this.t.kind === 'ident' || (this.t.kind === 'keyword' && !this.is('extends') && !this.is('implements'))) && !this.is('{')) this.next();
    else if (!allowAnonymous && !this.is('{') && !this.is('extends') && !this.is('implements')) this.error('Expected class name');
    this.classTail();
  }

  /** After the class name: type params, heritage clauses and body. */
  private classTail(): void {
    if (this.is('<')) this.blankTypeParams();
    if (this.eat('extends')) {
      this.expression(['{', 'implements'], false, true);
    }
    if (this.is('implements')) {
      const start = this.p;
      this.next();
      for (;;) {
        this.typeReference();
        if (!this.eat(',')) break;
      }
      this.blankFrom(start);
    }
    this.classBody();
  }

  private classBody(): void {
    this.expect('{');
    while (!this.is('}')) {
      if (this.t.kind === 'eof') this.error("Expected '}' to close the class body");
      this.classMember();
    }
    this.next();
  }

  private classMember(): void {
    if (this.eat(';')) return;
    if (this.is('@')) this.error('Decorators are not supported');
    const start = this.p;
    // static { … } block
    if (this.is('static') && this.is('{', this.peek())) {
      this.next();
      this.functionBody();
      return;
    }
    let isAbstract = false, isDeclare = false, isPrivate = false;
    // Modifiers: a modifier word followed by something that can start a member name.
    while (MODIFIERS.has(this.t.value) && this.t.kind === 'keyword' && !this.peek().nl && this.startsMemberName(this.peek())) {
      const m = this.next();
      if (TS_ONLY_MODIFIERS.has(m.value)) this.blank(m.start, m.end);
      if (m.value === 'abstract') isAbstract = true;
      if (m.value === 'declare') isDeclare = true;
      if (m.value === 'private' || m.value === 'protected') isPrivate = true;
    }
    // Index signature: [key: string]: T;
    if (this.is('[') && (this.peek().kind === 'ident' || this.peek().kind === 'keyword') && this.is(':', this.peek(2))) {
      this.skipBalanced('[');
      this.expect(':');
      this.type();
      this.eat(';');
      this.blankFrom(start);
      return;
    }
    this.eat('*');
    if ((this.is('get') || this.is('set')) && this.startsMemberName(this.peek()) && !this.peek().nl) this.next();
    // Name
    const nameTok = this.t;
    if (this.is('[')) {
      this.next();
      this.expression([']']);
      this.expect(']');
    } else if (nameTok.kind === 'ident' || nameTok.kind === 'keyword' || nameTok.kind === 'string' || nameTok.kind === 'number') {
      this.next();
      if (isPrivate && nameTok.kind !== 'string') this.privateMembers.add(nameTok.value);
    } else this.error(`Unexpected ${this.describe(nameTok)} in class body`);
    // Optional / definite markers
    if (this.is('?') || this.is('!')) {
      const m = this.next();
      this.blank(m.start, m.end);
    }
    if (this.is('<') || this.is('(')) {
      if (this.is('<')) this.blankTypeParams();
      this.params();
      if (this.is(':')) this.blankReturnType();
      if (this.is('{') && !isAbstract) this.functionBody();
      else {
        // Abstract method or overload signature.
        this.eat(';');
        this.blankFrom(start);
      }
      return;
    }
    if (this.is(':')) {
      const annot = this.p;
      this.next();
      this.type();
      this.blankFrom(annot);
    }
    if (this.eat('=')) this.expression([';', '}'], false, false, true);
    this.eat(';');
    if (isDeclare || isAbstract) this.blankFrom(start);
  }

  private startsMemberName(t: Token): boolean {
    return t.kind === 'ident' || t.kind === 'keyword' || t.kind === 'string' || t.kind === 'number' || t.value === '[' || t.value === '*' || t.value === '#' || t.value.startsWith('#');
  }

  // ----------------------------------------------------------- expressions

  /**
   * Walks an expression until one of `stops` at nesting depth 0 (not consumed),
   * a line break that ends it, or a closing bracket. Arrow functions, function
   * and class expressions, object literals and template substitutions are
   * walked recursively so their types are erased too.
   *
   * `pattern`: inside a destructuring pattern (no ASI). `heritage`: the
   * expression of an `extends` clause (type arguments allowed before `{`).
   * `field`: a class field initializer (ASI ends it).
   */
  private expression(stops: string[], pattern = false, heritage = false, field = false): void {
    let prev: Token | undefined;
    // Open `?` of conditionals at this level: in a true branch `(a): b => c` is not
    // an arrow with a return type (TypeScript's rule), so `c ? (a) : b => d` works.
    let ternary = 0;
    for (;;) {
      const t = this.t;
      if (t.kind === 'eof') return;
      // `}` that closes a template substitution
      if (t.kind === 'template' && t.value.startsWith('}')) return;
      if (t.kind !== 'string' && t.kind !== 'template' && stops.includes(t.value) && !(t.value === 'in' && pattern)) return;
      if (t.kind === 'punct' && (t.value === ')' || t.value === ']' || t.value === '}')) return;
      if (!pattern && prev && this.asiBreak(prev) && (field || stops.includes(';'))) return;

      if (t.kind === 'template') {
        this.next();
        if (t.value.endsWith('${')) this.templateRest();
        prev = this.toks[this.p - 1];
        continue;
      }
      if (t.kind === 'punct') {
        const v = t.value;
        if (v === '?') ternary++;
        else if (v === ':' && ternary > 0) ternary--;
        if (v === '(') {
          if (!(prev && this.endsExpression(prev)) && this.isArrowParams(this.p, ternary > 0)) {
            this.arrowFunction();
          } else {
            this.next();
            this.expression([')']);
            this.expect(')');
          }
        } else if (v === '[') {
          this.next();
          this.expression([']'], pattern);
          this.expect(']');
        } else if (v === '{') {
          if (pattern) this.objectPattern();
          else this.objectLiteral();
        } else if (v === '<') {
          if (prev && this.endsExpression(prev) && !(prev.kind === 'keyword' && ['true', 'false', 'null', 'undefined'].includes(prev.value)) && this.tryTypeArguments(heritage)) {
            /* type arguments erased */
          } else if (!(prev && this.endsExpression(prev)) && this.isGenericArrow()) {
            this.blankTypeParams();
            this.arrowFunction();
          } else if (!(prev && this.endsExpression(prev))) {
            this.error('Angle-bracket type assertions are not supported; use `as`');
          } else this.next();
        } else if (v === '!' && prev && this.endsExpression(prev) && !t.nl) {
          // Non-null assertion
          this.blank(t.start, t.end);
          this.next();
          continue; // prev stays the operand
        } else if (v === '@') {
          this.error('Decorators are not supported');
        } else this.next();
        prev = this.toks[this.p - 1];
        continue;
      }
      if (t.kind === 'keyword') {
        const v = t.value;
        if ((v === 'as' || v === 'satisfies') && prev && this.endsExpression(prev) && !t.nl) {
          const start = this.p;
          this.next();
          if (this.is('const')) this.next();
          else this.type();
          this.blankFrom(start);
          prev = this.toks[start - 1];
          continue;
        }
        if (v === 'function' && !(prev && this.is('.', prev))) {
          this.functionExpression();
          prev = this.toks[this.p - 1];
          continue;
        }
        if (v === 'async' && this.is('function', this.peek()) && !this.peek().nl) {
          this.next();
          this.functionExpression();
          prev = this.toks[this.p - 1];
          continue;
        }
        if (v === 'async' && !(prev && this.endsExpression(prev)) && this.is('(', this.peek()) && this.isArrowParams(this.p + 1)) {
          this.next();
          this.arrowFunction();
          prev = this.toks[this.p - 1];
          continue;
        }
        if (v === 'async' && !(prev && this.endsExpression(prev)) && this.is('<', this.peek())) {
          this.next();
          if (this.isGenericArrow()) {
            this.blankTypeParams();
            this.arrowFunction();
            prev = this.toks[this.p - 1];
            continue;
          }
          prev = this.toks[this.p - 1];
          continue;
        }
        if (v === 'class') {
          this.next();
          if ((this.t.kind === 'ident' || this.t.kind === 'keyword') && !this.is('extends') && !this.is('implements') && !this.is('{')) this.next();
          this.classTail();
          prev = this.toks[this.p - 1];
          continue;
        }
      }
      this.next();
      prev = t;
    }
  }

  private templateRest(): void {
    for (;;) {
      this.expression([]);
      const t = this.t;
      if (t.kind !== 'template' || !t.value.startsWith('}')) this.error('Unterminated template substitution');
      this.next();
      if (t.value.endsWith('`')) return;
    }
  }

  private functionExpression(): void {
    this.expect('function');
    this.eat('*');
    if (this.t.kind === 'ident' || (this.t.kind === 'keyword' && !this.is('(') && !this.is('<'))) this.next();
    if (this.is('<')) this.blankTypeParams();
    this.params();
    if (this.is(':')) this.blankReturnType();
    this.functionBody();
  }

  /** At `(`: does the matching `)` start an arrow function (`) =>` or `): Type =>`)? */
  private isArrowParams(index: number, noReturnType = false): boolean {
    const close = this.matching(index);
    if (close < 0) return false;
    const after = this.toks[close + 1];
    if (this.is('=>', after) && !after.nl) return true;
    if (!this.is(':', after) || noReturnType) return false;
    // Speculatively parse a return type and check for `=>`. Type parsing only
    // moves the cursor (it never blanks), so restoring `p` is enough.
    const save = this.p;
    try {
      this.p = close + 2;
      this.returnType();
      return this.is('=>');
    } catch {
      return false;
    } finally {
      this.p = save;
    }
  }

  private isGenericArrow(): boolean {
    const close = this.matching(this.p);
    if (close < 0) return false;
    return this.is('(', this.toks[close + 1]) && this.isArrowParams(close + 1);
  }

  private arrowFunction(): void {
    this.params();
    if (this.is(':')) this.blankReturnType();
    this.expect('=>');
    if (this.is('{')) this.functionBody();
    // An expression body is simply walked by the caller's loop.
  }

  /** `f<T>(x)`, `new C<T>()`, `extends Base<T> {`: erase the type arguments when they parse as such. */
  private tryTypeArguments(heritage: boolean): boolean {
    const save = this.p;
    try {
      this.typeArguments();
      const n = this.t;
      // What can follow type arguments in an expression (as in TypeScript's own parser).
      const ok =
        n.kind === 'template' && n.value.startsWith('`') ||
        (n.kind === 'punct' && ['(', ')', ']', ';', ',', '.', '?.', ':', '=', '==', '===', '!=', '!==', '&&', '||', '??', '?', '}'].includes(n.value)) ||
        n.kind === 'eof' ||
        (heritage && (this.is('{', n) || this.is('implements', n))) ||
        (n.nl && n.kind !== 'punct');
      if (!ok) throw new Error('not type arguments');
      if (this.is('?', n) && !heritage) {
        // `a < b > ? c : d` is a comparison chain; keep it.
        throw new Error('ambiguous');
      }
      this.blank(this.toks[save].start, this.toks[this.p - 1].end);
      return true;
    } catch {
      this.p = save;
      return false;
    }
  }

  private objectLiteral(): void {
    this.expect('{');
    while (!this.is('}')) {
      if (this.t.kind === 'eof') this.error("Expected '}'");
      if (this.eat(',')) continue;
      if (this.eat('...')) {
        this.expression([',', '}']);
        continue;
      }
      let isMethod = false;
      if ((this.is('get') || this.is('set') || this.is('async')) && this.startsMemberName(this.peek()) && !this.is(',', this.peek())) this.next();
      if (this.eat('*')) isMethod = true;
      if (this.is('[')) {
        this.next();
        this.expression([']']);
        this.expect(']');
      } else this.next();
      if (this.is('(') || this.is('<') || isMethod) {
        if (this.is('<')) this.blankTypeParams();
        this.params();
        if (this.is(':')) this.blankReturnType();
        this.functionBody();
      } else if (this.eat(':')) {
        this.expression([',', '}']);
      } else if (this.eat('=')) {
        // Shorthand default inside a pattern written as an object literal (e.g. assignment patterns).
        this.expression([',', '}']);
      }
    }
    this.next();
  }

  /** Destructuring pattern in a declaration or parameter: `{ a, b: [c], d = 1 }`. */
  private objectPattern(): void {
    this.expect('{');
    while (!this.is('}')) {
      if (this.t.kind === 'eof') this.error("Expected '}'");
      if (this.eat(',')) continue;
      if (this.eat('...')) {
        this.next();
        continue;
      }
      if (this.is('[')) {
        this.next();
        this.expression([']']);
        this.expect(']');
      } else this.next();
      if (this.eat(':')) {
        if (this.is('{')) this.objectPattern();
        else if (this.is('[')) {
          this.next();
          this.expression([']'], true);
          this.expect(']');
        } else this.next();
      }
      if (this.eat('=')) this.expression([',', '}']);
    }
    this.next();
  }

  // ------------------------------------------------------------------ types

  private skipBalanced(open: string): void {
    if (!this.is(open)) this.error(`Expected '${open}'`);
    const close = this.matching(this.p);
    if (close < 0) this.error(`Unclosed '${open}'`);
    this.p = close + 1;
  }

  private typeParams(): void {
    this.expect('<');
    while (!this.is('>')) {
      if (this.t.kind === 'eof') this.error("Expected '>'");
      this.eat('const');
      this.eat('in');
      this.eat('out');
      this.next(); // name
      if (this.eat('extends')) this.type();
      if (this.eat('=')) this.type();
      if (!this.is('>')) this.expect(',');
    }
    this.next();
  }

  private typeArguments(): void {
    this.expect('<');
    while (!this.is('>')) {
      if (this.t.kind === 'eof') this.error("Expected '>'");
      this.type();
      if (!this.is('>')) this.expect(',');
    }
    this.next();
  }

  private typeReference(): void {
    this.next();
    while (this.is('.')) {
      this.next();
      this.next();
    }
    if (this.is('<')) this.typeArguments();
  }

  /** Consumes one type. */
  private type(noConditional = false): void {
    if (noConditional && !this.is('<') && !this.is('new') && !this.is('(')) return this.unionType(true);
    if (this.is('<')) {
      // Generic function type: <T>(x: T) => T
      this.typeParams();
      this.skipBalanced('(');
      this.expect('=>');
      return this.returnType();
    }
    if (this.is('new') || (this.is('abstract') && this.is('new', this.peek()))) {
      this.eat('abstract');
      this.next();
      if (this.is('<')) this.typeParams();
      this.skipBalanced('(');
      this.expect('=>');
      return this.type();
    }
    if (this.is('(') && this.isFunctionType()) {
      this.skipBalanced('(');
      this.expect('=>');
      return this.returnType();
    }
    this.unionType();
    if (!noConditional && this.is('extends') && !this.t.nl) {
      this.next();
      this.type(true);
      this.expect('?');
      this.type();
      this.expect(':');
      this.type();
    }
  }

  private isFunctionType(): boolean {
    const close = this.matching(this.p);
    return close >= 0 && this.is('=>', this.toks[close + 1]);
  }

  private unionType(noConditional = false): void {
    if (this.is('|') || this.is('&')) this.next();
    for (;;) {
      this.operatorType(noConditional);
      if (this.is('|') || this.is('&')) {
        this.next();
        continue;
      }
      return;
    }
  }

  private operatorType(noConditional: boolean): void {
    while ((this.is('keyof') || this.is('unique') || this.is('readonly')) && this.peek().kind !== 'eof' && !this.is(',', this.peek()) && !this.is('>', this.peek()) && !this.is(')', this.peek()) && !this.is(']', this.peek()) && !this.is('=', this.peek()) && !this.is(';', this.peek())) this.next();
    if (this.is('infer')) {
      this.next();
      this.next();
      if (this.is('extends') && noConditional) {
        this.next();
        this.type(true);
      }
    } else this.primaryType();
    // Array / indexed access: no line break before `[`.
    while (this.is('[') && !this.t.nl) this.skipBalanced('[');
  }

  private primaryType(): void {
    const t = this.t;
    if (t.kind === 'punct') {
      if (t.value === '(' || t.value === '[' || t.value === '{') return this.skipBalanced(t.value);
      if (t.value === '-' && this.peek().kind === 'number') {
        this.next();
        this.next();
        return;
      }
      this.error(`Expected a type but found ${this.describe(t)}`);
    }
    if (t.kind === 'string' || t.kind === 'number') return void this.next();
    if (t.kind === 'template') {
      this.next();
      if (t.value.endsWith('${')) {
        for (;;) {
          this.type();
          const m = this.t;
          if (m.kind !== 'template') this.error('Unterminated template literal type');
          this.next();
          if (m.value.endsWith('`')) break;
        }
      }
      return;
    }
    if (t.kind === 'eof') this.error('Expected a type but found end of file');
    if (this.is('typeof')) {
      this.next();
      if (this.is('import')) {
        this.next();
        this.skipBalanced('(');
      } else this.next();
      while (this.is('.') || this.is('?.')) {
        this.next();
        this.next();
      }
      if (this.is('<') && !this.t.nl) this.typeArguments();
      return;
    }
    if (this.is('import') && this.is('(', this.peek())) {
      this.next();
      this.skipBalanced('(');
      while (this.eat('.')) this.next();
      if (this.is('<')) this.typeArguments();
      return;
    }
    if (t.kind === 'regex') this.error(`Expected a type but found ${this.describe(t)}`);
    this.next();
    while (this.is('.') && !this.t.nl) {
      this.next();
      this.next();
    }
    if (this.is('<') && !this.t.nl) this.typeArguments();
  }
}

function contextualIdent(word: string): boolean {
  // Keywords in KEYWORDS that are ordinary identifiers in most positions.
  return [
    'of', 'get', 'set', 'static', 'async', 'await', 'let', 'type', 'interface', 'declare', 'abstract', 'implements', 'private', 'protected',
    'public', 'readonly', 'namespace', 'module', 'keyof', 'infer', 'is', 'as', 'satisfies', 'override', 'unique', 'asserts', 'enum',
  ].includes(word);
}
