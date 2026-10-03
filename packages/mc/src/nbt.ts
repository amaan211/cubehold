/**
 * Minecraft NBT, in both of its forms:
 *  - binary (player .dat files, gzip-compressed, big-endian), and
 *  - SNBT, the text form that `/data get entity` prints.
 * Both parse to plain JS values: compounds become objects, lists and arrays
 * become arrays, every number becomes a number (longs lose precision past
 * 2^53, which nothing here needs), and SNBT booleans stay booleans.
 */

export type NbtValue = number | boolean | string | NbtValue[] | NbtCompound;
export interface NbtCompound {
  [key: string]: NbtValue;
}

// --- binary ----------------------------------------------------------------------

class Reader {
  pos = 0;
  constructor(private readonly buf: Buffer) {}
  byte(): number {
    return this.buf.readInt8(this.pos++);
  }
  ubyte(): number {
    return this.buf.readUInt8(this.pos++);
  }
  short(): number {
    const v = this.buf.readInt16BE(this.pos);
    this.pos += 2;
    return v;
  }
  ushort(): number {
    const v = this.buf.readUInt16BE(this.pos);
    this.pos += 2;
    return v;
  }
  int(): number {
    const v = this.buf.readInt32BE(this.pos);
    this.pos += 4;
    return v;
  }
  long(): number {
    const v = this.buf.readBigInt64BE(this.pos);
    this.pos += 8;
    return Number(v);
  }
  float(): number {
    const v = this.buf.readFloatBE(this.pos);
    this.pos += 4;
    return v;
  }
  double(): number {
    const v = this.buf.readDoubleBE(this.pos);
    this.pos += 8;
    return v;
  }
  /** Java's "modified UTF-8": plain UTF-8 except NUL and astral characters (surrogate pairs). */
  string(): string {
    const len = this.ushort();
    const end = this.pos + len;
    let out = "";
    while (this.pos < end) {
      const a = this.buf[this.pos++] as number;
      if (a < 0x80) out += String.fromCharCode(a);
      else if ((a & 0xe0) === 0xc0) {
        const b = this.buf[this.pos++] as number;
        out += String.fromCharCode(((a & 0x1f) << 6) | (b & 0x3f));
      } else {
        const b = this.buf[this.pos++] as number;
        const c = this.buf[this.pos++] as number;
        out += String.fromCharCode(((a & 0x0f) << 12) | ((b & 0x3f) << 6) | (c & 0x3f));
      }
    }
    return out;
  }
}

function readPayload(r: Reader, type: number, depth: number): NbtValue {
  if (depth > 512) throw new Error("NBT nested too deeply");
  switch (type) {
    case 1:
      return r.byte();
    case 2:
      return r.short();
    case 3:
      return r.int();
    case 4:
      return r.long();
    case 5:
      return r.float();
    case 6:
      return r.double();
    case 7: {
      const n = r.int();
      return Array.from({ length: n }, () => r.byte());
    }
    case 8:
      return r.string();
    case 9: {
      const itemType = r.ubyte();
      const n = r.int();
      const out: NbtValue[] = [];
      for (let i = 0; i < n; i++) out.push(readPayload(r, itemType, depth + 1));
      return out;
    }
    case 10: {
      const obj: NbtCompound = {};
      for (;;) {
        const t = r.ubyte();
        if (t === 0) return obj;
        const name = r.string();
        obj[name] = readPayload(r, t, depth + 1);
      }
    }
    case 11: {
      const n = r.int();
      return Array.from({ length: n }, () => r.int());
    }
    case 12: {
      const n = r.int();
      return Array.from({ length: n }, () => r.long());
    }
    default:
      throw new Error(`Unknown NBT tag type ${type}`);
  }
}

/** Parse uncompressed binary NBT (gunzip player files first). Returns the root compound. */
export function parseNbt(buf: Buffer): NbtCompound {
  const r = new Reader(buf);
  const type = r.ubyte();
  if (type !== 10) throw new Error("NBT root is not a compound");
  r.string(); // root name, usually empty
  return readPayload(r, 10, 0) as NbtCompound;
}

// --- SNBT -------------------------------------------------------------------------

const UNQUOTED = /[A-Za-z0-9._+-]/;
const NUMBER =
  /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?([bBsSlLfFdD]|[uU][bBsSiIlL]|[sS][bBsSiIlL])?$/;

class SnbtParser {
  pos = 0;
  constructor(private readonly s: string) {}

  parse(): NbtValue {
    const v = this.value(0);
    this.ws();
    return v;
  }

  ws(): void {
    while (this.pos < this.s.length && /\s/.test(this.s[this.pos] as string)) this.pos++;
  }

  peek(): string {
    return this.s[this.pos] ?? "";
  }

  expect(ch: string): void {
    this.ws();
    if (this.s[this.pos] !== ch) {
      throw new Error(`SNBT: expected "${ch}" at ${this.pos}, found "${this.peek()}"`);
    }
    this.pos++;
  }

  value(depth: number): NbtValue {
    if (depth > 512) throw new Error("SNBT nested too deeply");
    this.ws();
    const ch = this.peek();
    if (ch === "{") return this.compound(depth);
    if (ch === "[") return this.list(depth);
    if (ch === '"' || ch === "'") return this.quoted();
    return this.scalar(this.unquoted());
  }

  compound(depth: number): NbtCompound {
    this.expect("{");
    const obj: NbtCompound = {};
    this.ws();
    if (this.peek() === "}") {
      this.pos++;
      return obj;
    }
    for (;;) {
      this.ws();
      const key = this.peek() === '"' || this.peek() === "'" ? this.quoted() : this.unquoted();
      this.expect(":");
      obj[key] = this.value(depth + 1);
      this.ws();
      if (this.peek() === ",") {
        this.pos++;
        continue;
      }
      this.expect("}");
      return obj;
    }
  }

  list(depth: number): NbtValue[] {
    this.expect("[");
    this.ws();
    // Typed arrays: [B; 1b, 2b], [I; 1, 2], [L; 1L]
    if (/[BIL]/.test(this.peek()) && this.s[this.pos + 1] === ";") this.pos += 2;
    const out: NbtValue[] = [];
    this.ws();
    if (this.peek() === "]") {
      this.pos++;
      return out;
    }
    for (;;) {
      out.push(this.value(depth + 1));
      this.ws();
      if (this.peek() === ",") {
        this.pos++;
        this.ws();
        if (this.peek() === "]") {
          this.pos++;
          return out; // trailing comma
        }
        continue;
      }
      this.expect("]");
      return out;
    }
  }

  quoted(): string {
    const q = this.s[this.pos++] as string;
    let out = "";
    while (this.pos < this.s.length) {
      const c = this.s[this.pos++] as string;
      if (c === q) return out;
      if (c !== "\\") {
        out += c;
        continue;
      }
      const e = this.s[this.pos++] as string;
      if (e === "n") out += "\n";
      else if (e === "t") out += "\t";
      else if (e === "r") out += "\r";
      else if (e === "b") out += "\b";
      else if (e === "f") out += "\f";
      else if (e === "s") out += " ";
      else if (e === "x") {
        out += String.fromCharCode(Number.parseInt(this.s.slice(this.pos, this.pos + 2), 16));
        this.pos += 2;
      } else if (e === "u") {
        out += String.fromCharCode(Number.parseInt(this.s.slice(this.pos, this.pos + 4), 16));
        this.pos += 4;
      } else out += e;
    }
    throw new Error("SNBT: unterminated string");
  }

  unquoted(): string {
    const start = this.pos;
    while (this.pos < this.s.length && UNQUOTED.test(this.s[this.pos] as string)) this.pos++;
    if (this.pos === start) throw new Error(`SNBT: unexpected "${this.peek()}" at ${this.pos}`);
    return this.s.slice(start, this.pos);
  }

  scalar(token: string): NbtValue {
    if (token === "true") return true;
    if (token === "false") return false;
    const m = NUMBER.exec(token);
    if (!m) return token; // an unquoted string
    const suffix = m[1] ?? "";
    return Number(suffix ? token.slice(0, -suffix.length) : token);
  }
}

export function parseSnbt(text: string): NbtValue {
  return new SnbtParser(text).parse();
}

/**
 * The value in "Steve has the following entity data: 20.0f". Undefined when
 * the path matched nothing, or when the server shortened the output: Paper
 * cuts long values off with "...", so only small fields can be read this way.
 */
export function parseDataReply(reply: string): NbtValue | undefined {
  const plain = reply.replace(/§./g, "");
  const m = /has the following entity data: ([\s\S]*)$/.exec(plain);
  const text = m?.[1]?.trim();
  if (!text || text.endsWith("...")) return undefined;
  try {
    return parseSnbt(text);
  } catch {
    return undefined;
  }
}

/** UUID from its int-array form ([I; a, b, c, d]). */
export function uuidFromInts(ints: number[]): string | null {
  if (ints.length !== 4) return null;
  const hex = ints.map((n) => (n >>> 0).toString(16).padStart(8, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
