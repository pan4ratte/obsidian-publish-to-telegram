import { writeFileSync } from 'node:fs';

const URL = 'https://core.telegram.org/bots/api';

// ---- HTML entity decoding ----
function decodeEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&'); // last
}

// ---- Tokenizer: split HTML into tags and text ----
function tokenize(html) {
  const tokens = [];
  const re = /<\/?([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)\/?>/g;
  let last = 0;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (m.index > last) {
      tokens.push({ type: 'text', value: html.slice(last, m.index) });
    }
    const raw = m[0];
    const name = m[1].toLowerCase();
    const isClose = raw.startsWith('</');
    const selfClose = raw.endsWith('/>') || ['br', 'img', 'hr', 'input', 'meta', 'link'].includes(name);
    tokens.push({ type: 'tag', name, isClose, selfClose, attrs: m[2], raw });
    last = re.lastIndex;
  }
  if (last < html.length) tokens.push({ type: 'text', value: html.slice(last) });
  return tokens;
}

function getAttr(attrs, attr) {
  const re = new RegExp(attr + '\\s*=\\s*"([^"]*)"|' + attr + "\\s*=\\s*'([^']*)'", 'i');
  const m = attrs.match(re);
  if (!m) return null;
  return decodeEntities(m[1] ?? m[2] ?? '');
}

// ---- Find the "Rich messages" section ----
// We locate the <h3> whose text is "Rich messages" and capture until the next <h3>.
function extractSection(html) {
  // Match all <h3 ...>...</h3>
  const h3re = /<h3\b[^>]*>([\s\S]*?)<\/h3>/gi;
  let m;
  let startIdx = -1;
  let endIdx = html.length;
  const positions = [];
  while ((m = h3re.exec(html)) !== null) {
    const text = decodeEntities(m[1].replace(/<[^>]+>/g, '')).trim();
    positions.push({ index: m.index, end: h3re.lastIndex, text });
  }
  for (let i = 0; i < positions.length; i++) {
    if (positions[i].text === 'Rich messages') {
      startIdx = positions[i].index;
      endIdx = i + 1 < positions.length ? positions[i + 1].index : html.length;
      break;
    }
  }
  if (startIdx === -1) throw new Error('Could not find "Rich messages" <h3>');
  return html.slice(startIdx, endIdx);
}

// ---- Render inline content (text, links, bold, code, br) ----
function renderInline(tokens) {
  let out = '';
  for (const t of tokens) {
    if (t.type === 'text') {
      out += decodeEntities(t.value).replace(/\s+/g, ' ');
    } else if (t.type === 'tag') {
      const n = t.name;
      if (n === 'br') out += ' ';
      else if (n === 'a') {
        if (!t.isClose) {
          const href = getAttr(t.attrs, 'href') || '';
          t._href = href;
          out += 'LINKSTART:' + href + '';
        } else {
          out += 'LINKEND';
        }
      } else if (n === 'strong' || n === 'b') {
        out += '**';
      } else if (n === 'em' || n === 'i') {
        out += '_';
      } else if (n === 'code') {
        out += '`';
      }
      // skip others
    }
  }
  // Resolve link placeholders
  out = out.replace(/LINKSTART:([^]*)([\s\S]*?)LINKEND/g, (_, href, text) => {
    let h = href;
    if (h.startsWith('/')) h = 'https://core.telegram.org' + h;
    if (h.startsWith('#')) h = 'https://core.telegram.org/bots/api' + h;
    return '[' + text.trim() + '](' + h + ')';
  });
  // clean leftover placeholders
  out = out.replace(/LINKEND/g, '').replace(/LINKSTART:[^]*/g, '');
  return out;
}

// Get raw inner HTML between matching open/close at token level
// We'll build a simple recursive parser over tokens to walk the section.

function parse(tokens) {
  // returns array of nodes
  let i = 0;
  function parseChildren(stopNames) {
    const nodes = [];
    while (i < tokens.length) {
      const t = tokens[i];
      if (t.type === 'tag' && t.isClose && stopNames.includes(t.name)) {
        return nodes;
      }
      if (t.type === 'text') {
        nodes.push({ type: 'text', value: t.value });
        i++;
      } else if (t.type === 'tag') {
        if (t.isClose) {
          // stray close that's not our stop — ignore
          i++;
          continue;
        }
        if (t.selfClose) {
          nodes.push({ type: 'element', name: t.name, attrs: t.attrs, children: [], raw: t.raw });
          i++;
        } else {
          const name = t.name;
          const attrs = t.attrs;
          i++;
          const children = parseChildren([name]);
          // consume close
          if (i < tokens.length && tokens[i].type === 'tag' && tokens[i].isClose && tokens[i].name === name) {
            i++;
          }
          nodes.push({ type: 'element', name, attrs, children });
        }
      } else {
        i++;
      }
    }
    return nodes;
  }
  return parseChildren([]);
}

// Get raw text content of a node, verbatim (for <pre>)
function rawText(node) {
  if (node.type === 'text') return decodeEntities(node.value);
  if (node.type === 'element') {
    if (node.name === 'br') return '\n';
    let s = '';
    for (const c of node.children) s += rawText(c);
    return s;
  }
  return '';
}

// Render inline nodes recursively to markdown (for headings, paragraphs, list items, table cells)
function renderInlineNodes(nodes) {
  let out = '';
  for (const node of nodes) {
    if (node.type === 'text') {
      out += decodeEntities(node.value).replace(/\s+/g, ' ');
    } else if (node.type === 'element') {
      const n = node.name;
      if (n === 'br') out += ' ';
      else if (n === 'a') {
        const href = getAttr(node.attrs, 'href') || '';
        let h = href;
        if (h.startsWith('/')) h = 'https://core.telegram.org' + h;
        if (h.startsWith('#')) h = 'https://core.telegram.org/bots/api' + h;
        const text = renderInlineNodes(node.children).trim();
        const cls = getAttr(node.attrs, 'class') || '';
        // Skip Telegram's permalink anchor links (empty/"__" text, class "anchor")
        if (/\banchor\b/.test(cls) || text === '' || text === '__') {
          out += '';
          continue;
        }
        // If link text already equals the href, emit the bare URL to avoid [url](url) noise
        if (text === h || text === href) {
          out += '[' + h + '](' + h + ')';
        } else if (/^\[[^\]]*\]\([^)]*\)$/.test(text)) {
          // text is already a complete markdown link (nested anchor) — don't double-wrap
          out += text;
        } else {
          out += '[' + text + '](' + h + ')';
        }
      } else if (n === 'strong' || n === 'b') {
        out += '**' + renderInlineNodes(node.children).trim() + '**';
      } else if (n === 'em' || n === 'i') {
        out += '_' + renderInlineNodes(node.children).trim() + '_';
      } else if (n === 'code') {
        out += '`' + renderInlineNodes(node.children).replace(/\s+/g, ' ').trim() + '`';
      } else if (n === 'img') {
        const alt = getAttr(node.attrs, 'alt') || '';
        out += alt;
      } else {
        out += renderInlineNodes(node.children);
      }
    }
  }
  return out;
}

function cellText(nodes) {
  // For table cells: render inline but keep markdown, escape pipes
  let s = renderInlineNodes(nodes).replace(/\s+/g, ' ').trim();
  s = s.replace(/\|/g, '\\|');
  return s;
}

function renderBlock(nodes, out) {
  for (const node of nodes) {
    if (node.type === 'text') {
      const t = decodeEntities(node.value).replace(/\s+/g, ' ');
      if (t.trim()) out.push(t.trim());
      continue;
    }
    const n = node.name;
    if (n === 'h3') {
      out.push('### ' + renderInlineNodes(node.children).trim());
    } else if (n === 'h4') {
      out.push('#### ' + renderInlineNodes(node.children).trim());
    } else if (n === 'h5') {
      out.push('##### ' + renderInlineNodes(node.children).trim());
    } else if (n === 'h6') {
      out.push('###### ' + renderInlineNodes(node.children).trim());
    } else if (n === 'p') {
      const s = renderInlineNodes(node.children).trim();
      if (s) out.push(s);
    } else if (n === 'pre') {
      let code = rawText(node);
      // trim leading/trailing blank lines but keep internal
      code = code.replace(/^\n+/, '').replace(/\n+$/, '');
      out.push('```\n' + code + '\n```');
    } else if (n === 'blockquote') {
      const inner = [];
      renderBlock(node.children, inner);
      const text = inner.join('\n\n');
      out.push(text.split('\n').map((l) => '> ' + l).join('\n'));
    } else if (n === 'ul' || n === 'ol') {
      const lines = [];
      let idx = 1;
      const BLOCK = new Set(['p', 'ul', 'ol', 'table', 'pre', 'blockquote', 'div', 'h3', 'h4', 'h5', 'h6']);
      for (const li of node.children) {
        if (li.type === 'element' && li.name === 'li') {
          const marker = n === 'ol' ? idx++ + '. ' : '- ';
          const hasBlock = li.children.some(
            (c) => c.type === 'element' && BLOCK.has(c.name)
          );
          let text;
          if (hasBlock) {
            const liInner = [];
            renderBlock(li.children, liInner);
            text = liInner.join('\n\n').trim();
          } else {
            // pure inline li: keep on one line
            text = renderInlineNodes(li.children).replace(/\s+/g, ' ').trim();
          }
          const linesArr = text.split('\n');
          lines.push(marker + linesArr[0]);
          for (let k = 1; k < linesArr.length; k++) lines.push('  ' + linesArr[k]);
        }
      }
      out.push(lines.join('\n'));
    } else if (n === 'table') {
      out.push(renderTable(node));
    } else if (n === 'div' || n === 'section' || n === 'span' || n === 'tbody' || n === 'thead') {
      renderBlock(node.children, out);
    } else if (n === 'br' || n === 'hr') {
      if (n === 'hr') out.push('---');
    } else {
      // unknown block: render its children
      renderBlock(node.children, out);
    }
  }
}

function renderTable(table) {
  // Gather rows
  const rows = [];
  function collectRows(nodes) {
    for (const node of nodes) {
      if (node.type !== 'element') continue;
      if (node.name === 'tr') {
        const cells = [];
        let isHeader = false;
        for (const c of node.children) {
          if (c.type === 'element' && (c.name === 'th' || c.name === 'td')) {
            if (c.name === 'th') isHeader = true;
            cells.push(cellText(c.children));
          }
        }
        rows.push({ cells, isHeader });
      } else if (node.name === 'thead' || node.name === 'tbody' || node.name === 'tfoot') {
        collectRows(node.children);
      }
    }
  }
  collectRows(table.children);
  if (rows.length === 0) return '';

  const numCols = Math.max(...rows.map((r) => r.cells.length));
  let headerRow;
  let bodyRows;
  if (rows[0].isHeader) {
    headerRow = rows[0].cells;
    bodyRows = rows.slice(1);
  } else {
    headerRow = rows[0].cells;
    bodyRows = rows.slice(1);
  }
  function pad(cells) {
    const c = cells.slice();
    while (c.length < numCols) c.push('');
    return c;
  }
  const lines = [];
  lines.push('| ' + pad(headerRow).join(' | ') + ' |');
  lines.push('| ' + Array(numCols).fill('---').join(' | ') + ' |');
  for (const r of bodyRows) {
    lines.push('| ' + pad(r.cells).join(' | ') + ' |');
  }
  return lines.join('\n');
}

// ---- Main ----
const res = await fetch(URL, { headers: { 'User-Agent': 'Mozilla/5.0' } });
const html = await res.text();
const section = extractSection(html);
const tokens = tokenize(section);
const nodes = parse(tokens);
const out = [];
renderBlock(nodes, out);
let md = out.join('\n\n');
// collapse 3+ blank lines to 2
md = md.replace(/\n{3,}/g, '\n\n');
md = md.trimEnd() + '\n';

const outPath = 'C:/Users/user/Documents/Obsidian/Development/.obsidian/plugins/obsidian-publish-to-telegram/rich-messages-api-temp/rich-messages-api.md';
writeFileSync(outPath, md, 'utf8');
console.log('Wrote', md.length, 'chars,', md.split('\n').length, 'lines to', outPath);
