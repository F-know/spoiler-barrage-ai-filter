// B站 protobuf 弹幕段(DmSegMobileReply)最小读写工具。
// 我们只需要:顶层按 field 拆开;每个弹幕项(elem)能读出文本 content 与时间 progress;
// 以及"按文本过滤后字节级重排"——保留非高危 elem 的原始字节,跳过被过滤的。

export type DmElem = {
  /** 该 elem 的完整原始字节(含 wire-tag + len 前缀),重排时原样拷贝 */
  raw: Uint8Array;
  /** 弹幕文本 */
  content: string;
  /** 时间(毫秒,相对视频) */
  progress: number;
};

/** 顶层解析结果:elem 数组 + 其它字段(如 state)的原始字节,重排时一并保留 */
export type SegParse = {
  elems: DmElem[];
  /** 非 elem 的顶层字段(requestId / state 等),原样保留 */
  others: Uint8Array[];
};

function readVarint(bytes: Uint8Array, pos: number): [number, number] {
  // 支持完整 64 位 varint(最多 10 字节)。
  // 原实现 shift>28 就 break,会把长 varint(如弹幕 dmid,int64)截断,
  // 导致后续字段 tag 全部错位 —— 这是 progress 读成 0、字段解析错乱的根因。
  let result = 0;
  let shift = 0;
  let b: number;
  do {
    b = bytes[pos++];
    result += (b & 0x7f) * Math.pow(2, shift);
    shift += 7;
    if (shift > 63) break;
  } while (b & 0x80);
  return [result, pos];
}

function writeVarint(value: number): number[] {
  const out: number[] = [];
  let v = value >>> 0;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
  return out;
}

/** 在 elem 内部扫描字段,取 field7(text) 与 field2(progress, varint 或 4 字节) */
function decodeElemFields(data: Uint8Array): { content: string; progress: number } {
  let content = "";
  let progress = 0;
  let p = 0;
  while (p < data.length) {
    const [tag, q] = readVarint(data, p);
    p = q;
    const wire = tag & 7;
    const field = tag >>> 3;
    if (wire === 2) {
      const [len, q2] = readVarint(data, p);
      p = q2;
      const sub = data.subarray(p, p + len);
      if (field === 7) {
        content = new TextDecoder().decode(sub);
      } else if (field === 2 && len === 4) {
        progress = (sub[0] | (sub[1] << 8) | (sub[2] << 16) | (sub[3] << 24)) >>> 0;
      }
      p += len;
    } else if (wire === 0) {
      const [v, q2] = readVarint(data, p);
      p = q2;
      if (field === 2 && progress === 0) progress = v;
    } else if (wire === 5) {
      p += 4;
    } else if (wire === 1) {
      p += 8;
    } else {
      break;
    }
  }
  return { content, progress };
}

/** 解析顶层 DmSegMobileReply。每个顶层字段记录其完整字节区间(含 tag+len 前缀)。 */
export function parseSegments(buf: Uint8Array): SegParse {
  const elems: DmElem[] = [];
  const others: Uint8Array[] = [];
  let p = 0;
  while (p < buf.length) {
    const start = p;
    const [tag, q] = readVarint(buf, p);
    p = q;
    const wire = tag & 7;
    const field = tag >>> 3;
    if (wire === 2) {
      const [len, q2] = readVarint(buf, p);
      p = q2;
      const end = p + len;
      const segment = buf.subarray(start, end);
      if (field === 1) {
        const payload = buf.subarray(p, end);
        const { content, progress } = decodeElemFields(payload);
        elems.push({ raw: segment, content, progress });
      } else {
        others.push(segment);
      }
      p = end;
    } else if (wire === 0) {
      const [, q2] = readVarint(buf, p);
      p = q2;
      others.push(buf.subarray(start, p));
    } else if (wire === 5) {
      p += 4;
      others.push(buf.subarray(start, p));
    } else if (wire === 1) {
      p += 8;
      others.push(buf.subarray(start, p));
    } else {
      break;
    }
  }
  return { elems, others };
}

/**
 * 用 keep 谓词过滤 elem,重排为新的 DmSegMobileReply 字节。
 * keep(内容, progress) 返回 true 才保留该条;保留者原样拷贝,其余丢弃。
 */
export function rebuildSegment(
  parsed: SegParse,
  keep: (content: string, progress: number) => boolean,
): Uint8Array {
  const parts: number[] = [];
  let total = 0;
  // 先收集
  const kept: Uint8Array[] = [];
  const others: Uint8Array[] = parsed.others;
  for (const e of parsed.elems) {
    if (keep(e.content, e.progress)) kept.push(e.raw);
  }
  const pieces = [...kept, ...others];
  for (const piece of pieces) {
    parts.push(...piece);
    total += piece.length;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const piece of pieces) {
    out.set(piece, off);
    off += piece.length;
  }
  return out;
}

/**
 * 逐条改写弹幕文本。
 * transform(content, progress) 返回:
 *   - 字符串:用该文本替换本条的 content(field7),其余字段(时间/模式等)与其余弹幕原样保留;
 *   - null:本条保持不变。
 * 返回 { out, changed }。用于"屏蔽弹幕改为 <已屏蔽> 占位"场景。
 */
export function transformSegment(
  raw: Uint8Array,
  transform: (content: string, progress: number) => string | null,
): { out: Uint8Array; changed: number } {
  const parsed = parseSegments(raw);
  let changed = 0;
  const rebuilt: Uint8Array[] = [];
  for (const e of parsed.elems) {
    const newText = transform(e.content, e.progress);
    if (newText === null || newText === e.content) {
      rebuilt.push(e.raw);
    } else {
      rebuilt.push(rebuildElemWithText(e.raw, newText));
      changed++;
    }
  }
  const pieces = [...rebuilt, ...parsed.others];
  const total = pieces.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const piece of pieces) {
    out.set(piece, off);
    off += piece.length;
  }
  return { out, changed };
}

/** 重建单个 elem,把其 field7(text) 替换为 newText,其余字段原样。 */
function rebuildElemWithText(raw: Uint8Array, newText: string): Uint8Array {
  // raw = [tag][len][payload...]
  const [, tagEnd] = readVarint(raw, 0);
  const [payloadLen, lenEnd] = readVarint(raw, tagEnd);
  const payloadStart = lenEnd;
  const payload = raw.subarray(payloadStart, payloadStart + payloadLen);
  const newPayload = rewritePayloadText(payload, newText);
  const lenBytes = writeVarint(newPayload.length);
  // 前缀只保留 [field_tag](不含旧 len),随后写新 len + 新 payload
  const prefix = raw.subarray(0, tagEnd);
  const out = new Uint8Array(prefix.length + lenBytes.length + newPayload.length);
  out.set(prefix, 0);
  let off = prefix.length;
  out.set(lenBytes, off);
  off += lenBytes.length;
  out.set(newPayload, off);
  return out;
}

/** 在 elem 的 payload 内逐字段重排,把 field7 的 bytes 换成 newText 的字节。 */
function rewritePayloadText(payload: Uint8Array, newText: string): Uint8Array {
  const newBytes = new TextEncoder().encode(newText);
  const newLenBytes = writeVarint(newBytes.length);
  const parts: (Uint8Array | number[])[] = [];
  let i = 0;
  while (i < payload.length) {
    const fieldStart = i;
    const [tag, tEnd] = readVarint(payload, i);
    i = tEnd;
    const wire = tag & 7;
    const field = tag >>> 3;
    let fieldEnd: number;
    if (wire === 0) {
      const [, vEnd] = readVarint(payload, i);
      fieldEnd = vEnd;
      i = vEnd;
    } else if (wire === 2) {
      const [len, lEnd] = readVarint(payload, i);
      fieldEnd = lEnd + len;
      i = fieldEnd;
    } else if (wire === 5) {
      fieldEnd = i + 4;
      i = fieldEnd;
    } else if (wire === 1) {
      fieldEnd = i + 8;
      i = fieldEnd;
    } else {
      break;
    }
    if (field === 7) {
      // 替换 field7 的字节为新文本(保留原 tag / 新 len / 新内容)
      parts.push(writeVarint(tag));
      parts.push(newLenBytes);
      parts.push(newBytes);
    } else {
      parts.push(payload.subarray(fieldStart, fieldEnd));
    }
  }
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const part of parts) {
    out.set(part, off);
    off += part.length;
  }
  return out;
}

/** 从二进制 byte 序列中按顶层 field1 提取所有弹幕的 content 列表(轻量读取,用于统计/预扫) */
export function listContents(buf: Uint8Array): string[] {
  const parsed = parseSegments(buf);
  return parsed.elems.map((e) => e.content);
}

export { readVarint, writeVarint };
