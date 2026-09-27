/**
 * tools/make-zip.js —— 零依赖 ZIP 打包（不需要引入压缩库）
 *
 * zlib.deflateRawSync 出压缩流，手写 CRC32、本地头、中央目录与 EOCD。
 * 生成后务必用 Python 的 zipfile 校验一遍 CRC 与逐文件一致性：
 *
 *   python -c "import zipfile;z=zipfile.ZipFile(r'<zip>');print(z.testzip())"
 *
 * 用法：node tools/make-zip.js [--out <目录>]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');

// 打进 zip 的内容（只放扩展运行必需的东西与说明）
const INCLUDE_DIRS = ['icons', 'lib', 'src'];
const INCLUDE_FILES = ['manifest.json', 'README.md', 'LICENSE'];

// ---------------------------------------------------------------- CRC32

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------- 时间戳（DOS 格式）

function dosTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

// ---------------------------------------------------------------- 收集文件

function walk(dir, base, out) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
    const full = path.join(dir, entry.name);
    const rel = base ? base + '/' + entry.name : entry.name;
    if (entry.isDirectory()) {
      walk(full, rel, out);
    } else if (entry.isFile()) {
      out.push({ rel, full });
    }
  });
}

function collect() {
  const files = [];
  INCLUDE_FILES.forEach((f) => {
    const full = path.join(ROOT, f);
    if (fs.existsSync(full)) files.push({ rel: f, full });
  });
  INCLUDE_DIRS.forEach((d) => {
    const full = path.join(ROOT, d);
    if (fs.existsSync(full) && fs.statSync(full).isDirectory()) {
      walk(full, d, files);
    }
  });
  return files;
}

// ---------------------------------------------------------------- 打包

function buildZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const now = new Date();
  const { time, date } = dosTime(now);

  entries.forEach((e) => {
    const nameBuf = Buffer.from(e.rel, 'utf8');
    const raw = fs.readFileSync(e.full);
    const deflated = zlib.deflateRawSync(raw, { level: 9 });
    // 压不下去就存原文，别让包变大
    const useDeflate = deflated.length < raw.length;
    const payload = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);              // version needed
    local.writeUInt16LE(0x0800, 6);          // flag: 文件名为 UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);              // extra len

    chunks.push(local, nameBuf, payload);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);                 // version made by
    cd.writeUInt16LE(20, 6);                 // version needed
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(payload.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);                 // extra
    cd.writeUInt16LE(0, 32);                 // comment
    cd.writeUInt16LE(0, 34);                 // disk number
    cd.writeUInt16LE(0, 36);                 // internal attrs
    cd.writeUInt32LE(0, 38);                 // external attrs
    cd.writeUInt32LE(offset, 42);            // local header offset
    central.push(Buffer.concat([cd, nameBuf]));

    offset += local.length + nameBuf.length + payload.length;

    e._size = raw.length;
    e._packed = payload.length;
    // 必须补零到 8 位：crc 的高位是 0 时 toString(16) 会短一位，外部按 %08x 比对就会误报
    e._crc = (crc >>> 0).toString(16).padStart(8, '0');
  });

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, centralBuf, eocd]);
}

/** 从 manifest 结构里收集它引用的所有文件（扩展装上去会按这些路径去找） */
function collectManifestRefs(manifest) {
  const refs = new Set();
  const add = (v) => { if (typeof v === 'string' && v) refs.add(v); };

  if (manifest.background) add(manifest.background.service_worker);
  if (manifest.action) {
    add(manifest.action.default_popup);
    if (manifest.action.default_icon && typeof manifest.action.default_icon === 'object') {
      Object.keys(manifest.action.default_icon).forEach((k) => add(manifest.action.default_icon[k]));
    }
  }
  if (manifest.icons && typeof manifest.icons === 'object') {
    Object.keys(manifest.icons).forEach((k) => add(manifest.icons[k]));
  }
  (manifest.content_scripts || []).forEach((cs) => {
    (cs.js || []).forEach(add);
    (cs.css || []).forEach(add);
  });
  return [...refs];
}

// ---------------------------------------------------------------- 入口

function main() {
  const argv = process.argv.slice(2);
  let outDir = null;
  let writeList = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out' && argv[i + 1]) outDir = argv[i + 1];
    if (argv[i] === '--list') writeList = true;
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  const version = manifest.version;

  const entries = collect();
  entries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));

  // manifest 里声明的文件必须都在包里，否则装上去直接报错
  const refs = collectManifestRefs(manifest);
  const inZip = new Set(entries.map((e) => e.rel));
  const missing = refs.filter((r) => !inZip.has(r));
  if (missing.length) {
    console.error('✗ manifest 引用了但没打进包的文件：' + missing.join(', '));
    process.exit(1);
  }

  const buf = buildZip(entries);

  const targetDir = outDir
    ? path.resolve(outDir)
    : path.join(ROOT, 'dist-extension-v' + version);
  fs.mkdirSync(targetDir, { recursive: true });

  const name = 'BASFCaptions-v' + version + '.zip';
  const outPath = path.join(targetDir, name);
  fs.writeFileSync(outPath, buf);

  const totalRaw = entries.reduce((s, e) => s + e._size, 0);
  console.log('打包完成');
  console.log('  产物：' + outPath);
  console.log('  文件：' + entries.length + ' 个，原始 ' + totalRaw + ' 字节，压缩后 ' + buf.length + ' 字节');
  console.log('  manifest 引用的 ' + refs.length + ' 个文件已全部包含');
  entries.forEach((e) => {
    console.log('    ' + e.rel.padEnd(28) + String(e._size).padStart(7) + ' → ' + String(e._packed).padStart(7));
  });

  if (writeList) {
    // 给外部校验脚本用（逐文件比对 CRC 与 MD5）。默认不写，
    // 免得产物目录里留下 _*.json 这类中转文件。
    const listPath = path.join(targetDir, 'zipfile-list.json');
    fs.writeFileSync(listPath, JSON.stringify({
      zip: outPath,
      bytes: buf.length,
      files: entries.map((e) => ({
        name: e.rel,
        size: e._size,
        crc32: e._crc,
        md5: require('crypto').createHash('md5').update(fs.readFileSync(e.full)).digest('hex')
      }))
    }, null, 2), 'utf8');
    console.log('  校验清单：' + listPath);
  }
}

main();
