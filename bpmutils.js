const fs = require("fs");
const path = require("path");
const mm = require("music-metadata");

// --- Helpers --------------------------------------------------

const BPM_DIR_RE = /^(\d{2,3})\s*bpm$/i;
const KEY_DIR_RE = /^(?:[A-G](?:#|b)?)\s+(?:Maj|Min)$/i;

function isBpmDirName(name) { return BPM_DIR_RE.test(name); }
function isKeyDirName(name) { return KEY_DIR_RE.test(name); }

function isInsideBpmFolder(filePath) {
  let dir = path.dirname(filePath);
  while (true) {
    const base = path.basename(dir);
    if (isBpmDirName(base)) return true;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return false;
}

function isDuplicatesPath(p) {
  return p.includes(`${path.sep}_Duplicates${path.sep}`) ||
         path.basename(path.dirname(p)) === "_Duplicates";
}

function getParentBpmValue(filePath) {
  const parent = path.basename(path.dirname(filePath));
  const m = parent.match(BPM_DIR_RE);
  return m ? parseInt(m[1], 10) : null;
}

function firstNonBpmAncestorDir(filePath) {
  let dir = path.dirname(filePath);
  while (isBpmDirName(path.basename(dir))) {
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dir;
}

function uniqueDestPath(dir, file) {
  const ext = path.extname(file);
  const base = path.basename(file, ext);
  let candidate = path.join(dir, file);
  let i = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base} (${i})${ext}`);
    i++;
  }
  return candidate;
}

function moveOrCopySync(src, dest) {
  try {
    fs.renameSync(src, dest);
  } catch (e) {
    if (e.code === "EXDEV") {
      fs.copyFileSync(src, dest);
      fs.unlinkSync(src);
    } else {
      throw e;
    }
  }
}

function sanitizeKey(label) {
  return String(label || "").replace(/[<>:"/\\|?*]/g, "").trim();
}

// --- Walk/Metadata ------------------------------------------------------

function walkDir(dir, callback) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkDir(full, callback);
    else if (entry.isFile()) callback(full);
  }
}

async function getFileDuration(filePath) {
  try {
    const metadata = await mm.parseFile(filePath);
    return typeof metadata.format.duration === "number"
      ? metadata.format.duration
      : null;
  } catch {
    return null;
  }
}

// Move into BPM and (optionally) Key
const NAME_BPM_RE = /\b(\d{2,3})\s?bpm\b/i;

function bpmFromName(name) {
  const m = String(name).match(NAME_BPM_RE);
  return m ? Number(m[1]) : null;
}

function moveFileToBPMFolder(file, bpmValue, opts = {}) {
  const { keyValue = null, dryRun = false } = opts;
  const targetBpm = parseInt(bpmValue, 10);
  if (!isFinite(targetBpm)) return null;

  const dirNow = path.dirname(file);
  const currentParentBpm = getParentBpmValue(file);
  const alreadyInTargetBpm = currentParentBpm != null && currentParentBpm === targetBpm;

  const baseDir = firstNonBpmAncestorDir(file);
  const bpmDir = path.join(baseDir, `${targetBpm} BPM`);
  const keyFolder = keyValue ? sanitizeKey(keyValue) : null;
  const finalDir = keyFolder ? path.join(bpmDir, keyFolder) : bpmDir;

  if (alreadyInTargetBpm && (!keyFolder || isKeyDirName(path.basename(dirNow)))) {
    return path.join(finalDir, path.basename(file));
  }

  if (dryRun) return path.join(finalDir, path.basename(file));

  fs.mkdirSync(finalDir, { recursive: true });
  const dest = uniqueDestPath(finalDir, path.basename(file));
  moveOrCopySync(file, dest);
  return dest;
}

// New: move into Key under current dir (or under BPM if currently in a BPM dir)
function moveFileToKeyFolder(file, keyValue, { dryRun = false } = {}) {
  const keyFolder = sanitizeKey(keyValue);
  if (!keyFolder || !KEY_DIR_RE.test(keyFolder)) return null;

  const dirNow = path.dirname(file);
  const parentName = path.basename(dirNow);

  // Already in a "Key" folder?
  if (isKeyDirName(parentName)) {
    return path.join(dirNow, path.basename(file));
  }

  const finalDir = path.join(dirNow, keyFolder);
  if (dryRun) return path.join(finalDir, path.basename(file));

  fs.mkdirSync(finalDir, { recursive: true });
  const dest = uniqueDestPath(finalDir, path.basename(file));
  moveOrCopySync(file, dest);
  return dest;
}

module.exports = {
  walkDir,
  getFileDuration,
  moveFileToBPMFolder,
  moveFileToKeyFolder,
  getParentBpmValue,
  isBpmDirName,
  firstNonBpmAncestorDir,
  isInsideBpmFolder,
  uniqueDestPath,
  isDuplicatesPath,
};