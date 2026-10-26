'use strict';
/* ============================================================================
   xlsx.js —— 极简 XLSX 读写（零依赖，只用 node:zlib）
   ----------------------------------------------------------------------------
   为什么自己写：这个项目坚持「零 npm 依赖、单文件部署」，装了依赖就要 npm install、
   就要联网、就要考虑不同 CPU 架构的原生模块。xlsx 本质就是一个装着 XML 的 zip，
   Node 自带的 zlib 足够解压和压缩，所以这里自己实现一遍，几十 KB 代码换掉一个依赖树。

   能力范围（够用就好，不追求完整实现 ECMA-376）：
     读：zip（store / deflate）→ workbook.xml 取工作表名与顺序 → rels 解析真实路径
         → sharedStrings + inlineStr + 数字/布尔 → 二维数组
         识别日期样式（numFmtId 或自定义格式里的 y/m/d），把日期序列号还原成 YYYY-MM-DD
     写：多工作表、表头加粗灰底、日期写真日期、列宽、冻结首行、自动筛选
   ============================================================================ */

const zlib = require('node:zlib');

/* ---------------------------------------------------------------- CRC32 --- */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/* ------------------------------------------------------------- 读 zip --- */

const SIG_EOCD = 0x06054b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;

/* 解压后单文件上限，防止 zip 炸弹把内存吃光 */
const MAX_ENTRY = 64 * 1024 * 1024;

function unzip(buf) {
  // 从尾部往前找 EOCD（结尾可能带最多 64KB 注释）
  let eocd = -1;
  const from = Math.max(0, buf.length - 0x10000 - 22);
  for (let i = buf.length - 22; i >= from; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 xlsx 文件（找不到 zip 结尾标记）');

  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const files = new Map();

  for (let n = 0; n < count; n++) {
    // 恶意或损坏的文件里目录偏移可能指向缓冲区外，先确认能读完这条记录
    if (off + 46 > buf.length) break;
    if (buf.readUInt32LE(off) !== SIG_CEN) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString('utf8');

    if (localOff + 30 <= buf.length && buf.readUInt32LE(localOff) === SIG_LOC) {
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const start = localOff + 30 + lNameLen + lExtraLen;
      const raw = buf.subarray(start, Math.min(start + compSize, buf.length));
      if (method === 0) {
        files.set(name, raw);
      } else if (method === 8) {
        try {
          files.set(name, zlib.inflateRawSync(raw, { maxOutputLength: MAX_ENTRY }));
        } catch { /* 单条损坏就跳过它，别整份文件打不开 */ }
      }
      // 其它压缩方法（极少见）直接忽略
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

/* ------------------------------------------------------------- 写 zip --- */

function zip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const [name, content] of files) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
    const nameBuf = Buffer.from(name, 'utf8');
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    // 压不小就别压，省得比原文还大
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(data);

    const loc = Buffer.alloc(30);
    loc.writeUInt32LE(SIG_LOC, 0);
    loc.writeUInt16LE(20, 4);           // version needed
    loc.writeUInt16LE(0x0800, 6);       // flag: UTF-8 文件名
    loc.writeUInt16LE(method, 8);
    loc.writeUInt16LE(0, 10);           // time
    loc.writeUInt16LE(0x21, 12);        // date（1980-01-01，固定值保证可复现）
    loc.writeUInt32LE(crc, 14);
    loc.writeUInt32LE(body.length, 18);
    loc.writeUInt32LE(data.length, 22);
    loc.writeUInt16LE(nameBuf.length, 26);
    loc.writeUInt16LE(0, 28);
    locals.push(loc, nameBuf, body);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(SIG_CEN, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt16LE(0, 12);
    cen.writeUInt16LE(0x21, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt16LE(0, 30);           // extra
    cen.writeUInt16LE(0, 32);           // comment
    cen.writeUInt16LE(0, 34);           // disk
    cen.writeUInt16LE(0, 36);           // internal attr
    cen.writeUInt32LE(0, 38);           // external attr
    cen.writeUInt32LE(offset, 42);
    centrals.push(cen, nameBuf);

    offset += loc.length + nameBuf.length + body.length;
  }

  const cenBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(centrals.length / 2, 8);
  eocd.writeUInt16LE(centrals.length / 2, 10);
  eocd.writeUInt32LE(cenBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, cenBuf, eocd]);
}

/* ---------------------------------------------------------------- XML --- */

const decodeXml = (s) => String(s)
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'")
  .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&amp;/g, '&');

const encodeXml = (s) => String(s)
  // 去掉 XML 1.0 不允许出现的控制字符，否则 Excel 打不开
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const attr = (tag, name) => {
  const m = tag.match(new RegExp('\\b' + name + '="([^"]*)"'));
  return m ? decodeXml(m[1]) : '';
};

/* 列号字母 → 0 基下标：A→0, Z→25, AA→26 */
function colIndex(ref) {
  const m = String(ref).match(/^([A-Z]+)/i);
  if (!m) return 0;
  let n = 0;
  for (const ch of m[1].toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

const colName = (i) => {
  let s = '';
  let n = i + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
};

/* ------------------------------------------------------------ 日期处理 --- */

const EXCEL_EPOCH = Date.UTC(1899, 11, 30);   // Excel 的 0 天（含 1900 闰年 bug 的常规做法）

function serialToDate(n) {
  const d = new Date(EXCEL_EPOCH + Math.round(n) * 86400000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function dateToSerial(ymd) {
  const m = String(ymd).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const t = Date.UTC(y, mo - 1, d);
  // Date.UTC 会把 2026-13-01 自动滚到 2027-01-01，回读比对才能识别出非法日期
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  const n = Math.round((t - EXCEL_EPOCH) / 86400000);
  return n > 0 ? n : null;
}

/* 内置的日期格式号 */
const BUILTIN_DATE_FMT = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

function isDateFormatCode(code) {
  // 去掉引号里的字面量和颜色/条件段，再看有没有年月日占位
  const s = String(code || '')
    .replace(/"[^"]*"/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\\./g, '');
  return /[ymd]/i.test(s) && !/^[#0.,%\s]+$/.test(s);
}

/* 读表上限：正常台账几百行，给到 20000 行 × 200 列已经绰绰有余，
   超过就截断——防止有人拿一个巨大的表把服务内存撑爆。 */
const MAX_ROWS = 20000;
const MAX_COLS = 200;

/* --------------------------------------------------------------- 读 xlsx --- */

function readWorkbook(buf) {
  const files = unzip(buf);
  const text = (name) => {
    const b = files.get(name);
    return b ? b.toString('utf8') : '';
  };

  /* 共享字符串 */
  const shared = [];
  const sst = text('xl/sharedStrings.xml');
  if (sst) {
    for (const m of sst.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
      // 一个 si 里可能有多段 <t>（富文本），拼起来
      let s = '';
      for (const t of m[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) s += decodeXml(t[1]);
      shared.push(s);
    }
  }

  /* 样式：cellXfs 里每一档的 numFmtId，用来判断这一格是不是日期 */
  const dateStyles = [];
  const styles = text('xl/styles.xml');
  if (styles) {
    const custom = new Map();
    for (const m of styles.matchAll(/<numFmt\b[^>]*>/g)) {
      custom.set(Number(attr(m[0], 'numFmtId')), attr(m[0], 'formatCode'));
    }
    const cx = styles.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/);
    if (cx) {
      for (const m of cx[1].matchAll(/<xf\b[^>]*>/g)) {
        const id = Number(attr(m[0], 'numFmtId') || 0);
        dateStyles.push(BUILTIN_DATE_FMT.has(id) || (custom.has(id) && isDateFormatCode(custom.get(id))));
      }
    }
  }
  const isDateStyle = (s) => {
    if (s === '' || s === null) return false;
    const i = Number(s);
    return Number.isInteger(i) && dateStyles[i] === true;
  };

  /* 工作表：名字 + 顺序 + 真实路径 */
  const wb = text('xl/workbook.xml');
  const rels = text('xl/_rels/workbook.xml.rels');
  const relMap = new Map();
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    relMap.set(attr(m[0], 'Id'), attr(m[0], 'Target'));
  }

  const sheets = [];
  for (const m of wb.matchAll(/<sheet\b[^>]*>/g)) {
    const tag = m[0];
    const name = attr(tag, 'name');
    const rid = attr(tag, 'r:id') || attr(tag, 'id');
    let target = relMap.get(rid) || '';
    if (target && !target.startsWith('xl/')) {
      target = target.startsWith('/') ? target.slice(1) : 'xl/' + target.replace(/^\.\//, '');
    }
    sheets.push({ name, path: target });
  }
  if (!sheets.length) {
    // 有些工具不写 workbook.xml 的 rels，退化成按文件名排序
    for (const k of [...files.keys()].filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort()) {
      sheets.push({ name: k.replace(/^.*\//, '').replace(/\.xml$/, ''), path: k });
    }
  }

  const out = [];
  for (const sh of sheets) {
    const xml = text(sh.path);
    const rows = [];
    if (xml) {
      for (const rm of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
        if (rows.length >= MAX_ROWS) break;
        const rAttr = rm[1];
        const rNum = Number(attr('x' + rAttr, 'r')) || rows.length + 1;
        const cells = [];
        for (const cm of rm[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
          const cAttr = 'x' + cm[1];
          const inner = cm[2] || '';
          const ref = attr(cAttr, 'r');
          const idx = ref ? colIndex(ref) : cells.length;
          if (idx >= MAX_COLS) continue;
          const type = attr(cAttr, 't');
          const style = attr(cAttr, 's');

          let val = '';
          if (type === 'inlineStr') {
            let s = '';
            for (const t of inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) s += decodeXml(t[1]);
            val = s;
          } else if (type === 's') {
            const vm = inner.match(/<v>([\s\S]*?)<\/v>/);
            val = vm ? (shared[Number(vm[1])] ?? '') : '';
          } else if (type === 'str') {
            const vm = inner.match(/<v>([\s\S]*?)<\/v>/);
            val = vm ? decodeXml(vm[1]) : '';
          } else if (type === 'b') {
            const vm = inner.match(/<v>([\s\S]*?)<\/v>/);
            val = vm && vm[1].trim() === '1' ? 'TRUE' : 'FALSE';
          } else if (type === 'e') {
            val = '';
          } else {
            const vm = inner.match(/<v>([\s\S]*?)<\/v>/);
            if (vm) {
              const raw = vm[1].trim();
              // 数字带日期样式 → 还原成 YYYY-MM-DD，导回来时用户看到的还是日期
              if (isDateStyle(style) && /^-?\d+(\.\d+)?$/.test(raw) && Number(raw) > 0) {
                val = serialToDate(Number(raw));
              } else {
                val = raw;
              }
            }
          }
          cells[idx] = val;
        }
        // 补齐空洞，避免稀疏数组
        const row = [];
        for (let i = 0; i < cells.length; i++) row.push(cells[i] === undefined ? '' : cells[i]);
        rows[Math.max(0, rNum - 1)] = row;
      }
    }
    // 补齐空行，保持行号对应
    const dense = [];
    for (let i = 0; i < rows.length; i++) dense.push(rows[i] || []);
    out.push({ name: sh.name, rows: dense });
  }

  return { sheets: out };
}

/* --------------------------------------------------------------- 写 xlsx --- */

/* 样式索引：0 普通、1 日期、2 表头、3 正文自动换行 */
const S_NORMAL = 0;
const S_DATE = 1;
const S_HEAD = 2;
const S_WRAP = 3;

function stylesXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/></numFmts>
<fonts count="2">
<font><sz val="11"/><color theme="1"/><name val="\u5fae\u8f6f\u96c5\u9ed1"/><family val="2"/></font>
<font><b/><sz val="11"/><color theme="1"/><name val="\u5fae\u8f6f\u96c5\u9ed1"/><family val="2"/></font>
</fonts>
<fills count="3">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFF1F3F6"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="4">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
}

/* 单元格内容分类：日期（YYYY-MM-DD）、数字、文本 */
function cellXml(ref, value, style) {
  if (value === null || value === undefined || value === '') {
    return `<c r="${ref}"${style ? ` s="${style}"` : ''}/>`;
  }
  const s = String(value);
  const serial = dateToSerial(s);
  if (serial !== null && style !== S_HEAD) {
    return `<c r="${ref}" s="${S_DATE}"><v>${serial}</v></c>`;
  }
  if (/^-?\d+(\.\d+)?$/.test(s) && s.length <= 15 && style !== S_HEAD) {
    return `<c r="${ref}" s="${S_NORMAL}"><v>${s}</v></c>`;
  }
  return `<c r="${ref}" t="inlineStr"${style ? ` s="${style}"` : ''}><is><t xml:space="preserve">${encodeXml(s)}</t></is></c>`;
}

/**
 * sheets: [{ name, header?: string[], rows: any[][], widths?: number[], freeze?: boolean, filter?: boolean }]
 */
function writeWorkbook(sheets) {
  const files = [];
  const sheetXmls = [];

  sheets.forEach((sh, i) => {
    const header = Array.isArray(sh.header) ? sh.header : null;
    const rows = Array.isArray(sh.rows) ? sh.rows : [];
    const colCount = Math.max(
      header ? header.length : 0,
      ...rows.map((r) => (Array.isArray(r) ? r.length : 0)),
      1
    );

    const parts = [];
    parts.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>');
    parts.push('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">');
    parts.push(`<dimension ref="A1:${colName(colCount - 1)}${rows.length + (header ? 1 : 0) + 1}"/>`);
    if (sh.freeze) {
      parts.push('<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>');
    }
    if (Array.isArray(sh.widths) && sh.widths.length) {
      parts.push('<cols>');
      sh.widths.forEach((w, ci) => {
        if (ci >= colCount) return;
        parts.push(`<col min="${ci + 1}" max="${ci + 1}" width="${Number(w) || 10}" customWidth="1"/>`);
      });
      parts.push('</cols>');
    }
    parts.push('<sheetData>');

    let r = 1;
    if (header) {
      parts.push(`<row r="${r}" ht="22" customHeight="1">`);
      header.forEach((h, ci) => parts.push(cellXml(colName(ci) + r, h, S_HEAD)));
      parts.push('</row>');
      r++;
    }
    for (const row of rows) {
      const arr = Array.isArray(row) ? row : [];
      parts.push(`<row r="${r}">`);
      for (let ci = 0; ci < colCount; ci++) {
        const v = arr[ci];
        parts.push(cellXml(colName(ci) + r, v, S_WRAP));
      }
      parts.push('</row>');
      r++;
    }
    parts.push('</sheetData>');
    if (sh.filter && header) {
      parts.push(`<autoFilter ref="A1:${colName(colCount - 1)}${rows.length + 1}"/>`);
    }
    parts.push('</worksheet>');

    const path = `xl/worksheets/sheet${i + 1}.xml`;
    files.push([path, parts.join('')]);
    sheetXmls.push({ path, name: sh.name || `Sheet${i + 1}` });
  });

  files.push(['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
${sheetXmls.map((s, i) => `<Override PartName="/${s.path}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n')}
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`]);

  files.push(['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`]);

  files.push(['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${sheetXmls.map((s, i) => `<sheet name="${encodeXml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>
</workbook>`]);

  files.push(['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheetXmls.map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('\n')}
<Relationship Id="rId${sheetXmls.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`]);

  files.push(['xl/styles.xml', stylesXml()]);

  return zip(files);
}

/* ------------------------------------------------------------------ CSV --- */

/* 导出 CSV：带 BOM，Excel 双击打开不乱码 */
function toCsv(rows) {
  const cell = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return '\ufeff' + rows.map((r) => (Array.isArray(r) ? r : []).map(cell).join(',')).join('\r\n') + '\r\n';
}

/* 解析 CSV（支持引号、双引号转义、字段内换行） */
function parseCsv(text) {
  const src = String(text).replace(/^\ufeff/, '');
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; }
        else quoted = false;
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === ',') { row.push(cell); cell = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; continue; }
    cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

module.exports = { readWorkbook, writeWorkbook, toCsv, parseCsv, serialToDate, dateToSerial };
