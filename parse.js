// fastmark — an original, dependency-free Markdown-to-HTML renderer,
// written for make.fun's "Make Markdown rendering faster" bounty.
//
// The renderer reproduces, byte for byte, the output of marked 18.1.3
// running with its default options (GFM enabled, breaks off, pedantic
// off). It is built as two passes over the source: a line-oriented
// block-structure pass that builds a block tree, and an inline pass
// (link resolution, then a scanner producing inline nodes, then
// delimiter processing) that runs when each block is rendered.
//
// parse() is pure per call: all state lives in locals of the call.

// ------------------------------------------------------- character classes

const PUNCT_ASCII = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';

function punctAscii(ch) {
  return ch !== undefined && PUNCT_ASCII.indexOf(ch) !== -1;
}

const RE_PUNCT_UNI = /[\p{P}\p{S}]/u;
const RE_ZS = /\p{Zs}/u;

// Unicode punctuation (CommonMark flanking rules); ASCII fast path first.
function punctCh(ch) {
  if (ch === undefined) return false;
  if (ch.length === 1 && ch.charCodeAt(0) < 128) return PUNCT_ASCII.indexOf(ch) !== -1;
  return RE_PUNCT_UNI.test(ch);
}

// CommonMark whitespace: space, tab, LF, VT, FF, CR, or a Zs character.
// The string boundary (undefined) counts as whitespace.
function spaceCh(ch) {
  if (ch === undefined) return true;
  const cp = ch.codePointAt(0);
  if (cp === 32 || (cp >= 9 && cp <= 13)) return true;
  if (cp < 128) return false;
  return RE_ZS.test(ch);
}

// Full code point (as a string) immediately before / at an index.
function chBefore(s, i) {
  if (i <= 0) return undefined;
  const c = s.charCodeAt(i - 1);
  if (c >= 0xdc00 && c <= 0xdfff && i >= 2) return s.slice(i - 2, i);
  return s[i - 1];
}
function chAt(s, i) {
  if (i >= s.length) return undefined;
  const c = s.charCodeAt(i);
  if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) return s.slice(i, i + 2);
  return s[i];
}

function hexDigit(c) {
  return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
}
function alnumCh(c) {
  return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
}

// ------------------------------------------------------------- HTML output

function escOne(c) {
  switch (c) {
    case '&': return '&amp;';
    case '<': return '&lt;';
    case '>': return '&gt;';
    case '"': return '&quot;';
    case "'": return '&#39;';
    default: return c;
  }
}

// Escape every special character, no exceptions (code blocks, code
// spans, autolink text and hrefs).
function escFull(s) {
  if (!/[&<>"']/.test(s)) return s;
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const e = escOne(s[i]);
    if (e !== s[i]) {
      out += s.slice(start, i) + e;
      start = i + 1;
    }
  }
  return start === 0 ? s : out + s.slice(start);
}

// Examine a '&' at s[i]. When it begins a character reference, return
// { end, decoded } for a numeric reference (decoded is the replacement
// character) or { end, verbatim: true } for a named-reference pattern
// &[A-Za-z0-9]+; (which output passes through untouched, whether or not
// the name is a real HTML entity). Otherwise return null.
function entityAt(s, i) {
  const n = s.length;
  let j = i + 1;
  if (j >= n) return null;
  if (s[j] === '#') {
    j++;
    let hex = false;
    if (j < n && (s[j] === 'x' || s[j] === 'X')) { hex = true; j++; }
    const digitsStart = j;
    if (hex) {
      while (j < n && j - digitsStart < 6 && hexDigit(s[j])) j++;
    } else {
      while (j < n && j - digitsStart < 7 && s[j] >= '0' && s[j] <= '9') j++;
    }
    if (j === digitsStart || s[j] !== ';') return null;
    let v = parseInt(s.slice(digitsStart, j), hex ? 16 : 10);
    if (v === 0 || v > 0x10ffff || (v >= 0xd800 && v <= 0xdfff)) v = 0xfffd;
    return { end: j + 1, decoded: String.fromCodePoint(v) };
  }
  const nameStart = j;
  while (j < n && alnumCh(s[j])) j++;
  if (j === nameStart || s[j] !== ';') return null;
  return { end: j + 1, verbatim: true };
}

// Render a raw source text run as HTML text: backslash escapes of ASCII
// punctuation resolve to the (escaped) punctuation, numeric character
// references decode, named-reference patterns pass through verbatim,
// and the five HTML specials are escaped.
function escTextRun(raw) {
  const n = raw.length;
  let out = '';
  let start = 0;
  let i = 0;
  while (i < n) {
    const c = raw.charCodeAt(i);
    if (c === 92 && i + 1 < n && punctAscii(raw[i + 1])) {
      out += raw.slice(start, i) + escOne(raw[i + 1]);
      i += 2; start = i;
    } else if (c === 38) {
      const m = entityAt(raw, i);
      if (m) {
        out += raw.slice(start, i) + (m.verbatim ? raw.slice(i, m.end) : escOne(m.decoded));
        i = m.end; start = i;
      } else {
        out += raw.slice(start, i) + '&amp;';
        i += 1; start = i;
      }
    } else if (c === 60) { out += raw.slice(start, i) + '&lt;'; i++; start = i; }
    else if (c === 62) { out += raw.slice(start, i) + '&gt;'; i++; start = i; }
    else if (c === 34) { out += raw.slice(start, i) + '&quot;'; i++; start = i; }
    else if (c === 39) { out += raw.slice(start, i) + '&#39;'; i++; start = i; }
    else i++;
  }
  if (start === 0) return raw;
  return out + raw.slice(start);
}

// Text inside a raw <code> or <kbd> HTML element is emitted by marked
// completely unescaped; only backslash escapes still resolve.
function escTextRunRaw(raw) {
  const n = raw.length;
  let out = '';
  let start = 0;
  let i = 0;
  while (i < n) {
    if (raw.charCodeAt(i) === 92 && i + 1 < n && punctAscii(raw[i + 1])) {
      out += raw.slice(start, i) + raw[i + 1];
      i += 2; start = i;
    } else i++;
  }
  if (start === 0) return raw;
  return out + raw.slice(start);
}

// The plain-text form of a raw run (image alt text): backslash escapes
// resolved, numeric references decoded, named patterns kept verbatim.
// With noDecode (inside raw <code>/<kbd>), references stay as written.
function plainRun(raw, noDecode) {
  const n = raw.length;
  let out = '';
  let start = 0;
  let i = 0;
  while (i < n) {
    const c = raw.charCodeAt(i);
    if (c === 92 && i + 1 < n && punctAscii(raw[i + 1])) {
      out += raw.slice(start, i) + raw[i + 1];
      i += 2; start = i;
    } else if (c === 38 && !noDecode) {
      const m = entityAt(raw, i);
      if (m) {
        out += raw.slice(start, i) + (m.verbatim ? raw.slice(i, m.end) : m.decoded);
        i = m.end; start = i;
      } else i++;
    } else i++;
  }
  if (start === 0) return raw;
  return out + raw.slice(start);
}

// Escape an attribute value (href, title, alt): the five specials are
// escaped, but existing character-reference patterns stay untouched.
// No decoding and no backslash processing happen here.
function escAttr(s) {
  const n = s.length;
  let out = '';
  let start = 0;
  let i = 0;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 38) {
      const m = entityAt(s, i);
      if (m) { i = m.end; continue; }
      out += s.slice(start, i) + '&amp;'; i++; start = i;
    } else if (c === 60) { out += s.slice(start, i) + '&lt;'; i++; start = i; }
    else if (c === 62) { out += s.slice(start, i) + '&gt;'; i++; start = i; }
    else if (c === 34) { out += s.slice(start, i) + '&quot;'; i++; start = i; }
    else if (c === 39) { out += s.slice(start, i) + '&#39;'; i++; start = i; }
    else i++;
  }
  if (start === 0) return s;
  return out + s.slice(start);
}

// marked encodes link destinations with encodeURI and then undoes the
// escaping of literal percent signs.
function encodeDest(s) {
  try {
    return encodeURI(s).replace(/%25/g, '%');
  } catch {
    return s;
  }
}

// Resolve backslash escapes of ASCII punctuation (no HTML escaping).
function unescapeBs(s) {
  if (s.indexOf('\\') === -1) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && punctAscii(s[i + 1])) { out += s[i + 1]; i++; }
    else out += s[i];
  }
  return out;
}

// -------------------------------------------------------- link syntax parts

function skipInlineWs(s, i) {
  while (i < s.length && (s[i] === ' ' || s[i] === '\t' || s[i] === '\n')) i++;
  return i;
}

function titleOpener(c) {
  return c === '"' || c === "'" || c === '(';
}

// A link destination at s[i]: either <...> (no newline, no '<' inside)
// or a bare run of non-control characters with balanced parentheses.
// Backslash escapes of punctuation resolve into the value.
// Returns { value, end, angle } or null.
function scanDest(s, i) {
  const n = s.length;
  if (s[i] === '<') {
    let j = i + 1;
    let value = '';
    while (j < n) {
      const c = s[j];
      if (c === '\\' && punctAscii(s[j + 1])) { value += s[j + 1]; j += 2; continue; }
      if (c === '>') return { value, end: j + 1, angle: true };
      if (c === '<' || c === '\n') return null;
      value += c; j++;
    }
    return null;
  }
  let j = i;
  let value = '';
  let depth = 0;
  while (j < n) {
    const c = s[j];
    if (c === '\\' && punctAscii(s[j + 1])) { value += s[j + 1]; j += 2; continue; }
    if (s.charCodeAt(j) <= 32) break;
    if (c === '(') { depth++; value += c; j++; continue; }
    if (c === ')') {
      if (depth === 0) break;
      depth--; value += c; j++; continue;
    }
    value += c; j++;
  }
  if (depth !== 0) return null;
  return { value, end: j, angle: false };
}

// A link title at s[i], delimited by "…", '…' or (…). Parenthesised
// titles may not contain an unescaped '('. Returns { value, end }.
function scanTitle(s, i) {
  const open = s[i];
  const close = open === '(' ? ')' : open;
  let j = i + 1;
  let value = '';
  while (j < s.length) {
    const c = s[j];
    if (c === '\\' && punctAscii(s[j + 1])) { value += s[j + 1]; j += 2; continue; }
    if (c === close) return { value, end: j + 1 };
    if (open === '(' && c === '(') return null;
    value += c; j++;
  }
  return null;
}

// Parse the inside of "( destination title? )" starting just after the
// opening paren. Returns { href, title, end } or null.
function scanInlineLink(s, i) {
  let j = skipInlineWs(s, i);
  if (j >= s.length) return null;
  const dest = scanDest(s, j);
  if (!dest) return null;
  j = dest.end;
  let title = null;
  const beforeWs = j;
  j = skipInlineWs(s, j);
  if (j > beforeWs && titleOpener(s[j])) {
    const t = scanTitle(s, j);
    if (!t) return null;
    title = t.value;
    j = skipInlineWs(s, t.end);
  }
  if (s[j] === ')') return { href: dest.value, title, end: j + 1 };
  return null;
}

// Scan a [...] label whose '[' is at s[i]. Labels hold no unescaped
// brackets and at most 999 characters. Returns { raw, end } or null.
function scanLabel(s, i) {
  let j = i + 1;
  while (j < s.length) {
    const c = s[j];
    if (c === '\\' && punctAscii(s[j + 1])) { j += 2; continue; }
    if (c === '[') return null;
    if (c === ']') {
      const raw = s.slice(i + 1, j);
      if (raw.length > 999) return null;
      return { raw, end: j + 1 };
    }
    j++;
  }
  return null;
}

// Reference labels are keyed the way marked keys them: trimmed,
// internal whitespace runs collapsed to single spaces, and case-folded
// through a lower→upper→lower round trip (which also maps ß to ss,
// final sigma to sigma, and the Latin ligatures to their letters).
function normalizeLabel(raw) {
  return raw.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Parse one link reference definition starting at text[pos].
// Returns { label, href, title, end } or null.
function scanLinkDef(text, pos) {
  const n = text.length;
  let i = pos;
  let spaces = 0;
  while (i < n && text[i] === ' ' && spaces < 3) { i++; spaces++; }
  if (text[i] !== '[') return null;
  const lab = scanLabel(text, i);
  if (!lab) return null;
  if (normalizeLabel(lab.raw) === '') return null;
  i = lab.end;
  if (text[i] !== ':') return null;
  i++;
  // whitespace before the destination, with at most one newline
  while (i < n && (text[i] === ' ' || text[i] === '\t')) i++;
  if (text[i] === '\n') {
    i++;
    while (i < n && (text[i] === ' ' || text[i] === '\t')) i++;
  }
  const dest = scanDest(text, i);
  if (!dest) return null;
  if (!dest.angle && dest.value === '') return null;
  i = dest.end;
  // optional title, separated by whitespace (maybe on the next line);
  // it counts only when nothing but blanks follow it on the line
  let tStart = i;
  while (tStart < n && (text[tStart] === ' ' || text[tStart] === '\t')) tStart++;
  if (text[tStart] === '\n') {
    tStart++;
    while (tStart < n && (text[tStart] === ' ' || text[tStart] === '\t')) tStart++;
  }
  if (tStart > i && titleOpener(text[tStart])) {
    const t = scanTitle(text, tStart);
    if (t) {
      let k = t.end;
      while (k < n && (text[k] === ' ' || text[k] === '\t')) k++;
      if (k >= n) return { label: lab.raw, href: dest.value, title: t.value, end: k };
      if (text[k] === '\n') return { label: lab.raw, href: dest.value, title: t.value, end: k + 1 };
    }
    // title attempt failed: fall through to the no-title check
  }
  let k = i;
  while (k < n && (text[k] === ' ' || text[k] === '\t')) k++;
  if (k >= n) return { label: lab.raw, href: dest.value, title: null, end: k };
  if (text[k] === '\n') return { label: lab.raw, href: dest.value, title: null, end: k + 1 };
  return null;
}

// Peel leading link reference definitions off a paragraph's text.
// Returns { rest, defs } where rest is what remains for display.
function peelDefs(text) {
  let pos = 0;
  const defs = [];
  for (;;) {
    const d = scanLinkDef(text, pos);
    if (!d) break;
    defs.push(d);
    pos = d.end;
  }
  return { rest: text.slice(pos), defs };
}

// ------------------------------------------------------------ inline: <...>

// Parse a CommonMark HTML tag starting at s[i] === '<' (open or closing
// tag, attributes with quoted or unquoted values). Returns the index
// just past the closing '>', or -1 when this is not a valid tag.
function scanTag(s, i) {
  const n = s.length;
  let j = i + 1;
  let closing = false;
  if (s[j] === '/') { closing = true; j++; }
  if (j >= n || !/[A-Za-z]/.test(s[j])) return -1;
  j++;
  while (j < n && /[A-Za-z0-9-]/.test(s[j])) j++;
  if (closing) {
    while (j < n && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++;
    return s[j] === '>' ? j + 1 : -1;
  }
  for (;;) {
    let ws = 0;
    while (j < n && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) { j++; ws++; }
    if (s[j] === '>') return j + 1;
    if (s[j] === '/' && s[j + 1] === '>') return j + 2;
    if (ws === 0) return -1;
    if (j >= n || !/[A-Za-z_:]/.test(s[j])) return -1;
    j++;
    while (j < n && /[A-Za-z0-9_.:-]/.test(s[j])) j++;
    // optional = value (whitespace allowed around the '=')
    let k = j;
    while (k < n && (s[k] === ' ' || s[k] === '\t' || s[k] === '\n')) k++;
    if (s[k] === '=') {
      k++;
      while (k < n && (s[k] === ' ' || s[k] === '\t' || s[k] === '\n')) k++;
      const q = s[k];
      if (q === '"' || q === "'") {
        const e = s.indexOf(q, k + 1);
        if (e === -1) return -1;
        j = e + 1;
      } else {
        let v = k;
        while (v < n && !' \t\n"\'=<>`'.includes(s[v])) v++;
        if (v === k) return -1;
        j = v;
      }
    }
  }
}

const RE_SCHEME_AUTO = /^[A-Za-z][A-Za-z0-9+.-]{1,31}:/;
const RE_EMAIL_AUTO = /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

// Try the constructs that start with '<' at s[i]: comment, CDATA,
// processing instruction, declaration, raw HTML tag, or an <autolink>.
// Returns { node, end } or null (the '<' is literal text).
function scanAngle(s, i) {
  if (s.startsWith('<!--', i)) {
    if (s[i + 4] === '>') return { node: { k: 'html', s: '<!-->' }, end: i + 5 };
    if (s[i + 4] === '-' && s[i + 5] === '>') return { node: { k: 'html', s: '<!--->' }, end: i + 6 };
    const e = s.indexOf('-->', i + 4);
    if (e !== -1) return { node: { k: 'html', s: s.slice(i, e + 3) }, end: e + 3 };
    return null;
  }
  if (s.startsWith('<![CDATA[', i)) {
    const e = s.indexOf(']]>', i + 9);
    if (e !== -1) return { node: { k: 'html', s: s.slice(i, e + 3) }, end: e + 3 };
    return null;
  }
  if (s.startsWith('<?', i)) {
    const e = s.indexOf('?>', i + 2);
    if (e !== -1) return { node: { k: 'html', s: s.slice(i, e + 2) }, end: e + 2 };
    return null;
  }
  if (s[i + 1] === '!' && s[i + 2] >= 'A' && s[i + 2] <= 'Z') {
    const e = s.indexOf('>', i + 2);
    if (e !== -1) return { node: { k: 'html', s: s.slice(i, e + 1) }, end: e + 1 };
    return null;
  }
  const tagEnd = scanTag(s, i);
  if (tagEnd !== -1) return { node: { k: 'html', s: s.slice(i, tagEnd) }, end: tagEnd };
  // autolink candidate: everything up to the next '>'
  const gt = s.indexOf('>', i + 1);
  if (gt !== -1 && gt - i <= 1100) {
    const cand = s.slice(i + 1, gt);
    if (!/[\s<]/.test(cand)) {
      const m = RE_SCHEME_AUTO.exec(cand);
      if (m && m[0].length < cand.length) {
        return { node: { k: 'auto', text: cand, href: cand }, end: gt + 1 };
      }
      if (RE_EMAIL_AUTO.test(cand)) {
        return { node: { k: 'auto', text: cand, href: 'mailto:' + cand }, end: gt + 1 };
      }
    }
  }
  return null;
}

// ------------------------------------------------- GFM extended autolinks

// The preceding-character rule for www. autolinks: the 'www' must start
// a fresh chunk of text — at the start of the input, right after
// whitespace or one of ( * _ ~, right after an escaped character, or
// right after a bracket opener when a ']' still lies ahead. ctx holds
// { textStart, nodes, openers } of the enclosing inline scan.
function wwwPrevOk(s, i, ctx) {
  if (i === 0) return true;
  if (s[i - 1] === '[' && ctx.openers.has(i - 1)) {
    return s.indexOf(']', i) !== -1;
  }
  if (i > ctx.textStart) {
    const p = s[i - 1];
    if (spaceCh(p) || p === '(' || p === '*' || p === '_' || p === '~') return true;
    if (punctAscii(p)) {
      let bs = 0;
      let k = i - 2;
      while (k >= ctx.textStart && s[k] === '\\') { bs++; k--; }
      if (bs % 2 === 1) return true;
    }
    return false;
  }
  const prev = ctx.nodes[ctx.nodes.length - 1];
  if (prev && prev.k === 'text' && (prev.s === '[' || prev.s === '![')) {
    return s.indexOf(']', i) !== -1;
  }
  if (prev && prev.k === 'text') {
    const p = s[i - 1];
    return spaceCh(p) || p === '(' || p === '*' || p === '_' || p === '~';
  }
  return true;
}

// marked matches extended autolinks with a single anchored pattern: a
// mailto:/xmpp: prefixed address, a protocol or www. URL (whose tail
// is then trimmed by repeated backpedalling), or a bare address.
const EMAIL_PATTERN = '[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])';
const URL_AT_RE = new RegExp(
  '(?:mailto:' + EMAIL_PATTERN + '|xmpp:' + EMAIL_PATTERN + '(?:/[A-Za-z0-9@.]+)?)' +
  '|((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\\/\\/|www\\.)(?:[a-zA-Z0-9-]+\\.?)+[^\\s<]*' +
  '|[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])', 'y');
const BACKPEDAL_RE = /(?:[^?!.,:;*_'\"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/;

// Trim a matched URL the way marked does: repeatedly keep the longest
// prefix the backpedal pattern accepts, which drops trailing
// punctuation while respecting parenthesised groups and entities.
function backpedalUrl(raw) {
  let prev = raw;
  for (;;) {
    const m = BACKPEDAL_RE.exec(prev);
    const next = m ? m[0] : '';
    if (next === prev) return prev;
    prev = next;
  }
}

// Try an extended autolink at s[i] with the URL pattern above. Returns
// { node, end, email } or null. Bare addresses report email=true; the
// scanner accepts those only where an address may begin a token —
// addresses starting inside a text run are found through the '@' path
// instead, which sees the whole local part.
function tryUrlAt(s, i) {
  URL_AT_RE.lastIndex = i;
  const m = URL_AT_RE.exec(s);
  if (!m) return null;
  const raw0 = m[0];
  if (m[2] === '@') {
    return { node: { k: 'auto', text: raw0, href: 'mailto:' + raw0 }, end: i + raw0.length, email: true };
  }
  const raw = backpedalUrl(raw0);
  if (raw === '') return null;
  return {
    node: { k: 'auto', text: raw, href: m[1] === 'www.' ? 'http://' + raw : raw },
    end: i + raw.length, email: false,
  };
}

function localChar(c) {
  return alnumCh(c) || c === '.' || c === '-' || c === '_' || c === '+';
}

const EMAIL_TAIL_RE = /@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/y;
const XMPP_RESOURCE_RE = /\/[A-Za-z0-9@.]+/y;

// Try an email extended autolink: s[at] === '@', with the local part in
// the current text run [textStart, at). An optional lowercase mailto:
// or xmpp: prefix directly before the local part joins the link.
// Returns { node, end, linkStart } or null.
function tryEmailAuto(s, at, textStart) {
  let start = at;
  while (start > textStart && localChar(s[start - 1])) start--;
  if (start === at) return null;
  // an escape immediately before the local part swallows its first
  // character when that character is punctuation
  if (start > textStart && s[start - 1] === '\\' && punctAscii(s[start])) {
    let bs = 0;
    let k = start - 1;
    while (k >= textStart && s[k] === '\\') { bs++; k--; }
    if (bs % 2 === 1) {
      start++;
      if (start === at) return null;
    }
  }
  EMAIL_TAIL_RE.lastIndex = at;
  const dm = EMAIL_TAIL_RE.exec(s);
  if (!dm) return null;
  let end = at + dm[0].length;
  let linkStart = start;
  let prefixed = false;
  if (start - textStart >= 7 && s.slice(start - 7, start) === 'mailto:') {
    const before = start - 7;
    if (before === textStart || (!alnumCh(s[before - 1]) && s[before - 1] !== '\\')) {
      prefixed = true; linkStart = before;
    }
  } else if (start - textStart >= 5 && s.slice(start - 5, start) === 'xmpp:') {
    const before = start - 5;
    if (before === textStart || (!alnumCh(s[before - 1]) && s[before - 1] !== '\\')) {
      prefixed = true; linkStart = before;
      if (s[end] === '/') {
        XMPP_RESOURCE_RE.lastIndex = end;
        const rm = XMPP_RESOURCE_RE.exec(s);
        if (rm) end += rm[0].length;
      }
    }
  }
  let text = s.slice(linkStart, end);
  if (prefixed) {
    // prefixed forms go through the same backpedal trimming as URLs
    const trimmed = backpedalUrl(text);
    end = linkStart + trimmed.length;
    text = trimmed;
  }
  return {
    node: { k: 'auto', text, href: prefixed ? text : 'mailto:' + text },
    end,
    linkStart,
  };
}

// ------------------------------------- emphasis and strikethrough matching
//
// marked does not use a CommonMark delimiter stack. For each inline
// context it first builds a length-preserving masked copy of the text
// (resolvable reference links blanked out, code-span interiors turned
// to '+', backslash escapes blanked), then matches emphasis with a
// balance-counting scan over that mask: an opener run is consumed
// against closer runs classified by the characters around them, with
// a rule-of-three adjustment. The code below follows that model.

const CLS_PUNCT = '[\\p{P}\\p{S}]';
const CLS_PUNCT_NT = '(?!~)[\\p{P}\\p{S}]';
const CLS_PSPACE = '[\\s\\p{P}\\p{S}]';
const CLS_PSPACE_NT = '(?!~)[\\s\\p{P}\\p{S}]';
const CLS_NOTPSPACE = '[^\\s\\p{P}\\p{S}]';
const CLS_NOTPSPACE_NT = '(?:[^\\s\\p{P}\\p{S}]|~)';

// Substitute the character-class placeholders in a closer pattern.
// GFM treats '~' as neither punctuation nor an ordinary character in
// the '*' patterns, hence the _NT variants used there.
function fillClasses(template, punct, pspace, notPspace) {
  return template
    .replace(/notPunctSpace/g, notPspace)
    .replace(/punctSpace/g, pspace)
    .replace(/punct/g, punct);
}

// Closer-run patterns. The first two alternatives skip plain text (and
// handle the mixed **a_b_ / __a*b* shapes); the capturing alternatives
// classify a run by its neighbours: groups 3-4 are opener-like (a
// whitespace or punctuation character before the run), groups 5-6 are
// closer-only. Group numbering is significant.
const RDELIM_AST_TEMPLATE = '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])' +
  '|(?!\\*)punct(\\*+)(?=[\\s]|$)' +
  '|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)' +
  '|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)' +
  '|[\\s](\\*+)(?!\\*)(?=punct)' +
  '|(?!\\*)punct(\\*+)(?!\\*)(?=punct)' +
  '|notPunctSpace(\\*+)(?=notPunctSpace)';
const RDELIM_UND_TEMPLATE = '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])' +
  '|(?!_)punct(_+)(?=[\\s]|$)' +
  '|notPunctSpace(_+)(?!_)(?=punctSpace|$)' +
  '|(?!_)punctSpace(_+)(?=notPunctSpace)' +
  '|[\\s](_+)(?!_)(?=punct)' +
  '|(?!_)punct(_+)(?!_)(?=punct)';
const RDELIM_DEL_TEMPLATE = '^[^~]+(?=[^~])' +
  '|(?!~)punct(~~?)(?=[\\s]|$)' +
  '|notPunctSpace(~~?)(?!~)(?=punctSpace|$)' +
  '|(?!~)punctSpace(~~?)(?=notPunctSpace)' +
  '|[\\s](~~?)(?!~)(?=punct)' +
  '|(?!~)punct(~~?)(?!~)(?=punct)' +
  '|notPunctSpace(~~?)(?=notPunctSpace)';

// An opening run plus the character after it: group 1/3 hold that
// character when it is punctuation, group 2/4 otherwise. A run at the
// end of the text or before whitespace matches with all groups empty
// and is rejected by the caller.
const EM_LDELIM_RE = /(?:\*+(?:((?!\*)(?!~)[\p{P}\p{S}])|([^\s*]))?)|_+(?:((?!_)(?!~)[\p{P}\p{S}])|([^\s_]))?/uy;
const EM_RDELIM_AST_RE = new RegExp(fillClasses(RDELIM_AST_TEMPLATE, CLS_PUNCT_NT, CLS_PSPACE_NT, CLS_NOTPSPACE_NT), 'gu');
const EM_RDELIM_UND_RE = new RegExp(fillClasses(RDELIM_UND_TEMPLATE, CLS_PUNCT, CLS_PSPACE, CLS_NOTPSPACE), 'gu');
const DEL_LDELIM_RE = /~~?(?:((?!~)[\p{P}\p{S}])|[^\s~])/uy;
const DEL_RDELIM_RE = new RegExp(fillClasses(RDELIM_DEL_TEMPLATE, CLS_PUNCT, CLS_PSPACE, CLS_NOTPSPACE), 'gu');

// marked's "punctuation" test for the character before a run: a
// whitespace, punctuation or symbol character other than * and _.
const PSPACE_CHAR_RE = /[\s\p{P}\p{S}]/u;
function punctSpaceCh(ch) {
  return ch !== '' && ch !== '*' && ch !== '_' && PSPACE_CHAR_RE.test(ch);
}
const ALNUM_CHAR_RE = /[\p{L}\p{N}]/u;

// ------------------------------------------------------------- the mask

// Reference-link patterns used only by the mask: a link label (which
// may nest one bracket level and hold code spans) and a reference
// label (escape-aware, no brackets).
const LE_RE = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
const LT_RE = /(?:[^\[\]\\`]*(?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/;
const BE_RE = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;
const REFLINK_SEARCH_RE = new RegExp(
  '!?\\[' + LT_RE.source + '\\]\\[' + BE_RE.source + '\\]|!?\\[' + BE_RE.source + '\\](?:\\[\\])?(?!\\()', 'g');
// The inline-link form, used to decide whether a text fragment
// contains a real link (for partial masking of enclosing references).
const LINK_FORM_RE = /^!?\[(?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?\]\([ \t\n]*(?:<(?:\\.|[^\n<>\\])+>|[^\t\n\x00-\x1f]+|(?=\)))(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)))?[ \t\n]*\)/;
// Code spans (delimiter runs kept, interiors blanked) and escapes.
const ANY_PUNCT_OUTSIDE_CODE_RE = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;
// Inline links, code spans and HTML tags: blanked as units.
const BLOCK_SKIP_RE = /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)|(?<!`)()(?<b>`+)[^`]+\k<b>(?!`)|<(?! )[^<>]*?>/g;

// Does this fragment contain a link of its own (an inline link, or a
// reference link that resolves and is not itself nested inside one)?
function linkInText(e, refs) {
  if (e.indexOf('[') === -1) return false;
  BLOCK_SKIP_RE.lastIndex = 0;
  for (const m of e.matchAll(BLOCK_SKIP_RE)) {
    if (LINK_FORM_RE.test(m[0]) && e.charAt(m.index - 1) !== '!') return true;
  }
  REFLINK_SEARCH_RE.lastIndex = 0;
  for (const m of e.matchAll(REFLINK_SEARCH_RE)) {
    const s = m[0];
    const r = s.lastIndexOf('[');
    if (!(s.charAt(0) === '!' || !refs.has(normalizeLabel(s.slice(r + 1, -1)))) &&
        !(r > 1 && linkInText(s.slice(1, r - 1), refs))) return true;
  }
  return false;
}

// One masking step for reference links: a match whose label resolves
// is blanked to [aaa...]; a non-image full reference whose text holds
// a link of its own keeps its (recursively masked) text and blanks
// only the label part.
function maskRefReplace(r, refs) {
  const o = r.lastIndexOf('[');
  if (!refs.has(normalizeLabel(r.slice(o + 1, -1)))) return r;
  if (o > 1 && r.charAt(0) !== '!') {
    const inner = r.slice(1, o - 1);
    if (linkInText(inner, refs)) {
      return '[' + inner.replace(REFLINK_SEARCH_RE, (m) => maskRefReplace(m, refs)) +
        '][' + 'a'.repeat(r.length - o - 2) + ']';
    }
  }
  return '[' + 'a'.repeat(r.length - 2) + ']';
}

// Build the masked copy of an inline text: same length, with every
// region marked treats as opaque replaced by inert characters.
function buildMask(text, refs) {
  let t = text;
  if (text.indexOf('[') !== -1) {
    t = t.replace(REFLINK_SEARCH_RE, (r) => maskRefReplace(r, refs));
  }
  t = t.replace(ANY_PUNCT_OUTSIDE_CODE_RE, (m, run, esc) =>
    esc ? '+'.repeat(m.length)
      : run ? run + m.slice(run.length, -run.length).replace(/`/g, '+') + run
      : m);
  t = t.replace(BLOCK_SKIP_RE, (m, ga, gb) => {
    const o = gb ? gb.length : 0;
    return m.slice(0, o) + '[' + 'a'.repeat(m.length - o - 2) + ']';
  });
  return t;
}

// The last index of each delimiter character whose run could close a
// span: a run start whose preceding character is not blank (a run at
// index 0 counts its predecessor as a newline, so never qualifies).
function computeLastCloser(a) {
  const last = { '*': -1, '_': -1, '~': -1 };
  const n = a.length;
  for (let s = 0; s < n; s++) {
    const r = a[s];
    if (r !== '*' && r !== '_' && r !== '~') continue;
    const before = s === 0 ? '\n' : a[s - 1];
    let i = s + 1;
    while (i < n && a[i] === r) i++;
    if (before !== ' ' && before !== '\t' && before !== '\n' &&
        before !== '\r' && before !== '\f') last[r] = s;
    s = i - 1;
  }
  return last;
}

// The full code point (as a string) ending at index i of s.
function codePointBefore(s, i) {
  if (i <= 0) return '';
  const c = s.charCodeAt(i - 1);
  if (c >= 0xdc00 && c <= 0xdfff && i >= 2) {
    const c2 = s.charCodeAt(i - 2);
    if (c2 >= 0xd800 && c2 <= 0xdbff) return s.slice(i - 2, i);
  }
  return s[i - 1];
}

// The prevChar value marked's lexer would report after consuming a
// plain-text segment: text is lexed in chunks that end before stop
// characters, an escape is its own token (and the next construct then
// sees a blank prevChar), and a chunk ending in '_' leaves the
// previous value in place.
function prevCharOfRun(seg) {
  let r = '';
  let pendingReset = false;
  let i = 0;
  const n = seg.length;
  while (i < n) {
    if (seg[i] === '\\' && i + 1 < n && punctAscii(seg[i + 1])) {
      pendingReset = true;
      i += 2;
      continue;
    }
    if (pendingReset) { r = ''; pendingReset = false; }
    let j = i + 1;
    while (j < n) {
      const d = seg[j];
      if (d === '\\' || d === '<' || d === '!' || d === '[' || d === '`' ||
          d === '*' || d === '_' || d === '~') break;
      j++;
    }
    const last = seg[j - 1];
    if (last !== '_') r = last;
    i = j;
  }
  if (pendingReset) r = '';
  return r;
}

// Try to match emphasis or strong at the '*'/'_' run starting at pos.
// Returns { kind, content, len } or null.
function tryEmStrong(text, masked, lastCloser, pos, prevChar) {
  EM_LDELIM_RE.lastIndex = pos;
  const s = EM_LDELIM_RE.exec(text);
  if (!s || (!s[1] && !s[2] && !s[3] && !s[4])) return null;
  const r = s[0][0];
  const sameChar = prevChar === r;
  let back = pos;
  while (back > 0 && masked[back - 1] === r) back--;
  const p = codePointBefore(masked, back);
  const pPunct = p === '*' || p === '_' || punctSpaceCh(p);
  let before = prevChar;
  if (back < pos) before = p;
  const beforePunct = back < pos ? pPunct : punctSpaceCh(before);
  if (s[4] && ALNUM_CHAR_RE.test(before)) return null;
  const after = s[1] || s[3] || '';
  if (!(!after || !before || beforePunct)) return null;
  const open = [...s[0]].length - 1;
  let balance = open;
  let spare = 0;
  const runTotal = pos - back + open;
  const canShorten = !!p.trim() && (!!after || (r === '*' && !pPunct));
  const closerRe = r === '*' ? EM_RDELIM_AST_RE : EM_RDELIM_UND_RE;
  const lastIdx = lastCloser[r];
  if (lastIdx < pos + open) return null;
  const rest = masked.slice(pos + open);
  const limit = lastIdx - (pos + open);
  closerRe.lastIndex = 0;
  let m;
  while ((m = closerRe.exec(rest)) !== null && !(m.index > limit)) {
    const g = m[1] || m[2] || m[3] || m[4] || m[5] || m[6];
    if (!g) continue;
    const b = [...g].length;
    if (m[3] || m[4]) { balance += b; continue; }
    if (m[5] || m[6] || canShorten) {
      if (sameChar && (m[5] || m[6])) break;
      if (runTotal % 3 && !((runTotal + b) % 3)) { spare += b; continue; }
    }
    balance -= b;
    if (balance > 0) continue;
    const used = Math.min(b, b + balance + spare);
    const head = [...m[0]][0].length;
    const rawLen = open + m.index + head + used;
    const kind = Math.min(open, used) % 2 ? 'em' : 'strong';
    const content = kind === 'em'
      ? text.slice(pos + 1, pos + rawLen - 1)
      : text.slice(pos + 2, pos + rawLen - 2);
    return { kind, content, len: rawLen };
  }
  return null;
}

// Try to match strikethrough at the '~' run starting at pos. Only
// runs of the opener's exact length take part in the balance count.
// Returns { content, len } or null.
function tryDel(text, masked, lastCloser, pos, prevChar) {
  DEL_LDELIM_RE.lastIndex = pos;
  const s = DEL_LDELIM_RE.exec(text);
  if (!s) return null;
  if (s[1] && prevChar && !punctSpaceCh(prevChar)) return null;
  const open = [...s[0]].length - 1;
  let balance = open;
  const lastIdx = lastCloser['~'];
  if (lastIdx < pos + open) return null;
  const rest = masked.slice(pos + open);
  const limit = lastIdx - (pos + open);
  DEL_RDELIM_RE.lastIndex = 0;
  let m;
  while ((m = DEL_RDELIM_RE.exec(rest)) !== null && !(m.index > limit)) {
    const g = m[1] || m[2] || m[3] || m[4] || m[5] || m[6];
    if (!g) continue;
    const len = [...g].length;
    if (len !== open) continue;
    if (m[3] || m[4]) { balance += len; continue; }
    balance -= len;
    if (balance > 0) continue;
    const used = Math.min(len, len + balance);
    const head = [...m[0]][0].length;
    const rawLen = open + m.index + head + used;
    return { content: text.slice(pos + open, pos + rawLen - open), len: rawLen };
  }
  return null;
}

// ------------------------------------------------- link resolution pass

// Find the close of the code span whose opening run (length len) ends
// at `from`: the next run of exactly len backticks. -1 when none.
function codeSpanClose(s, from, len) {
  let j = from;
  while (j < s.length) {
    if (s[j] === '`') {
      let m = 1;
      while (s[j + m] === '`') m++;
      if (m === len) return j;
      j += m;
    } else j++;
  }
  return -1;
}

// Where does the label opened just before `from` end, under marked's
// label matching? Bracket depth counts normally, except that backtick
// runs interact in pairs: two runs are both skipped over whenever the
// second is not preceded (at depth 0) by the label's closing bracket —
// regardless of whether their lengths agree.
function labelExtent(s, from) {
  const n = s.length;
  // fast path: the label closes before any backtick appears
  {
    let depth = 0;
    let i = from;
    let bt = false;
    while (i < n) {
      const c = s[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '`') { bt = true; break; }
      if (c === '[') depth++;
      else if (c === ']') { if (depth === 0) return i; depth--; }
      i++;
    }
    if (!bt) return -1;
  }
  let depth = 0;
  let i = from;
  while (i < n) {
    const c = s[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '`') {
      let j = i + 1;
      while (j < n && s[j] === '`') j++;
      const len = j - i;
      // a run of >= 2 backticks directly before ']' stands alone
      if (len >= 2 && s[j] === ']') { i = j; continue; }
      // Otherwise the run opens a code-span segment of the label
      // pattern: it ends at the next backtick run, whatever that
      // run's length and whatever brackets or ']'s lie between.
      let k = j;
      let nextEnd = -1;
      while (k < n) {
        if (s[k] === '`') {
          let m = k + 1;
          while (m < n && s[m] === '`') m++;
          nextEnd = m;
          break;
        }
        k++;
      }
      if (nextEnd !== -1) { i = nextEnd; continue; }
      i = j;
      continue;
    }
    if (c === '[') { depth++; i++; continue; }
    if (c === ']') { if (depth === 0) return i; depth--; i++; continue; }
    i++;
  }
  return -1;
}

// End of the parenthesised group that starts just before `from`
// (s[from - 1] === '('), honouring nesting, escapes and quoted strings.
function parenGroupEnd(s, from) {
  let depth = 1;
  let i = from;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '"' || c === "'") {
      const q = c;
      i++;
      while (i < n && s[i] !== q && s[i] !== '\n') { if (s[i] === '\\') i++; i++; }
      i++;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return i + 1; }
    i++;
  }
  return -1;
}

function labelHasBracket(s, from, to) {
  let i = from;
  while (i < to) {
    if (s[i] === '\\') { i += 2; continue; }
    if (s[i] === '[') return true;
    i++;
  }
  return false;
}

// marked pairs up a label's backtick runs; an odd leftover run poisons
// the fancy link forms — unless the leftover is a run of >= 2 backticks
// ending exactly at the label's end.
function labelPoisoned(s, from, to) {
  let count = 0;
  let lastLen = 0;
  let lastEnd = -1;
  let i = from;
  while (i < to) {
    const c = s[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '`') {
      let j = i + 1;
      while (j < to && s[j] === '`') j++;
      count++;
      lastLen = j - i;
      lastEnd = j;
      i = j;
      continue;
    }
    i++;
  }
  if (count % 2 === 0) return false;
  return !(lastLen >= 2 && lastEnd === to);
}

// Pre-pass over a block's inline text deciding, for every bracket,
// whether it forms a link or image (and with what target). Mirrors
// marked's label matcher: labels end where labelExtent says, poisoned
// labels lose the fancy forms, and a formed link deactivates earlier
// link openers. Also collects "kill" ranges — the interiors of failed
// ](...) attempts whose emphasis delimiters marked leaves inert — and
// the set of bracket opener positions (for the www. autolink rule).
function resolveLinks(s, refs) {
  const formed = new Map();
  const kills = [];
  const openers = new Set();
  const stack = [];
  const n = s.length;
  let i = 0;
  while (i < n) {
    const c = s[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '`') {
      let m = 1;
      while (s[i + m] === '`') m++;
      const close = codeSpanClose(s, i + m, m);
      if (close === -1) { i += m; continue; }
      if (stack.length > 0) {
        const le = stack[stack.length - 1].labelEnd;
        if (le !== -1 && close + m > le) { i += m; continue; }
      }
      i = close + m;
      continue;
    }
    if (c === '<') {
      const r = scanAngle(s, i);
      if (r) { i = r.end; continue; }
      i++;
      continue;
    }
    if (c === '!' && s[i + 1] === '[') {
      const cs = i + 2;
      const le = labelExtent(s, cs);
      stack.push({ start: i, contentStart: cs, isImage: true, active: true, labelEnd: le });
      openers.add(i + 1);
      i += 2;
      continue;
    }
    if (c === '[') {
      const cs = i + 1;
      const le = labelExtent(s, cs);
      stack.push({ start: i, contentStart: cs, isImage: false, active: true, labelEnd: le });
      openers.add(i);
      i += 1;
      continue;
    }
    if (c === ']' && stack.length > 0 && stack[stack.length - 1].labelEnd === i) {
      const op = stack.pop();
      let form = null;
      if (op.active) {
        const after = i + 1;
        const poison = labelPoisoned(s, op.contentStart, i);
        let href = null;
        let title = null;
        let end = -1;
        let triedLabel = false;
        if (!poison && s[after] === '(') {
          const r = scanInlineLink(s, after + 1);
          if (r) { href = r.href; title = r.title; end = r.end; }
        } else if (poison && s[after] === '[' && s[after + 1] === ']') {
          const key = normalizeLabel(s.slice(op.contentStart, i));
          const def = key !== '' ? refs.get(key) : undefined;
          if (def) { href = def.href; title = def.title; end = after + 2; }
        } else if (!poison && s[after] === '[') {
          const lab = scanLabel(s, after);
          if (lab) {
            triedLabel = true;
            let key = normalizeLabel(lab.raw);
            if (key === '') key = normalizeLabel(s.slice(op.contentStart, i));
            const def = key !== '' ? refs.get(key) : undefined;
            if (def) { href = def.href; title = def.title; end = lab.end; }
          }
        }
        if (end === -1 && !triedLabel) {
          const key = normalizeLabel(s.slice(op.contentStart, i));
          const def = key !== '' ? refs.get(key) : undefined;
          if (def) { href = def.href; title = def.title; end = after; }
        }
        if (end !== -1) {
          form = { end, href, title, isImage: op.isImage, contentStart: op.contentStart, labelEnd: i };
        } else if (s[after] === '(' && parenGroupEnd(s, after + 1) !== -1 &&
                   !labelHasBracket(s, op.contentStart, i)) {
          kills.push([op.contentStart, i]);
        }
      }
      if (form) {
        formed.set(op.start + (op.isImage ? 1 : 0), form);
        if (!op.isImage) {
          for (const b of stack) if (!b.isImage) b.active = false;
        }
        i = form.end;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  return { formed, kills, openers };
}

// ------------------------------------------------------- inline scanner

// Index of the next character at or after i that the scanner must stop
// for; everything before it is plain text. Extended-autolink triggers
// (@, www., http://, ftp://) only count when autolinks are live.
function nextSpecial(text, i, n, autolinksOn) {
  let j = i;
  while (j < n) {
    const cc = text.charCodeAt(j);
    if (cc === 92 || cc === 96 || cc === 60 || cc === 91 || cc === 42 ||
        cc === 95 || cc === 126 || cc === 10 || cc === 33) break;
    if (autolinksOn) {
      if (cc === 64) break; // '@'
      if (cc === 119) { // 'w': only a real www. start stops the run
        if (text.charCodeAt(j + 1) === 119 && text.charCodeAt(j + 2) === 119 &&
            text.charCodeAt(j + 3) === 46) break;
      } else if (cc === 104 || cc === 72) { // 'h' / 'H': only http
        if ((text.charCodeAt(j + 1) | 32) === 116 &&
            (text.charCodeAt(j + 2) | 32) === 116 &&
            (text.charCodeAt(j + 3) | 32) === 112) break;
      } else if (cc === 102 || cc === 70) { // 'f' / 'F': only ftp://
        if ((text.charCodeAt(j + 1) | 32) === 116 &&
            (text.charCodeAt(j + 2) | 32) === 112 &&
            text.charCodeAt(j + 3) === 58 && text.charCodeAt(j + 4) === 47 &&
            text.charCodeAt(j + 5) === 47) break;
      }
    }
    j++;
  }
  return j;
}

const NO_FORMED = new Map();
const NO_OPENERS = new Set();

// Parse a block's inline text into a node list. env is the per-document
// inline environment: { refs, inLink } — inLink records that an <a> tag
// (or an enclosing link label) currently suppresses extended autolinks.
function parseInlineText(text, env) {
  const nodes = [];
  const n = text.length;
  let formed = NO_FORMED, openers = NO_OPENERS;
  if (text.indexOf('[') !== -1) {
    const r = resolveLinks(text, env.refs);
    formed = r.formed; openers = r.openers;
  }
  // When the text holds a delimiter character, marked builds its
  // emphasis mask (and the last-possible-closer table from it) once
  // for the whole context; emphasis matching then works on the mask.
  let masked = text;
  let lastCloser = null;
  if (text.indexOf('*') !== -1 || text.indexOf('_') !== -1 || text.indexOf('~') !== -1) {
    masked = buildMask(text, env.refs);
    lastCloser = computeLastCloser(masked);
  }
  // a hard break is only produced when some non-whitespace content
  // follows it in this text
  let lastContent = n - 1;
  while (lastContent >= 0 && (text[lastContent] === ' ' || text[lastContent] === '\t')) lastContent--;

  let i = 0;
  let textStart = 0;
  const flushText = (end) => {
    if (end > textStart) nodes.push({ k: 'text', s: text.slice(textStart, end) });
  };
  const prevChar = () => prevCharOfRun(text.slice(textStart, i));

  while (i < n) {
    const ni = nextSpecial(text, i, n, !env.inLink);
    if (ni > i) { i = ni; if (i >= n) break; }
    const c = text[i];
    if (c === '\\') {
      const d = text[i + 1];
      if (d === '\n' && lastContent > i + 1) {
        flushText(i);
        nodes.push({ k: 'br' });
        i += 2;
        while (text[i] === ' ' || text[i] === '\t') i++;
        textStart = i;
      } else if (d !== undefined && punctAscii(d)) {
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }
    if (c === '`') {
      let m = 1;
      while (text[i + m] === '`') m++;
      const close = codeSpanClose(text, i + m, m);
      if (close === -1) { i += m; continue; }
      flushText(i);
      let content = text.slice(i + m, close).replace(/\n/g, ' ');
      if (content.length >= 2 && content[0] === ' ' &&
          content[content.length - 1] === ' ' && /[^ ]/.test(content)) {
        content = content.slice(1, -1);
      }
      nodes.push({ k: 'code', s: content });
      i = close + m; textStart = i;
      continue;
    }
    if (c === '<') {
      const r = scanAngle(text, i);
      if (r) {
        flushText(i);
        nodes.push(r.node);
        if (r.node.k === 'html') {
          const raw = r.node.s;
          if (/^<a /i.test(raw)) env.inLink = true;
          else if (/^<\/a(?=[\s/>])/i.test(raw)) env.inLink = false;
        }
        i = r.end; textStart = i;
        continue;
      }
      i++; continue;
    }
    if (c === '!' && text[i + 1] === '[' && formed.has(i + 1)) {
      const f = formed.get(i + 1);
      flushText(i);
      const prevInLink = env.inLink;
      env.inLink = true;
      const inner = parseInlineText(text.slice(f.contentStart, f.labelEnd), env);
      env.inLink = prevInLink;
      nodes.push({ k: 'image', href: f.href, title: f.title, kids: inner });
      i = f.end; textStart = i;
      continue;
    }
    if (c === '[' && formed.has(i)) {
      const f = formed.get(i);
      flushText(i);
      const prevInLink = env.inLink;
      env.inLink = true;
      const inner = parseInlineText(text.slice(f.contentStart, f.labelEnd), env);
      env.inLink = prevInLink;
      nodes.push({ k: 'link', href: f.href, title: f.title, kids: inner });
      i = f.end; textStart = i;
      continue;
    }
    if (c === '*' || c === '_') {
      const r = tryEmStrong(text, masked, lastCloser, i, prevChar());
      if (r) {
        flushText(i);
        nodes.push({ k: r.kind, kids: parseInlineText(r.content, env) });
        i += r.len; textStart = i;
        continue;
      }
      // With no emphasis match, an address may still begin at a '_'
      // (its local part can start with one) — but only where the
      // local part does not extend further left; otherwise the '@'
      // path finds the whole address. Then a single character
      // becomes text and the rest of the run is retried one step on.
      if (c === '_' && !env.inLink && (i === textStart || !localChar(text[i - 1]))) {
        const u = tryUrlAt(text, i);
        if (u && u.email) {
          flushText(i);
          nodes.push(u.node);
          i = u.end; textStart = i;
          continue;
        }
      }
      i += 1; continue;
    }
    if (c === '~') {
      const r = tryDel(text, masked, lastCloser, i, prevChar());
      if (r) {
        flushText(i);
        nodes.push({ k: 'del', kids: parseInlineText(r.content, env) });
        i += r.len; textStart = i;
        continue;
      }
      let m = 1;
      while (text[i + m] === '~') m++;
      i += m; continue;
    }
    if (c === '\n') {
      let sp = 0;
      let j = i - 1;
      while (j >= textStart && text[j] === ' ') { sp++; j--; }
      if (sp >= 2 && lastContent > i) {
        flushText(i - sp);
        nodes.push({ k: 'br' });
        i += 1;
        while (text[i] === ' ' || text[i] === '\t') i++;
        textStart = i;
        continue;
      }
      i++; continue;
    }
    if ((c === 'w' || c === 'h' || c === 'H' || c === 'f' || c === 'F') && !env.inLink) {
      if (c === 'w' && !wwwPrevOk(text, i, { textStart, nodes, openers })) { i++; continue; }
      const r = tryUrlAt(text, i);
      if (r && !r.email) {
        flushText(i);
        nodes.push(r.node);
        i = r.end; textStart = i;
        continue;
      }
      i++; continue;
    }
    if (c === '@' && !env.inLink) {
      const r = tryEmailAuto(text, i, textStart);
      if (r) {
        flushText(r.linkStart);
        nodes.push(r.node);
        i = r.end; textStart = i;
        continue;
      }
      i++; continue;
    }
    i++;
  }
  flushText(n);
  return nodes;
}

// ------------------------------------------------------ inline rendering

// Track whether rendering is currently inside a raw <code>/<kbd> HTML
// element; text there is emitted unescaped. Comments, CDATA sections
// and processing instructions do not affect the state.
function rawTagUpdate(rstate, raw) {
  const c1 = raw.charCodeAt(1);
  if (c1 === 33 || c1 === 63) return;
  let k = 1;
  let closing = false;
  if (c1 === 47) { closing = true; k = 2; }
  let name = '';
  while (k < raw.length) {
    const ch = raw[k];
    if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') ||
        (ch >= '0' && ch <= '9') || ch === '-') { name += ch; k++; }
    else break;
  }
  name = name.toLowerCase();
  if (name !== 'code' && name !== 'kbd') return;
  if (closing) rstate.raw = false;
  else if (!raw.endsWith('/>')) rstate.raw = true;
}

function altText(nodes, rstate) {
  let out = '';
  for (const nd of nodes) {
    switch (nd.k) {
      case 'text': out += plainRun(nd.s, rstate.raw); break;
      case 'code': out += nd.s; break;
      case 'html': rawTagUpdate(rstate, nd.s); out += nd.s; break;
      case 'br': break;
      case 'auto': out += nd.text; break;
      default:
        if (nd.kids) out += altText(nd.kids, rstate);
    }
  }
  return out;
}

function renderNodes(nodes, rstate) {
  let out = '';
  for (const nd of nodes) {
    switch (nd.k) {
      case 'text': out += rstate.raw ? escTextRunRaw(nd.s) : escTextRun(nd.s); break;
      case 'code': out += '<code>' + escFull(nd.s) + '</code>'; break;
      case 'html': rawTagUpdate(rstate, nd.s); out += nd.s; break;
      case 'br': out += '<br>'; break;
      case 'em': out += '<em>' + renderNodes(nd.kids, rstate) + '</em>'; break;
      case 'strong': out += '<strong>' + renderNodes(nd.kids, rstate) + '</strong>'; break;
      case 'del': out += '<del>' + renderNodes(nd.kids, rstate) + '</del>'; break;
      case 'link':
        out += '<a href="' + escAttr(encodeDest(nd.href)) + '"' +
          (nd.title != null ? ' title="' + escAttr(nd.title) + '"' : '') +
          '>' + renderNodes(nd.kids, rstate) + '</a>';
        break;
      case 'image':
        out += '<img src="' + escAttr(encodeDest(nd.href)) + '" alt="' +
          escAttr(altText(nd.kids, rstate)) + '"' +
          (nd.title != null ? ' title="' + escAttr(nd.title) + '"' : '') + '>';
        break;
      case 'auto':
        out += '<a href="' + escFull(encodeDest(nd.href)) + '">' + escFull(nd.text) + '</a>';
        break;
    }
  }
  return out;
}

function renderInline(text, env) {
  const rstate = { raw: false };
  return renderNodes(parseInlineText(text, env), rstate);
}

// ------------------------------------------------------------ block level

const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'base', 'basefont', 'blockquote', 'body',
  'caption', 'center', 'col', 'colgroup', 'dd', 'details', 'dialog', 'dir',
  'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form',
  'frame', 'frameset', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header',
  'hr', 'html', 'iframe', 'legend', 'li', 'link', 'main', 'menu', 'menuitem',
  'nav', 'noframes', 'ol', 'optgroup', 'option', 'p', 'param', 'search',
  'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead',
  'title', 'tr', 'track', 'ul',
]);

// The HTML-begin shape of marked's list-item gathering: a block tag,
// a script/pre/style/textarea opener, a comment, a processing
// instruction, a declaration, or a CDATA section.
function htmlBeginShape(s) {
  if (s[0] !== '<') return false;
  if (s.startsWith('<!--') || s.startsWith('<?') || s.startsWith('<![CDATA[')) return true;
  if (s[1] === '!' && /[A-Za-z]/.test(s[2] || '')) return true;
  const m = /^<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(s);
  if (!m) return false;
  const name = m[1].toLowerCase();
  const rest = s.slice(m[0].length);
  if (name === 'script' || name === 'pre' || name === 'style' || name === 'textarea') {
    return rest === '' || /[\s>]/.test(rest[0]);
  }
  if (!BLOCK_TAGS.has(name)) return false;
  return rest === '' || rest[0] === ' ' || rest[0] === '>' || rest.startsWith('/>');
}

// The first-line tests of marked's list gathering, applied to a raw
// line of the text the list lives in: a fence, heading, HTML block,
// blockquote, next bullet or thematic break shape (each allowing up
// to clamp(R-1, 0, 3) leading spaces) ends the gathering.
function gatherFirstLineBreaks(f, R) {
  const n = Math.max(0, Math.min(3, R - 1));
  let sp = 0;
  while (f[sp] === ' ') sp++;
  if (sp > n) return false;
  const s = f.slice(sp);
  if (s.startsWith('```') || s.startsWith('~~~')) return true;
  if (/^#{1,6}(?:\s|$)/.test(s)) return true;
  if (/^(?:-[ \t]*){3,}$|^(?:_[ \t]*){3,}$|^(?:\*[ \t]*){3,}$/.test(s)) return true;
  if (htmlBeginShape(s)) return true;
  if (s[0] === '>') return true;
  return /^(?:[*+-]|\d{1,9}[.)])(?:[ \t]|$)/.test(s);
}

// marked's list-item gathering stops before an unindented line when
// the previously gathered line begins an HTML block, a fence, a
// heading or a thematic break, or is itself indented 4+ columns
// (tabs counting four spaces each). R is the item's content indent;
// the begin patterns allow up to clamp(R-1, 0, 3) leading spaces.
function gatherStopsItem(prevLine, R) {
  const expanded = prevLine.replace(/\t/g, '    ');
  if (expanded.search(/\S/) >= 4) return true;
  const n = Math.max(0, Math.min(3, R - 1));
  let cut = 0;
  while (cut < n && expanded[cut] === ' ') cut++;
  const s = expanded.slice(cut);
  if (s.startsWith('```') || s.startsWith('~~~')) return true;
  if (/^#{1,6}(?:\s|$)/.test(s)) return true;
  if (/^(?:-[ \t]*){3,}$|^(?:_[ \t]*){3,}$|^(?:\*[ \t]*){3,}$/.test(s)) return true;
  return htmlBeginShape(s);
}

export function parse(markdown) {
  const src = String(markdown).replace(/\r\n?/g, '\n');
  const refs = new Map();
  const env = { refs, inLink: false };

  const doc = { k: 'doc', kids: [], up: null, open: true, lastLineBlank: false };
  // per-line working state
  const S = {
    line: '', off: 0, col: 0,
    nns: 0, nnsCol: 0, indent: 0, blank: true,
    tip: doc, touched: false, frameBase: 0,
    pendingHtml: null, prevBlank: true,
  };
  let lineIndex = 0;
  let totalLines = 0;
  const srcEndsWithNL = src.endsWith('\n');
  let lines = [];

  // ---------------------------------------------------------- line state

  function findNextNonspace() {
    const line = S.line;
    let i = S.off;
    let col = S.col;
    while (i < line.length) {
      const c = line[i];
      if (c === ' ') col += 1;
      else if (c === '\t') col += 4 - (col % 4);
      else break;
      i++;
    }
    S.nns = i;
    S.nnsCol = col;
    S.indent = col - S.col;
    S.blank = i >= line.length;
  }

  // Advance the line cursor by `count` columns (columnsOnly) or by
  // `count` characters with tabs counting their full stop width.
  // Partially consumed tabs are materialised as spaces in the line.
  function advanceOffset(count, columnsOnly) {
    let line = S.line;
    while (count > 0 && S.off < line.length) {
      const ch = line[S.off];
      if (ch === '\t') {
        const tabWidth = 4 - (S.col % 4);
        if (columnsOnly && count < tabWidth) {
          const rem = tabWidth - count;
          S.line = line = line.slice(0, S.off) + ' '.repeat(rem) + line.slice(S.off + 1);
          S.col += count;
          count = 0;
        } else {
          S.col += tabWidth;
          S.off += 1;
          count -= columnsOnly ? tabWidth : 1;
        }
      } else {
        S.col += 1;
        S.off += 1;
        count -= 1;
      }
    }
  }

  // Advance over at most maxCols columns of leading whitespace.
  function advanceIndentUpTo(maxCols) {
    while (maxCols > 0 && S.off < S.line.length) {
      const c = S.line[S.off];
      if (c === ' ') { advanceOffset(1, true); maxCols -= 1; }
      else if (c === '\t') {
        const w = 4 - (S.col % 4);
        if (w <= maxCols) { advanceOffset(1, false); maxCols -= w; }
        else { advanceOffset(maxCols, true); maxCols = 0; }
      } else break;
    }
  }

  function lastOpenChild(block) {
    const ch = block.kids;
    if (!ch || ch.length === 0) return null;
    const last = ch[ch.length - 1];
    return last.open ? last : null;
  }

  // ------------------------------------------------------------- defs

  function registerDefs(defs) {
    for (const d of defs) {
      const key = normalizeLabel(d.label);
      if (!refs.has(key)) refs.set(key, { href: d.href, title: d.title });
    }
  }

  function paraText(p) {
    if (!p.lines) return p.text;
    if (p._joinFor === p.lines && p._joinLen === p.lines.length) return p._joinText;
    const t = p.lines.join('\n');
    p._joinFor = p.lines; p._joinLen = p.lines.length; p._joinText = t;
    return t;
  }

  // peelDefs over the paragraph's current text, cached per text value
  function defsOf(p) {
    const t = paraText(p);
    if (p._defsText === t) return p._defsRes;
    const r = peelDefs(t);
    p._defsText = t; p._defsRes = r;
    return r;
  }
  function paraIsDefsOnly(p) {
    return defsOf(p).rest === '';
  }

  // -------------------------------------------------- finalise / build

  function endsWithBlank(b) {
    if (b.lastLineBlank) return true;
    if ((b.k === 'list' || b.k === 'item') && b.kids && b.kids.length) {
      return endsWithBlank(b.kids[b.kids.length - 1]);
    }
    return false;
  }

  function computeTight(list) {
    let tight = true;
    const items = list.kids;
    for (let ii = 0; ii < items.length && tight; ii++) {
      const item = items[ii];
      if (item.lastLineBlank && ii < items.length - 1) { tight = false; break; }
      const kids = item.kids;
      for (let ki = 0; ki < kids.length; ki++) {
        if (endsWithBlank(kids[ki]) && (ii < items.length - 1 || ki < kids.length - 1)) {
          tight = false;
          break;
        }
      }
    }
    list.tight = tight;
  }

  // marked trims trailing spaces/tabs from a list's last item's final
  // paragraph (its raw list text ends there); the paragraph may sit
  // inside a trailing blockquote or nested list.
  function trimLastPara(b) {
    if (!b.kids || !b.kids.length) return;
    const last = b.kids[b.kids.length - 1];
    if (last.k === 'para' && last.text) {
      last.text = last.text.replace(/[ \t]+$/, '');
    } else if (last.k === 'quote' || last.k === 'list' || last.k === 'item') {
      trimLastPara(last);
    }
  }

  function finalize(b) {
    if (b.k === 'para') {
      const r = peelDefs(b.lines.join('\n'));
      registerDefs(r.defs);
      b.text = r.rest;
      b.lines = null;
    } else if (b.k === 'code' && !b.fenced) {
      const L = b.lines;
      while (L.length && /^[ \t]*$/.test(L[L.length - 1])) L.pop();
    } else if (b.k === 'code' && b.fenced) {
      if (b.lines.length && b.lines[b.lines.length - 1] === '') b.lines.pop();
    } else if (b.k === 'list') {
      computeTight(b);
      const lastItem = b.kids[b.kids.length - 1];
      if (lastItem) trimLastPara(lastItem);
    }
    b.open = false;
    S.tip = b.up;
  }

  function addChild(kind, parent) {
    while (S.tip !== parent) finalize(S.tip);
    parent.tailHtml = null; // a new last block supersedes the candidate
    const b = { k: kind, kids: [], up: parent, open: true, lastLineBlank: false };
    if (kind === 'para' || kind === 'code' || kind === 'html') b.lines = [];
    parent.kids.push(b);
    S.tip = b;
    return b;
  }

  function closeDownTo(block) {
    while (S.tip !== block) finalize(S.tip);
  }

  // ------------------------------------------------- container matching

  function matchQuotePrefix() {
    if (S.indent <= 3 && S.line[S.nns] === '>') {
      const frameStart = S.col;
      advanceOffset(S.nnsCol - S.col, true);
      advanceOffset(1, false); // the '>' itself
      // The whitespace run after the marker: marked expands its tabs
      // (tab stops measured from this frame's line start — the run
      // begins at column indent + 1 of the frame's text) before the
      // marker and one whitespace column are stripped. Splice the
      // expansion into the line the same way: the run becomes
      // (width - 1) spaces, one column being the optional space.
      let runEnd = S.off;
      while (S.line[runEnd] === ' ' || S.line[runEnd] === '\t') runEnd++;
      const run = S.line.slice(S.off, runEnd);
      if (run.includes('\t')) {
        let col = S.col - frameStart;
        let width = 0;
        for (const ch of run) {
          const w = ch === ' ' ? 1 : 4 - (col % 4);
          col += w;
          width += w;
        }
        S.line = S.line.slice(0, S.off) + ' '.repeat(width - 1) + S.line.slice(runEnd);
        S.col += 1;
      } else if (run[0] === ' ') {
        advanceOffset(1, false);
      }
      S.touched = true;
      return true;
    }
    return false;
  }

  function matchItemPrefix(item) {
    if (S.blank) return true;
    if (S.nnsCol - S.col >= item.indentReq) {
      advanceOffset(item.indentReq, true);
      S.touched = true;
      return true;
    }
    return false;
  }

  // ----------------------------------------------------- block starters
  // All matchers are pure: they read S.line starting at S.nns.

  function matchATX() {
    const line = S.line;
    let i = S.nns;
    let level = 0;
    while (line[i] === '#' && level <= 6) { i++; level++; }
    if (level === 0 || level > 6) return null;
    const c = line[i];
    if (c !== undefined && c !== ' ' && c !== '\t') return null;
    let content = line.slice(i).replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
    if (/^#+$/.test(content)) content = '';
    else content = content.replace(/[ \t]+#+$/, '').replace(/[ \t]+$/, '');
    return { level, content };
  }

  function matchFence() {
    const line = S.line;
    const ns = S.nns;
    const ch = line[ns];
    if (ch !== '`' && ch !== '~') return null;
    let len = 0;
    while (line[ns + len] === ch) len++;
    if (len < 3) return null;
    const rest = line.slice(ns + len);
    if (ch === '`' && rest.indexOf('`') !== -1) return null;
    const info = rest.replace(/^[ \t]+|[ \t]+$/g, '');
    return { ch, len, info, indent: S.indent };
  }

  function matchHR() {
    const line = S.line;
    let i = S.nns;
    let ch = null;
    let count = 0;
    while (i < line.length) {
      const c = line[i];
      if (c === ' ' || c === '\t') { i++; continue; }
      if (ch === null) {
        if (c !== '-' && c !== '_' && c !== '*') return false;
        ch = c; count = 1;
      } else if (c === ch) count++;
      else return false;
      i++;
    }
    return count >= 3;
  }

  function setextShape(s) {
    return /^=+[ \t]*$/.test(s) || /^-+[ \t]*$/.test(s);
  }

  function matchSetext() {
    const rest = S.line.slice(S.nns).replace(/[ \t]+$/, '');
    if (/^=+$/.test(rest)) return 1;
    if (/^-+$/.test(rest)) return 2;
    return 0;
  }

  function matchListItem() {
    const line = S.line;
    const ns = S.nns;
    const nsCol = S.nnsCol;
    const c = line[ns];
    let kind, marker, start = null, markerLen;
    if (c === '-' || c === '+' || c === '*') {
      kind = 'ul'; marker = c; markerLen = 1;
    } else if (c >= '0' && c <= '9') {
      let j = ns;
      let num = 0;
      let digits = 0;
      while (j < line.length && line[j] >= '0' && line[j] <= '9') {
        num = num * 10 + (line.charCodeAt(j) - 48);
        j++; digits++;
        if (digits > 9) return null;
      }
      const d = line[j];
      if (d !== '.' && d !== ')') return null;
      kind = 'ol'; marker = d; start = num; markerLen = digits + 1;
    } else return null;
    const afterMarker = ns + markerLen;
    const mc = line[afterMarker];
    if (mc !== undefined && mc !== ' ' && mc !== '\t') return null;
    let col = nsCol + markerLen;
    let j = afterMarker;
    let wsCols = 0;
    while (j < line.length && (line[j] === ' ' || line[j] === '\t')) {
      if (line[j] === ' ') { col += 1; wsCols += 1; }
      else { const w = 4 - (col % 4); col += w; wsCols += w; }
      j++;
    }
    const empty = j >= line.length;
    return { kind, marker, start, markerLen, wsCols, empty };
  }

  function listsMatch(list, li) {
    return list.kind === li.kind && list.marker === li.marker;
  }

  // HTML block start; maxType is 6 while a paragraph is open (type 7
  // may not interrupt a paragraph), else 7. { type, endTag } or null.
  function matchHTMLBlockStart(maxType) {
    const line = S.line;
    const ns = S.nns;
    if (line[ns] !== '<') return null;
    const rest = line.slice(ns);
    let m;
    if ((m = /^<(script|pre|style|textarea)(?=[ \t>]|$)/i.exec(rest))) {
      return { type: 1, endTag: m[1].toLowerCase() };
    }
    if (rest.startsWith('<!--')) return { type: 2 };
    if (rest.startsWith('<?')) return { type: 3 };
    if (/^<![A-Z]/.test(rest)) return { type: 4 };
    if (rest.startsWith('<![CDATA[')) return { type: 5 };
    if ((m = /^<\/?([A-Za-z][A-Za-z0-9-]*)(?=[ \t>]|\/>|$)/.exec(rest)) &&
        BLOCK_TAGS.has(m[1].toLowerCase())) {
      return { type: 6 };
    }
    if (maxType >= 7) {
      const end = scanTag(line, ns);
      if (end !== -1 && /^[ \t]*$/.test(line.slice(end))) return { type: 7 };
    }
    return null;
  }

  function htmlEndFound(b, lineText) {
    switch (b.htmlType) {
      case 1: return new RegExp('</' + b.endTag + '>', 'i').test(lineText);
      case 2: return lineText.indexOf('-->') !== -1;
      case 3: return lineText.indexOf('?>') !== -1;
      case 4: return lineText.indexOf('>') !== -1;
      case 5: return lineText.indexOf(']]>') !== -1;
      default: return false;
    }
  }

  // ------------------------------------------------------------ tables

  function trimCellWS(s) {
    let a = 0, b = s.length;
    while (a < b && (s[a] === ' ' || s[a] === '\t')) a++;
    while (b > a && (s[b - 1] === ' ' || s[b - 1] === '\t')) b--;
    return a === 0 && b === s.length ? s : s.slice(a, b);
  }

  function splitRow(s) {
    s = trimCellWS(s);
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|')) {
      // the trailing pipe counts unless escaped by an odd number of
      // backslashes
      let bs = 0;
      let k = s.length - 2;
      while (k >= 0 && s[k] === '\\') { bs++; k--; }
      if (bs % 2 === 0) s = s.slice(0, -1);
    }
    const cells = [];
    let start = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '\\' && s[i + 1] === '|') i++;
      else if (c === '|') { cells.push(s.slice(start, i)); start = i + 1; }
    }
    cells.push(s.slice(start));
    for (let i = 0; i < cells.length; i++) {
      let c = cells[i];
      if (c.indexOf('\\|') !== -1) c = c.replace(/\\\|/g, '|');
      cells[i] = trimCellWS(c);
    }
    return cells;
  }

  function parseDelimiterRow(str) {
    const cells = splitRow(str);
    const aligns = [];
    for (const c of cells) {
      if (!/^:?-+:?$/.test(c)) return null;
      const left = c.startsWith(':');
      const right = c.endsWith(':');
      aligns.push(left && right ? 'center' : left ? 'left' : right ? 'right' : null);
    }
    return aligns;
  }

  // Convert the open paragraph into a table when the current line is
  // its delimiter row: the paragraph's last line becomes the header.
  function tryTableConvert(aligns) {
    const p = S.tip;
    const text = paraText(p);
    const nl = text.lastIndexOf('\n');
    const headLine = nl === -1 ? text : text.slice(nl + 1);
    const headCells = splitRow(headLine);
    if (headCells.length !== aligns.length) return false;
    const before = nl === -1 ? '' : text.slice(0, nl);
    const parent = p.up;
    const rem = peelDefs(before);
    registerDefs(rem.defs);
    if (rem.rest === '') {
      const idx = parent.kids.indexOf(p);
      if (idx !== -1) parent.kids.splice(idx, 1);
      p.open = false;
    } else {
      p.lines = rem.rest.split('\n');
      finalize(p);
    }
    const tb = {
      k: 'table', kids: [], up: parent, open: true, lastLineBlank: false,
      aligns, head: headCells, rows: [],
    };
    parent.kids.push(tb);
    S.tip = tb;
    return true;
  }

  function tableLineStartsBlock() {
    findNextNonspace();
    if (S.blank) return true;
    if (S.indent >= 4) return true;
    if (S.line[S.nns] === '>') return true;
    if (matchATX()) return true;
    if (matchFence()) return true;
    if (matchHTMLBlockStart(7)) return true;
    if (matchHR()) return true;
    const li = matchListItem();
    if (li && !li.empty && (li.kind === 'ul' || li.start === 1)) return true;
    return false;
  }

  function isClosingFence(b) {
    if (S.indent > 3) return false;
    const line = S.line;
    let i = S.nns;
    let len = 0;
    while (line[i] === b.fenceCh) { i++; len++; }
    if (len < b.fenceLen) return false;
    return /^[ \t]*$/.test(line.slice(i));
  }

  // Does lineStr continue the container stream of `upto` (a container
  // block)? Simulates container matching from the document down.
  function lineContinuesStream(lineStr, upto) {
    const chain = [];
    for (let b = upto; b && b.k !== 'doc'; b = b.up) chain.unshift(b);
    let i = 0;
    let col = 0;
    const nonspaceFrom = (j, c) => {
      while (j < lineStr.length) {
        const ch = lineStr[j];
        if (ch === ' ') { c++; j++; }
        else if (ch === '\t') { c += 4 - (c % 4); j++; }
        else break;
      }
      return { idx: j, col: c };
    };
    for (const c of chain) {
      if (c.k === 'list') continue;
      if (c.k === 'quote') {
        const ns = nonspaceFrom(i, col);
        if (ns.col - col > 3) return false;
        if (lineStr[ns.idx] !== '>') return false;
        i = ns.idx + 1;
        col = ns.col + 1;
        if (lineStr[i] === ' ') { i++; col++; }
        else if (lineStr[i] === '\t') { i++; col += 4 - (col % 4); }
        continue;
      }
      if (c.k === 'item') {
        const ns = nonspaceFrom(i, col);
        if (ns.idx >= lineStr.length) return true; // blank continues an item
        if (ns.col - col < c.indentReq) return false;
        let need = c.indentReq;
        while (need > 0 && i < lineStr.length) {
          const ch = lineStr[i];
          if (ch === ' ') { col++; i++; need--; }
          else if (ch === '\t') {
            const w = 4 - (col % 4);
            if (w <= need) { col += w; i++; need -= w; }
            else { col += need; need = 0; }
          } else break;
        }
        continue;
      }
      return false;
    }
    return true;
  }

  // Would this line start a block once a definitions-only paragraph is
  // out of the way? (Such paragraphs do not block interruption.)
  function startsBlockAfterDefs() {
    findNextNonspace();
    if (S.indent >= 4) return true; // indented code
    if (S.line[S.nns] === '>') return true;
    if (matchATX()) return true;
    if (matchFence()) return true;
    if (matchHTMLBlockStart(7)) return true;
    if (matchHR()) return true;
    if (matchListItem()) return true;
    return false;
  }

  // -------------------------------------------------------- line intake

  // marked slices container content from the raw line in a way that
  // expands tabs in the leading whitespace run to spaces (tab stops
  // counted in the original line). Content at document level keeps
  // its tabs. S.touched records whether a quote/item prefix was
  // consumed on the current line.
  function expandSlice(slice, col) {
    if (slice.indexOf('\t') === -1) return slice;
    let out = '';
    let i = 0;
    let c = col;
    while (i < slice.length) {
      const ch = slice[i];
      if (ch === ' ') { out += ' '; c++; i++; }
      else if (ch === '\t') { const w = 4 - (c % 4); out += ' '.repeat(w); c += w; i++; }
      else break;
    }
    return out + slice.slice(i);
  }

  function contentSlice() {
    const s = S.line.slice(S.off);
    return S.touched ? expandSlice(s, S.col - S.frameBase) : s;
  }

  // Expand the leading whitespace run of S.line (from S.off) in place.
  function expandLeadingRunInPlace() {
    const line = S.line;
    if (line.indexOf('\t') === -1) return;
    let i = S.off;
    let c = S.col - S.frameBase;
    let out = '';
    let sawTab = false;
    while (i < line.length) {
      const ch = line[i];
      if (ch === ' ') { out += ' '; c++; i++; }
      else if (ch === '\t') { const w = 4 - (c % 4); out += ' '.repeat(w); c += w; i++; sawTab = true; }
      else break;
    }
    if (sawTab) S.line = line.slice(0, S.off) + out + line.slice(i);
  }

  // A line consisting of a single HTML construct (a lone tag, or a
  // comment / CDATA / declaration / PI opener).
  function isTagLine(txt) {
    let i = 0;
    while (txt[i] === ' ' || txt[i] === '\t') i++;
    if (txt[i] !== '<') return false;
    const c = txt[i + 1];
    if (c === '!' || c === '?') return true;
    if (c === '/' || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z')) {
      const a = scanAngle(txt, i);
      if (!a || a.node.k !== 'html') return false;
      for (let j = a.end; j < txt.length; j++) {
        if (txt[j] !== ' ' && txt[j] !== '\t') return false;
      }
      return true;
    }
    return false;
  }

  // Such lone-tag lines are glued onto the previous line of a list
  // item's paragraph by marked's item gathering (no newline between
  // them), at most once per paragraph — and not when the paragraph
  // ends right after this line.
  function tryGlue(p, txt) {
    if (p.up.k !== 'item' || p.glued || p.lines.length === 0) return false;
    const last = p.lines[p.lines.length - 1];
    if (last === '' || isTagLine(last) || !isTagLine(txt)) return false;
    if (lineIndex + 1 < totalLines) {
      const chain = [];
      for (let b = p.up; b && b.k !== 'doc'; b = b.up) chain.unshift(b);
      const off = lineMatchesChain(lines[lineIndex + 1], chain);
      if (off !== -1 && /^[ \t]*$/.test(lines[lineIndex + 1].slice(off))) return false;
    }
    p.lines[p.lines.length - 1] = last + txt;
    p.glued = true;
    p._joinLen = -1;
    p._defsText = null;
    return true;
  }

  function addLineToPara(p) {
    const txt = contentSlice();
    if (!tryGlue(p, txt)) p.lines.push(txt);
    p.lastLineBlank = false;
  }

  // marked's list gathering also stops at a line that begins a
  // blockquote in the text the list lives in: the line as seen from
  // the frame of the ancestors of the container holding the list —
  // that container's own marker still attached — matching ^ {0,R}>
  // with R the item's content indent.
  // The current line as seen in the text the item's list lives in
  // (the holder container's content; for a quote-held list that has
  // switched to raw lines, the holder's parent text instead, where
  // the holder's own marker is still attached).
  function gatherFrameLine(item) {
    const list = item.up;
    if (!list || list.k !== 'list' || !list.up) return null;
    const holder = list.up;
    const chain = [];
    if (holder.k === 'quote' && list.rawFrame) {
      for (let b = holder.up; b && b.k !== 'doc'; b = b.up) chain.unshift(b);
    } else {
      for (let b = holder; b && b.k !== 'doc'; b = b.up) chain.unshift(b);
    }
    let off = chain.length ? lineMatchesChain(S.line, chain) : 0;
    if (off === -1 && chain.length) off = lineMatchesChain(S.line, chain.slice(0, -1));
    return off === -1 ? null : S.line.slice(off);
  }

  function lineBreaksGatheringAtQuote(item) {
    const list = item.up;
    if (!list || list.k !== 'list' || !list.up) return false;
    // the raw-frame rule applies only once the list's blockquote has
    // started feeding it raw lines (see the rawFrame marking below),
    // and only for lists held by a blockquote
    if (!list.rawFrame || list.up.k !== 'quote') return false;
    const chain = [];
    for (let b = list.up.up; b; b = b.up) chain.unshift(b);
    let off = 0;
    if (chain.length) {
      off = lineMatchesChain(S.line, chain);
      if (off === -1) return false;
    }
    const rest = S.line.slice(off);
    const R = item.indentReq || 0;
    let sp = 0;
    while (rest[sp] === ' ') sp++;
    return sp <= R && rest[sp] === '>';
  }

  // Would this raw line match every container in the chain (the blocks
  // from just below the document down to some block's parent)? Returns
  // the offset just past the chain's prefixes, or -1. Used for the
  // fenced-code blank-line lookahead and the glue rule.
  function lineMatchesChain(lineStr, chain) {
    let off = 0, col = 0;
    const len = lineStr.length;
    for (const b of chain) {
      // a whitespace-only remainder matches the rest vacuously
      if (/^[ \t]*$/.test(lineStr.slice(off))) return off;
      if (b.k === 'quote') {
        let ind = 0;
        while (off < len) {
          const ch = lineStr[off];
          if (ch === ' ') { ind++; col++; off++; }
          else if (ch === '\t') { const w = 4 - (col % 4); ind += w; col += w; off++; }
          else break;
        }
        if (ind > 3 || lineStr[off] !== '>') return -1;
        off++; col++;
        if (lineStr[off] === ' ') { off++; col++; }
        else if (lineStr[off] === '\t') { off++; col++; }
      } else if (b.k === 'item') {
        let o2 = off, c2 = col, ind = 0;
        while (o2 < len) {
          const ch = lineStr[o2];
          if (ch === ' ') { ind++; c2++; o2++; }
          else if (ch === '\t') { const w = 4 - (c2 % 4); ind += w; c2 += w; o2++; }
          else break;
        }
        if (ind < b.indentReq) return -1;
        let need = b.indentReq;
        while (need > 0 && off < len) {
          const ch = lineStr[off];
          if (ch === ' ') { off++; col++; need--; }
          else if (ch === '\t') { const w = 4 - (col % 4); col += w; off++; need -= w; }
          else break;
        }
      }
    }
    return off;
  }

  function incorporateLine(lineStr) {
    S.line = lineStr;
    S.off = 0;
    S.col = 0;
    S.touched = false;
    S.frameBase = 0;
    const oldtip = S.tip;
    // the open chain as it was when this line arrived (phase 2 may add
    // blocks; the gather rule below only sees this original chain)
    const oldChain = [];
    for (let b = oldtip; b; b = b.up) oldChain.push(b);

    // Phase 1: match open containers
    let container = doc;
    let lastMatched = doc;
    let firstUnmatched = null;
    findNextNonspace();
    for (;;) {
      const child = lastOpenChild(container);
      if (!child) break;
      if (child.k === 'quote') {
        const bc = S.col;
        if (matchQuotePrefix()) { S.frameBase = bc; container = child; lastMatched = child; findNextNonspace(); }
        else { firstUnmatched = child; break; }
      } else if (child.k === 'item') {
        if (matchItemPrefix(child)) { container = child; lastMatched = child; findNextNonspace(); }
        else { firstUnmatched = child; break; }
      } else if (child.k === 'list') {
        container = child; lastMatched = child;
      } else break;
    }
    const allMatched = firstUnmatched === null;
    // Once a line that does not carry the holder blockquote's marker
    // is processed while a quote-held list is open, marked's segment
    // machinery switches that list to raw (marker-carrying) lines:
    // later marker lines then start a new segment instead of joining
    // the list. Remember it on the list.
    for (const b of oldChain) {
      if (b.k === 'list' && b.up && b.up.k === 'quote' && !b.rawFrame) {
        let holderMatched = false;
        for (let c = lastMatched; c; c = c.up) {
          if (c === b.up) { holderMatched = true; break; }
        }
        if (!holderMatched) b.rawFrame = true;
      }
    }
    const blank = S.blank;
    const prevBlankLine = S.prevBlank;
    S.prevBlank = blank;
    const tip = S.tip;

    // Resolve blanks deferred on a deep-ended item paragraph (see the
    // blank handler): an indented line matching the item continues the
    // code chunk (the blanks become interior empty lines); anything
    // else ends the paragraph at the blanks. When the item itself ends
    // there, exactly one deferred blank survives as a trailing newline
    // in the paragraph text (the code token's raw keeps it), and the
    // item counts as blank-ended for looseness.
    if (!blank && tip.k === 'para' && tip.pendingBlanks) {
      const p = tip;
      const item = p.up;
      const nBlanks = p.pendingBlanks;
      p.pendingBlanks = 0;
      if (allMatched && S.indent >= 4) {
        for (let i = 0; i < nBlanks; i++) p.lines.push('');
      } else {
        let itemMatched = false;
        for (let c = lastMatched; c; c = c.up) {
          if (c === item) { itemMatched = true; break; }
        }
        const sibLi = !itemMatched && lastMatched === item.up ? matchListItem() : null;
        const siblingItem = !!sibLi && listsMatch(item.up, sibLi);
        if (!itemMatched || siblingItem) {
          // the trailing newline survives only when a sibling item
          // follows in the same list (the last item's text is trimmed)
          if (nBlanks === 1 && siblingItem) p.lines.push('');
          item.lastLineBlank = true;
        } else {
          p.lastLineBlank = true;
        }
        finalize(p);
      }
    }

    // An HTML block that ended via its close tag keeps the newline
    // after its last line iff the next line continues the same
    // container stream and has any content at all in it.
    if (S.pendingHtml) {
      const pb = S.pendingHtml;
      S.pendingHtml = null;
      pb.trailNL = lastMatched === pb.up && S.line.slice(S.off).length > 0;
    }

    // An open fence consumes every line until its closing fence, even
    // a line that does not match the surrounding containers: strip as
    // much of the container prefixes as the line offers.
    if (tip.k === 'code' && tip.fenced) {
      let feed = false;
      if (allMatched && !blank) {
        feed = true;
      } else if (allMatched && blank) {
        // a blank line feeds a fenced block at document level, or in
        // containers when the next non-blank line rejoins the stream
        if (tip.up.k === 'doc') feed = true;
        else {
          const chain = [];
          for (let b = tip.up; b && b !== doc; b = b.up) chain.push(b);
          chain.reverse();
          for (let k = lineIndex + 1; k < totalLines; k++) {
            if (/^[ \t]*$/.test(lines[k])) continue;
            // tab-indented lines defeat the column simulation; for
            // those, any indented or quoted line counts as rejoining
            if (/^[ \t]*\t/.test(lines[k])) {
              feed = /^[ \t]/.test(lines[k]) || lines[k].startsWith('>');
              break;
            }
            const off = lineMatchesChain(lines[k], chain);
            if (off === -1) { feed = false; break; }
            if (/^[ \t]*$/.test(lines[k].slice(off))) continue;
            feed = true;
            break;
          }
        }
      } else if (!blank && tip.lines.length > 0) {
        // swallow an unmatched line only once the fence has content,
        // and only if the unmatched containers are all list items
        // (a blockquote still ends the fence)
        feed = true;
        for (let b = tip.up; b && b !== lastMatched; b = b.up) {
          if (b.k === 'quote') { feed = false; break; }
        }
        if (feed) {
          // ... unless the previously gathered line begins a block
          // of its own (HTML, fence, heading, rule) or is indented
          // 4+ columns: marked's item gathering ends the item there;
          // a line that begins a blockquote in the list's own text
          // ends it too
          let item = tip.up;
          while (item && item.k !== 'item') item = item.up;
          if (item && gatherStopsItem(tip.lines[tip.lines.length - 1], item.indentReq || 0)) {
            feed = false;
          }
          if (feed && item && lineBreaksGatheringAtQuote(item)) feed = false;
          // ... or when the line itself begins a block in the list's
          // own text (fence, heading, HTML, quote, next bullet, rule)
          if (feed && item) {
            const f = gatherFrameLine(item);
            if (f !== null && gatherFirstLineBreaks(f, item.indentReq || 0)) feed = false;
          }
        }
      }
      if (feed) {
        if (isClosingFence(tip)) finalize(tip);
        else {
          let content = contentSlice();
          // marked removes up to fenceIndent whitespace *characters*,
          // but only from backtick fences (tilde fences keep theirs)
          let k = 0;
          while (tip.fenceCh === '`' && k < tip.fenceIndent && k < content.length &&
                 (content[k] === ' ' || content[k] === '\t')) k++;
          if (k > 0) content = content.slice(k);
          tip.lines.push(content);
        }
        return;
      }
    }

    // Leaf continuations (only when every container matched)
    if (allMatched) {
      if (tip.k === 'code' && !tip.fenced) {
        if (blank || S.indent >= 4) {
          if (S.touched) expandLeadingRunInPlace();
          advanceOffset(4, true);
          tip.lines.push(S.line.slice(S.off));
          return;
        }
      }
      if (tip.k === 'html') {
        if (!(blank && tip.htmlType >= 6)) {
          const content = contentSlice();
          tip.lines.push(content);
          tip.lastLine = lineIndex;
          if (tip.htmlType <= 5 && htmlEndFound(tip, content)) {
            tip.endKind = 'close';
            S.pendingHtml = tip;
            finalize(tip);
          }
          return;
        }
      }
      if (tip.k === 'table') {
        if (!blank && !tableLineStartsBlock()) {
          tip.rows.push(splitRow(S.line.slice(S.off)));
          return;
        }
        // a whitespace-only line ending in a single tab at column 4
        // is a table row in marked, not a blank line
        if (blank && /^ {0,3}\t$/.test(S.line.slice(S.off))) {
          tip.rows.push(splitRow(S.line.slice(S.off)));
          return;
        }
      }
    }

    // A whitespace-only line at the very end of a paragraph's container
    // stream joins the paragraph instead of separating it (document
    // streams end with a newline iff the source does; container
    // streams never do).
    if (blank && S.tip.k === 'para' && S.line.slice(S.off).length > 0 &&
        (S.tip.up.k === 'quote' || (allMatched && S.tip.up.k === 'doc'))) {
      const parent = S.tip.up;
      let atEnd;
      if (lineIndex === totalLines - 1) atEnd = parent.k === 'quote' || !srcEndsWithNL;
      else atEnd = allMatched && parent.k === 'quote' && !lineContinuesStream(lines[lineIndex + 1], parent);
      if (atEnd) {
        addLineToPara(S.tip);
        return;
      }
    }

    // Blank line: close the paragraph (if any) and unmatched blocks.
    // For list looseness, the blank marks the last child of the deepest
    // matched container — but a blank inside a blockquote marks nothing.
    if (blank) {
      // A paragraph in a text-mode list item whose last line was an
      // indented (code-chunk) line may yet continue: in marked, blank
      // lines between indented lines are interior to the code token,
      // which then merges into the text token. Defer the decision —
      // count the blanks on the paragraph and let the next content
      // line resolve them (see the pendingBlanks resolution below).
      if (S.tip.k === 'para' && S.tip.deepLast && S.tip.up.k === 'item' &&
          !S.tip.up.pstyle && allMatched) {
        S.tip.pendingBlanks = (S.tip.pendingBlanks || 0) + 1;
        return;
      }
      // An html block that ends an item's or blockquote's text keeps
      // one trailing newline iff exactly one blank line follows it
      // inside the container (marked's ge() trailing-newline rule);
      // track the candidate and how many blanks have followed it.
      if (lastMatched.k === 'item' || lastMatched.k === 'quote') {
        const kids = lastMatched.kids;
        const lastKid = kids && kids.length ? kids[kids.length - 1] : null;
        if (lastKid && lastKid.k === 'html') {
          if (lastMatched.tailHtml === lastKid) lastMatched.tailBlanks++;
          else { lastMatched.tailHtml = lastKid; lastMatched.tailBlanks = 1; }
        }
      }
      if (lastMatched.k !== 'quote' && lastMatched !== doc) {
        const kids = lastMatched.kids;
        const target = kids && kids.length ? kids[kids.length - 1] : lastMatched;
        target.lastLineBlank = true;
      }
      if (S.tip.k === 'para') finalize(S.tip);
      closeDownTo(lastMatched);
      // an item that is still empty ends at a blank line
      if (S.tip.k === 'item' && S.tip.kids.length === 0) finalize(S.tip);
      return;
    }

    // A lazy line over a definitions-only paragraph: the definitions
    // register and the paragraph vanishes. If the line starts a block
    // it is reprocessed outside the unmatched containers; otherwise it
    // becomes text for the paragraph's parent.
    let cont = lastMatched;
    if (!allMatched && S.tip.k === 'para' && paraIsDefsOnly(S.tip)) {
      if (startsBlockAfterDefs()) {
        closeDownTo(lastMatched);
      } else {
        cont = S.tip.up;
        finalize(S.tip);
      }
    }

    // Can the open paragraph (sitting in an unmatched container) take
    // this line as a lazy continuation? An item whose marker was
    // followed by 4+ spaces accepts no lazy lines (marked's list
    // gathering ends such items at the first unindented line); a
    // paragraph whose last line was deeply indented accepts none
    // either; and a line that begins a blockquote in the list's own
    // text ends the item. Computed here because phase 2's indented
    // code block may pre-empt the paragraph when it is poisoned.
    const openPara = S.tip.k === 'para' ? S.tip : null;
    let lazyPoison = false;
    if (openPara && !allMatched) {
      if (openPara.deepLast) lazyPoison = true;
      if (!lazyPoison) {
        for (let b = openPara.up; b && b !== lastMatched; b = b.up) {
          if (b.k === 'item' && b.widePad) { lazyPoison = true; break; }
        }
      }
      if (!lazyPoison) {
        for (let b = openPara.up; b && b !== lastMatched; b = b.up) {
          if (b.k === 'item') {
            if (lineBreaksGatheringAtQuote(b)) lazyPoison = true;
            break;
          }
        }
      }
      if (!lazyPoison) {
        // a line that begins a block in the list's own text (fence,
        // heading, HTML, quote, next bullet, rule) ends the item too
        // — even one that fails the real block match, like a fence
        // line whose info string holds backticks
        for (let b = openPara.up; b && b !== lastMatched; b = b.up) {
          if (b.k === 'item') {
            const f = gatherFrameLine(b);
            if (f !== null && gatherFirstLineBreaks(f, b.indentReq || 0)) lazyPoison = true;
            break;
          }
        }
      }
    }

    // Phase 2: block starts
    let consumed = false;
    for (;;) {
      findNextNonspace();
      if (S.blank) { consumed = true; break; } // the line held only markers
      const indented = S.indent >= 4;
      // blockquote
      if (!indented && S.line[S.nns] === '>') {
        S.frameBase = S.col;
        matchQuotePrefix();
        cont = addChild('quote', cont.k === 'list' ? cont.up : cont);
        S.touched = true;
        continue;
      }
      // ATX heading
      if (!indented) {
        const h = matchATX();
        if (h) {
          const hb = addChild('head', cont.k === 'list' ? cont.up : cont);
          hb.level = h.level;
          hb.text = h.content;
          finalize(hb);
          consumed = true;
          break;
        }
      }
      // fenced code
      if (!indented) {
        const f = matchFence();
        if (f) {
          const cb = addChild('code', cont.k === 'list' ? cont.up : cont);
          cb.fenced = true;
          cb.fenceCh = f.ch;
          cb.fenceLen = f.len;
          cb.fenceIndent = f.indent;
          cb.info = f.info;
          consumed = true;
          break;
        }
      }
      // HTML block
      if (!indented) {
        const tipPara = S.tip.k === 'para' ? S.tip : null;
        const maxType = tipPara && !paraIsDefsOnly(tipPara) ? 6 : 7;
        const hb = matchHTMLBlockStart(maxType);
        if (hb) {
          const b = addChild('html', cont.k === 'list' ? cont.up : cont);
          b.htmlType = hb.type;
          b.endTag = hb.endTag;
          const content = contentSlice();
          b.lines.push(content);
          b.lastLine = lineIndex;
          if (hb.type <= 5 && htmlEndFound(b, content)) {
            b.endKind = 'close';
            S.pendingHtml = b;
            finalize(b);
          }
          consumed = true;
          break;
        }
      }
      // setext heading / table conversion: need an open paragraph
      // whose containers all matched this line
      if (!indented && S.tip.k === 'para' && allMatched) {
        const lvl = matchSetext();
        if (lvl) {
          const p = S.tip;
          const rem = defsOf(p);
          registerDefs(rem.defs);
          if (rem.rest === '') {
            // the paragraph was only definitions: it vanishes and
            // this line is reprocessed as fresh content
            const parent = p.up;
            finalize(p);
            cont = parent;
            continue;
          }
          p.k = 'head';
          p.level = lvl;
          p.text = rem.rest.replace(/^[ \t\n]+/, '').replace(/[ \t\n]+$/, '');
          p.lines = null;
          finalize(p);
          consumed = true;
          break;
        }
        let aligns = null;
        { // fast reject: a delimiter row uses only | : - space tab
          const L = S.line;
          let ok = true, dash = false;
          for (let q = S.nns; q < L.length; q++) {
            const cq = L[q];
            if (cq === '-') dash = true;
            else if (cq !== '|' && cq !== ':' && cq !== ' ' && cq !== '\t') { ok = false; break; }
          }
          if (ok && dash) aligns = parseDelimiterRow(L.slice(S.nns));
        }
        if (aligns && tryTableConvert(aligns)) {
          consumed = true;
          break;
        }
      }
      // thematic break
      if (!indented && matchHR()) {
        const b = addChild('hr', cont.k === 'list' ? cont.up : cont);
        finalize(b);
        consumed = true;
        break;
      }
      // list item
      const li = indented ? null : matchListItem();
      if (li) {
        const tipPara = S.tip.k === 'para' ? S.tip : null;
        const realPara = tipPara && !paraIsDefsOnly(tipPara);
        // an item line is blocked from interrupting only when the
        // open paragraph sits directly in the container that would
        // hold the new list (and that container is not itself an item)
        const blocked = realPara && cont === tipPara.up && cont.k !== 'item' &&
          (li.empty || (li.kind === 'ol' && li.start !== 1));
        if (!blocked) {
          if (cont.k === 'list' && (!listsMatch(cont, li) || cont.rawFrame)) {
            cont = addChild('list', cont.up);
          } else if (cont.k !== 'list') {
            cont = addChild('list', cont);
          }
          // marked flips an item's remaining content to paragraph
          // mode once a list has been lexed inside it (the block
          // lexer's top flag leaks out of the nested list's own
          // lexing); remember that on the item whose frame holds
          // this list — a blockquote in between shields the item.
          for (let b = cont.up; b; b = b.up) {
            if (b.k === 'quote' || b.k === 'doc') break;
            if (b.k === 'item') { b.pstyle = true; break; }
          }
          cont.kind = li.kind;
          cont.marker = li.marker;
          if (cont.kind === 'ol' && cont.start === undefined) cont.start = li.start;
          const item = addChild('item', cont);
          // position at the item's content start; the item's
          // continuation indent requirement is measured from this
          // line's frame base
          const frameCol = S.col;
          advanceOffset(S.nnsCol - S.col, true);
          const pad = li.empty || li.wsCols >= 5 ? 1 : li.wsCols;
          item.indentReq = S.col - frameCol + li.markerLen + pad;
          item.widePad = li.wsCols >= 4;
          advanceOffset(li.markerLen, false);
          advanceOffset(pad, true);
          S.touched = true;
          cont = item;
          continue;
        }
      }
      // indented code block (also when the only open paragraph sits
      // in an unmatched container and cannot take the line lazily:
      // marked's gathering has already ended that item there)
      if (indented && (S.tip.k !== 'para' || (lazyPoison && S.tip === openPara))) {
        if (S.touched) expandLeadingRunInPlace();
        advanceOffset(4, true);
        const b = addChild('code', cont.k === 'list' ? cont.up : cont);
        b.fenced = false;
        b.lines.push(S.line.slice(S.off));
        consumed = true;
        break;
      }
      if (indented && S.tip.k === 'para' && paraIsDefsOnly(S.tip)) {
        // the line may still be a definition title continuation
        const ext = paraText(S.tip) + '\n' + S.line.slice(S.off);
        if (peelDefs(ext).rest === '') {
          addLineToPara(S.tip);
          consumed = true;
          break;
        }
        closeDownTo(cont);
        continue;
      }
      break;
    }
    if (consumed) return;

    // Phase 3: a plain text line.
    if (S.tip.k === 'para' && !lazyPoison) {
      const p = S.tip;
      if (!allMatched) {
        // lazy continuation. A setext-shaped line in an unmatched
        // blockquote paragraph is re-indented instead of dedented.
        if (p.lines.length >= 2 && p.up.k === 'quote' && lastMatched !== p.up &&
            S.indent < 4 && setextShape(S.line.slice(S.nns))) {
          if (p.deepLazy) p.lines.push('');
          p.lines.push('    ' + S.line.slice(S.nns));
          p.deepLast = false;
          p.deepLazy = false;
          p.lastLineBlank = false;
        } else {
          // marked dedents a lazy line by the open containers it
          // failed to match: the item indent requirements in the
          // unmatched chain are consumed first (virtually), then whole
          // groups of 4 extra columns are dropped (at most one group
          // past the requirements); a line matching no item at all
          // drops groups of 4 from its raw indent.
          const reqs = [];
          for (let b = p.up; b && b !== lastMatched; b = b.up) {
            if (b.k === 'item') reqs.push(b.indentReq);
          }
          reqs.reverse();
          let R = 0;
          for (const r of reqs) R += r;
          const n = S.indent;
          let used = 0;
          for (const r of reqs) {
            if (n - used >= r) used += r; else break;
          }
          let strip;
          if (used === R) strip = R + Math.min(4, 4 * Math.floor((n - R) / 4));
          else if (used > 0) strip = used;
          else strip = Math.min(4, 4 * Math.floor(n / 4));
          const deepIn = strip - used >= 4;
          // after a deeply-indented line, a normally-indented line
          // starts a new chunk of the paragraph (blank line inserted)
          if (p.deepLazy && !deepIn) p.lines.push('');
          if (strip > 0) advanceOffset(strip, true);
          const ltxt = contentSlice();
          if (!tryGlue(p, ltxt)) p.lines.push(ltxt);
          p.deepLast = false;
          p.deepLazy = deepIn;
          p.lastLineBlank = false;
        }
      } else {
        // inside a list item, a matched continuation line indented 4+
        // columns past the item's content drops those 4 columns —
        // unless a nested list has already flipped the item into
        // paragraph mode, where such lines stay verbatim
        const deep = p.up.k === 'item' && S.indent >= 4 && !p.up.pstyle;
        if (!deep && (p.deepLast || p.deepLazy)) p.lines.push('');
        if (deep) advanceOffset(4, true);
        addLineToPara(p);
        p.deepLast = deep;
        p.deepLazy = false;
      }
    } else {
      // No open paragraph. A plain line that matched no container can
      // still join the deepest unmatched container whose last child is
      // a list or blockquote, starting a new paragraph there (marked
      // gathers such lines into the container).
      let target = null;
      if (!allMatched && S.indent < 4 && S.tip === oldtip && !prevBlankLine) {
        for (const b of oldChain) {
          if (b === lastMatched) break;
          if ((b.k === 'quote' || b.k === 'item') && b.kids && b.kids.length) {
            const last = b.kids[b.kids.length - 1];
            if (last.k === 'list' || (last.k === 'quote' && b.k === 'item')) { target = b; break; }
          }
        }
      }
      const p = target
        ? addChild('para', target)
        : addChild('para', cont.k === 'list' ? cont.up : cont);
      addLineToPara(p);
    }
  }

  // ------------------------------------------------------------ render

  function renderPara(b, overrideText, prefix) {
    const text = overrideText !== undefined ? overrideText : b.text;
    if (text === '' && prefix === undefined) return '';
    const parent = b.up;
    let tight = parent && parent.k === 'item' && parent.up && parent.up.k === 'list' && parent.up.tight;
    // a paragraph that follows a list inside the item is wrapped in
    // <p> even in a tight list (marked renders it as a loose item part)
    if (tight) {
      const sibs = parent.kids;
      for (let i = 0; i < sibs.length && sibs[i] !== b; i++) {
        if (sibs[i].k === 'list') { tight = false; break; }
      }
    }
    let inner = (prefix || '') + renderInline(text, env);
    // a text-mode item paragraph ending in an indented code chunk
    // keeps the chunk's trailing newline in its text when another
    // block follows immediately (no blank line between): marked's
    // merged code token text ends with that newline
    if (parent && parent.k === 'item' && b.deepLast && !b.lastLineBlank) {
      const sibs = parent.kids;
      if (sibs && sibs[sibs.length - 1] !== b) inner += '\n';
    }
    if (tight) return inner;
    return '<p>' + inner + '</p>\n';
  }

  function renderItem(b) {
    let out = '<li>';
    const kids = b.kids;
    // task list checkbox on the first paragraph
    let taskPara = null;
    let taskChecked = false;
    let taskText = null;
    const first = kids[0];
    if (first && first.k === 'para') {
      const t = first.text;
      if (t.startsWith('[ ] ') || t.startsWith('[x] ') || t.startsWith('[X] ')) {
        taskPara = first;
        taskChecked = t[1] !== ' ';
        taskText = t.slice(4);
      }
    }
    for (const kid of kids) {
      if (kid === taskPara) {
        const cb = taskChecked
          ? '<input checked="" disabled="" type="checkbox"> '
          : '<input disabled="" type="checkbox"> ';
        out += renderPara(kid, taskText, cb);
      } else {
        out += renderBlock(kid);
      }
    }
    return out + '</li>\n';
  }

  function renderBlock(b) {
    switch (b.k) {
      case 'doc':
        return b.kids.map((c) => renderBlock(c)).join('');
      case 'quote':
        if (b.tailHtml && b.tailBlanks === 1) b.tailHtml.tailNl = true;
        return '<blockquote>\n' + b.kids.map((c) => renderBlock(c)).join('') + '</blockquote>\n';
      case 'list': {
        let open;
        if (b.kind === 'ul') open = '<ul>\n';
        else if (b.start === 1 || b.start === undefined || b.start === null) open = '<ol>\n';
        else open = '<ol start="' + b.start + '">\n';
        const close = b.kind === 'ul' ? '</ul>\n' : '</ol>\n';
        // a non-final item whose text ends with an html block plus
        // exactly one blank line renders that block with a trailing
        // newline (the final item's text is trimmed in marked)
        b.kids.forEach((item, i) => {
          if (i < b.kids.length - 1 && item.tailHtml && item.tailBlanks === 1) {
            item.tailHtml.tailNl = true;
          }
        });
        return open + b.kids.map((c) => renderBlock(c)).join('') + close;
      }
      case 'item':
        return renderItem(b);
      case 'para':
        return renderPara(b);
      case 'head':
        return '<h' + b.level + '>' + renderInline(b.text, env) + '</h' + b.level + '>\n';
      case 'hr':
        return '<hr>\n';
      case 'code': {
        const content = b.lines.length ? b.lines.join('\n') + '\n' : '';
        let lang = '';
        if (b.fenced && b.info) lang = unescapeBs(b.info.split(/[ \t]/)[0]);
        return '<pre><code' + (lang ? ' class="language-' + escAttr(lang) + '"' : '') + '>' +
          escFull(content) + '</code></pre>\n';
      }
      case 'html': {
        let out = b.lines.join('\n');
        const keepNL = (b.endKind === 'close'
          ? !!b.trailNL
          : b.up === doc && b.lastLine === totalLines - 1 && srcEndsWithNL) || !!b.tailNl;
        if (keepNL) out += '\n';
        return out;
      }
      case 'table': {
        const alignAttr = (a) => (a ? ' align="' + a + '"' : '');
        let out = '<table>\n<thead>\n<tr>\n';
        b.head.forEach((cell, i) => {
          out += '<th' + alignAttr(b.aligns[i]) + '>' + renderInline(cell, env) + '</th>\n';
        });
        out += '</tr>\n</thead>\n';
        if (b.rows.length) {
          out += '<tbody>';
          for (const row of b.rows) {
            out += '<tr>\n';
            for (let i = 0; i < b.aligns.length; i++) {
              out += '<td' + alignAttr(b.aligns[i]) + '>' + renderInline(row[i] ?? '', env) + '</td>\n';
            }
            out += '</tr>\n';
          }
          out += '</tbody></table>\n';
        } else {
          out += '</table>\n';
        }
        return out;
      }
      default:
        return '';
    }
  }

  // ---------------------------------------------------------------- main

  lines = src.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  totalLines = lines.length;
  for (let li = 0; li < lines.length; li++) {
    lineIndex = li;
    incorporateLine(lines[li]);
  }
  if (S.pendingHtml) {
    S.pendingHtml.trailNL = S.pendingHtml.up === doc && srcEndsWithNL;
    S.pendingHtml = null;
  }
  closeDownTo(doc);
  return renderBlock(doc);
}
