const fs = require("fs");
const path = require("path");
const unzipper = require("unzipper");
const { pipeline } = require("stream");
const { promisify } = require("util");
const pipe = promisify(pipeline);

function isHiddenOrJunk(name) {
  if (!name) return false;
  const lower = name.toLowerCase();
  return (
    name.startsWith(".") ||
    name.startsWith("._") ||
    name === "__MACOSX" ||
    lower === "thumbs.db" ||
    lower === "desktop.ini"
  );
}

// Recursively flatten if there are nested single folders
function flattenSingleFolders(folderPath) {
  if (!fs.existsSync(folderPath)) return;
  let items = fs.readdirSync(folderPath, { withFileTypes: true });

  while (
    items.length === 1 &&
    items[0].isDirectory() &&
    !isHiddenOrJunk(items[0].name)
  ) {
    const singleFolder = path.join(folderPath, items[0].name);
    const inner = fs.readdirSync(singleFolder, { withFileTypes: true });

    for (const e of inner) {
      const oldPath = path.join(singleFolder, e.name);
      const newPath = path.join(folderPath, e.name);
      fs.renameSync(oldPath, newPath);
    }

    try {
      fs.rmSync(singleFolder, { recursive: true, force: true });
    } catch {}
    items = fs.readdirSync(folderPath, { withFileTypes: true });
  }
}

function walkFiles(dir, out = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    if (isHiddenOrJunk(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      walkFiles(full, out);
    } else if (e.isFile()) {
      out.push(full);
    }
  }
  return out;
}

async function extractZip(zipPath, destDir, keepArchives = true) {
  // destDir is the temp dir passed from organizer, e.g. "_temp_<archive>"
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

  // Read central directory first (cleaner than streaming Parse events)
  const zip = await unzipper.Open.file(zipPath);

  // Extract each file safely
  for (const entry of zip.files) {
    if (entry.type === "Directory") continue;

    // Normalize entry path and prevent zip-slip
    const rel = entry.path.replace(/^[\\/]+/, ""); // strip leading slashes
    const targetPath = path.resolve(destDir, rel);
    const destRoot = path.resolve(destDir) + path.sep;
    if (!targetPath.startsWith(destRoot)) {
      // Skip entries attempting to escape destDir
      continue;
    }

    // Create parent dirs
    await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });

    // Stream entry to disk and await completion
    const readStream = entry.stream();
    await pipe(readStream, fs.createWriteStream(targetPath));
  }

  // Flatten "single-folder" zips and collect final file list
  flattenSingleFolders(destDir);
  const extractedFiles = walkFiles(destDir);

  if (!keepArchives && fs.existsSync(zipPath)) {
    try { fs.unlinkSync(zipPath); } catch {}
  }

  return extractedFiles;
}

module.exports = extractZip;