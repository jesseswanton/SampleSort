const fs = require("fs");
const path = require("path");
const mm = require("music-metadata");
const extractZip = require("./extractZip");
const { extractRarArchive } = require("./extractRar");
const crypto = require("crypto");

// -------------------- Helpers --------------------
// trim whitespace
const normalizeKeywords = (list) =>
    (Array.isArray(list) ? list : [])
        .map(k => String(k).trim())
        .filter(k => k.length > 0);

const _yield = () => new Promise(r => setImmediate(r));
let cancelRequested = false;
function requestCancel() { cancelRequested = true; }

function getAllFiles(dir) {
    let results = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
    if (isHiddenName(entry.name)) continue; // skip hidden/system names

    const fullPath = path.join(dir, entry.name);
    try {
        if (entry.isDirectory()) {
        results = results.concat(getAllFiles(fullPath));
        } else if (entry.isFile()) {
        if (isHiddenName(path.basename(fullPath))) continue;
        results.push(fullPath);
        }
    } catch {
        // Inaccessible entries are skipped silently
        continue;
    }
    }
    return results;
}

// Move or copy files
function moveOrCopySync(src, dest, move) {
    if (!move) {
    fs.copyFileSync(src, dest);
    return;
    }
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

function isHiddenName(name) {
    // Skip dotfiles/folders and common system junk
    if (name.startsWith('.') || name.startsWith('._')) return true; // .DS_Store, ._resource
    const lower = name.toLowerCase();
    return lower === 'thumbs.db' || lower === 'desktop.ini' || name === '__MACOSX';
}

// Remove folder recursively
function removeFolderRecursive(folderPath) {
  if (fs.existsSync(folderPath)) {
    fs.readdirSync(folderPath).forEach((file) => {
      const curPath = path.join(folderPath, file);
      if (fs.lstatSync(curPath).isDirectory()) {
        removeFolderRecursive(curPath);
      } else {
        fs.unlinkSync(curPath);
      }
    });
    fs.rmSync(folderPath, { recursive: true, force: true });
  }
}

// Avoid overwritting same file names
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

function flattenMainCategories(cfg) {
    if (Array.isArray(cfg.mainCategories) && cfg.mainCategories.length) {
      const out = [];
      for (const m of cfg.mainCategories) {
        for (const c of (m.categories || [])) {
          out.push({
            main: m.name,
            category: c.name,
            keywords: normalizeKeywords(c.keywords || []),
            matchAll: !!c.matchAll
          });
        }
      }
      return out;
    }
    const out = [];
    for (const [cat, keywords] of Object.entries(cfg.categories || {})) {
      out.push({ main: "", category: cat, keywords: normalizeKeywords(keywords) });
    }
    return out;
}

function matchesKeywords(ent, hay) {
  const ks = (ent.keywords || []).map(k => normalizeString(k)).filter(Boolean);
  if (ks.length === 0) return false;
  const H = normalizeString(hay);
  return ent.matchAll
    ? ks.every(k => H.includes(k))
    : ks.some(k => H.includes(k));
}

// ---- Extension helpers (normalize dot/case) ----
const normalizeExtList = (list) =>
    (Array.isArray(list) ? list : [])
    .map(e => String(e).trim().toLowerCase().replace(/^\./, ""));

const getExt = (p) => path.extname(p).slice(1).toLowerCase();

const isAcceptedExt = (p, config) => {
    const accepted = normalizeExtList(config.extensions);
    if (accepted.length === 0) return true;
    return accepted.includes(getExt(p));
};

// Sample Pack and collection folder name
function sanitizeFolderName(s = "") {
  return String(s).replace(/[<>:"/\\|?*]/g, "").trim();
}

function packLabelFromSamples(absFile, samplesDir) {
  if (!samplesDir) return null;
  const root = path.resolve(samplesDir);
  const abs  = path.resolve(absFile);

  if (!abs.startsWith(root + path.sep)) return null;

  const rel  = abs.slice(root.length + 1);
  const segs = rel.split(path.sep).filter(Boolean);

  if (segs.length === 0) return null;

  const pack = sanitizeFolderName(segs[0]);
  const collection = (segs.length >= 3) ? sanitizeFolderName(segs[1]) : null;

  return collection ? `${pack} (${collection})` : pack;
}

function packLabelFromTemp(absFile, destDir) {
  const destRoot = path.resolve(destDir) + path.sep;
  const p = path.resolve(absFile);
  if (!p.startsWith(destRoot)) return null;

  const relFromDest = p.slice(destRoot.length);           // "_temp_MyPack.zip/sub/file.wav"
  const firstSeg    = relFromDest.split(path.sep)[0] || ""; // "_temp_MyPack.zip"
  const m = firstSeg.match(/^_temp_(.+)$/);
  if (!m) return null;

  // Remove archive extension and sanitize
  return sanitizeFolderName(m[1].replace(/\.(zip|rar)$/i, ""));
}

//Hash for deduplication
function computeFileHash(filePath, algo = "sha1") {
    return new Promise((resolve, reject) => {
        const h = crypto.createHash(algo);
        const s = fs.createReadStream(filePath);
        s.on("error", reject);
        s.on("data", chunk => h.update(chunk));
        s.on("end", () => resolve(h.digest("hex")));
    });
}

function tokenizeWords(s) {
    return String(s).toLowerCase().split(/[^a-z0-9#]+/i).filter(Boolean);
  }
  
function matchesAny(haystacks, keywords) {
  const phrases = (keywords || []).map(k => String(k).toLowerCase());
  return phrases.some(p => haystacks.some(h => h.includes(p)));
}

function matchesAllWords(haystacks, keywords) {
  const tokens = (keywords || []).flatMap(tokenizeWords);
  if (tokens.length === 0) return false;
  return tokens.every(t => haystacks.some(h => h.includes(t)));
}

// normalize strings for keyword matching
function normalizeString(s) {
  return String(s)
    .toLowerCase()
    .replace(/[-_]+/g, " ")   // treat - and _ like spaces
    .replace(/\s+/g, " ")
    .trim();
}
  
// -------------------- Core Categorization --------------------
async function categorizeFile(fullPath, config, webContents, dedupe) {
  const fileName = path.basename(fullPath);
  if (isHiddenName(fileName)) return;

  const relativePath = path.relative(config.samplesDir, fullPath);
  const parentFolder = path.dirname(relativePath).split(path.sep).pop();
  const ext = getExt(fullPath);
  const isMidi = (ext === "mid" || ext === "midi");

  // Accept/skip by extension
  if (!isAcceptedExt(fullPath, config)) {
    webContents.send("organizing-log",
      `Skipped <b>${fileName}</b> (unaccepted extension: .${ext})`,
      "info");
    return;
  }

  // Dedup (early)
  if (dedupe?.enabled) {
    if (cancelRequested) return;
    try {
      const hash = await computeFileHash(fullPath, dedupe.algo);
      const firstSeen = dedupe.map.get(hash);
      if (firstSeen) {
        const msg = `Duplicate detected: <b>${fileName}</b> (same as <b>${path.basename(firstSeen)}</b>)`;
        if (config.dryRun) {
          webContents.send("organizing-log", `[DRY RUN] ${msg}`, "warning");
        } else if (dedupe.mode === "skip") {
          webContents.send("organizing-log", `${msg}. Skipped.`, "warning");
        } else if (dedupe.mode === "quarantine") {
          const qDir = dedupe.quarantineDir;
          if (!fs.existsSync(qDir)) fs.mkdirSync(qDir, { recursive: true });
          const dest = uniqueDestPath(qDir, fileName);
          moveOrCopySync(fullPath, dest, config.moveFiles);
          webContents.send("organizing-log", `${msg}. Sent to _Duplicates.`, "warning");
        }
        return;
      }
      dedupe.map.set(hash, fullPath);
    } catch (e) {
      webContents.send("organizing-log", `Hashing failed for <b>${fileName}</b>: ${e.message}`, "error");
    }
  }

  // Category matching
  const spec = config._flatCategories || [];
  let matched = null;
  let usedParentFolder = false;

  const fileHay = fileName.toLowerCase();
  for (const ent of spec) {
    if (matchesKeywords(ent, fileHay)) { matched = ent; break; }
  }
  if (!matched && config.checkParentFolder && parentFolder) {
    const parentHay = normalizeString(parentFolder);
    for (const ent of spec) {
      if (matchesKeywords(ent, parentHay)) { matched = ent; usedParentFolder = true; break; }
    }
  }

  // Build base relative target
  let targetRel = matched
    ? (matched.main ? path.join(matched.main, matched.category) : matched.category)
    : "Miscellaneous";

  // Optional length subfolder (compute once)
  if (config.checkLength) {
    const lenThresh = Number(config.lengthThreshold) || 0;
    if (lenThresh > 0) {
      try {
        const { format: { duration } = {} } = await mm.parseFile(fullPath);
        const dur = Number(duration);
        if (Number.isFinite(dur) && dur > lenThresh) {
          const base = path.basename(targetRel);
          const suffix = ` - Over ${lenThresh} seconds`;
          if (!base.endsWith(suffix)) {
            targetRel = path.join(targetRel, `${base}${suffix}`);
          }
        }
      } catch {
        webContents.send("organizing-log", `Could not read duration for ${fileName}`, "info");
      }
    }
  }

  // Pack label (if enabled)
  let packLabel = null;
  if (config.keepPackSubfolder) {
    packLabel = packLabelFromSamples(fullPath, config.samplesDir)
            || packLabelFromTemp(fullPath, config.destDir);
  }

  // ----- MIDI branch: force under <dest>/MIDI[/<pack>] -----
  if (config.sortMidiToFolder && isMidi) {
    const midiRootName = (config.midiFolderName || "MIDI").trim() || "MIDI";
    const midiRel = packLabel ? [midiRootName, packLabel] : [midiRootName];
    const targetPath = path.join(config.destDir, ...midiRel);

    const destPlanned = path.join(targetPath, fileName);

    try {
      const action = config.moveFiles ? "Moved" : "Copied";
      if (!config.dryRun) {
        fs.mkdirSync(targetPath, { recursive: true });
        const dest = uniqueDestPath(targetPath, fileName);
        moveOrCopySync(fullPath, dest, config.moveFiles);

        const displayAction = action;
        webContents.send(
          "organizing-log",
          `${displayAction} <b>${fileName}</b> → <b>${dest}</b>`,
          "success"
        );

        return { src: fullPath, dest };
      } else {

        const displayAction = `[DRY RUN] ${action}`;
        webContents.send(
          "organizing-log",
          `${displayAction} <b>${fileName}</b> → <b>${destPlanned}</b>`,
          "success"
        );

        return { src: fullPath, dest: destPlanned };
      }
    } catch (err) {
      webContents.send(
        "organizing-log",
        `Error processing <b>${fileName}</b>: ${err.message}`,
        "error"
      );
      return null;
    }
  }

  // Non-MIDI: attach pack folder if requested
  if (config.keepPackSubfolder && packLabel) {
    packLabel = packLabel.replace(/[<>:"/\\|?*]/g, "").trim();
    targetRel = path.join(targetRel, packLabel);
  }

  // Final destination directory (after category + optional pack)
  const targetPath = path.join(config.destDir, targetRel);

  // Planned destination (for dry run logging)
  const destPlanned = path.join(targetPath, fileName);

  // Optional extra info for logs
  const logExtra = usedParentFolder ? ` (parent folder: <b>${parentFolder}</b>)` : "";

  try {
    const action = config.moveFiles ? "Moved" : "Copied";

    if (!config.dryRun) {
      fs.mkdirSync(targetPath, { recursive: true });
      const dest = uniqueDestPath(targetPath, fileName);
      moveOrCopySync(fullPath, dest, config.moveFiles);

      // Log actual final path (uniqueDestPath may add a suffix)
      webContents.send(
        "organizing-log",
        `${action} <b>${fileName}</b> → <b>${dest}</b>${logExtra}`,
        "success"
      );

      // Return for "files moved this run" index
      return { src: fullPath, dest };
    } else {
      // Dry run: show exactly where it would go
      webContents.send(
        "organizing-log",
        `[DRY RUN] ${action} <b>${fileName}</b> → <b>${destPlanned}</b>${logExtra}`,
        "success"
      );

      // Optional: return planned path if you want a preview list
      return { src: fullPath, dest: destPlanned };
    }
  } catch (err) {
    webContents.send(
      "organizing-log",
      `Error processing <b>${fileName}</b>: ${err.message}`,
      "error"
    );
    return null;
  }
}
 
// -------------------- Organizer --------------------
async function startOrganizing(config, webContents) {
  cancelRequested = false;
    if (!fs.existsSync(config.samplesDir)) {
      webContents.send(
        "organizing-log",
        `Error: Samples directory <b>${config.samplesDir}</b> does not exist`,
        "error"
      );
      return;
    }
  
    if (!config.destDir) {
        webContents.send("organizing-log", "Error: Destination directory is empty.", "error");
        return;
    }
    if (!fs.existsSync(config.destDir)) {
        try {
        fs.mkdirSync(config.destDir, { recursive: true });
        webContents.send("organizing-log", `Created destination folder <b>${config.destDir}</b>.`, "info");
        } catch (e) {
        webContents.send(
            "organizing-log",
            `Error: Could not create destination folder <b>${config.destDir}</b>: ${e.message}`,
            "error"
        );
        return;
        }
    }

    const movedThisRun = [];
      
    const flatCats = flattenMainCategories(config);
    config._flatCategories = flatCats; // stash for categorizeFile

    // --- Deduplication Setup ---
    const dedupe = {
        enabled: !!config.dedupeEnabled,
        algo: config.dedupeAlgo || "sha256",
        mode: config.dedupeMode || "skip",
        preferDest: config.dedupePreferDest !== false,
        map: new Map(),
        quarantineDir: path.join(config.destDir, "_Duplicates")
      };
    
      if (dedupe.enabled && dedupe.mode === "quarantine" && !config.dryRun) {
        if (!fs.existsSync(dedupe.quarantineDir)) {
          fs.mkdirSync(dedupe.quarantineDir, { recursive: true });
        }
      }
    
      if (dedupe.enabled && dedupe.preferDest) {
        webContents.send("organizing-log", "Indexing destination files for duplicate detection.", "info");
        const destFiles = getAllFiles(config.destDir);
          let seeded = 0;
          let j = 0;
          for (const f of destFiles) {
              if (cancelRequested) {
              webContents.send("organizing-log", "⏹️ Cancelled during duplicate indexing.", "warning");
              break;
              }

            if (!isAcceptedExt(f, config)) continue;

            try {
              const h = await computeFileHash(f, dedupe.algo);
              if (!dedupe.map.has(h)) {
                dedupe.map.set(h, f);
                seeded++;
              }
            } catch {}
            if ((++j % 50) === 0) await _yield();
          }
          
          if (!cancelRequested) {
            webContents.send("organizing-log",
              `Indexed ${seeded} destination files for duplicate detection.`,
              "warning"
            );
          } else {
            webContents.send("organizing-log", "Organizing cancelled.", "warning");
            return;
          }
      }

    webContents.send("organizing-log", "⚡ Starting file processing...", "warning");
  
    const files = getAllFiles(config.samplesDir);
    webContents.send("organizing-log", `Found ${files.length} files to process.`, "info");
  
    if (files.length === 0) {
      webContents.send("organizing-log", `No files found in <b>${config.samplesDir}</b> to organize.`, "warning");
      webContents.send("organizing-done", {
        destDir: config.destDir,
        dryRun: !!config.dryRun,
        newFiles: [],  // nothing moved
      });
      return;
    }
  
      let i = 0;
      for (const fullPath of files) {
        if (cancelRequested) break;

        const fileName = path.basename(fullPath);
        const ext = getExt(fullPath);

        //Check for archives
        if (ext === "zip" || ext === "rar") {
            const base = path.basename(fileName, path.extname(fileName));
            const tempDir = path.join(config.destDir, `_temp_${base}`);
            

          if (config.dryRun) {
            webContents.send(
              "organizing-log",
              `[DRY RUN] Would extract <b>${fileName}</b> (${ext.toUpperCase()})`,
              "warning"
            );
            continue;
          }

          try {
            let extractedFiles = [];
            if (ext === "zip") {
              extractedFiles = await extractZip(fullPath, tempDir, config.keepArchives);
            } else {
              extractedFiles = await extractRarArchive(fullPath, tempDir, config.keepArchives);
            }

            webContents.send("organizing-log", `Extracted <b>${fileName}</b> → ${extractedFiles.length} files`, "warning");

            if (!Array.isArray(extractedFiles)) extractedFiles = [];
            
            // Fallback: scan tempDir if the extractor didn't return paths
            if (extractedFiles.length === 0) {
              try {
                extractedFiles = getAllFiles(tempDir);
                webContents.send(
                  "organizing-log",
                  `Extractor returned no file list; found ${extractedFiles.length} files in temp folder.`,
                  "info"
                );
              } catch (scanErr) {
                webContents.send(
                  "organizing-log",
                  `Couldn't scan extracted folder: ${scanErr.message}`,
                  "error"
                );
              }
            }            
        
            let k = 0;
            for (const extracted of extractedFiles) {
              if (!isAcceptedExt(extracted, config)) {
                const badExt = getExt(extracted);
                webContents.send(
                  "organizing-log",
                  `Skipped <b>${path.basename(extracted)}</b> (unaccepted extension: .${badExt})`,
                  "info"
                );
                continue;
              }
              const r = await categorizeFile(extracted, config, webContents, dedupe);
              if (r && r.dest) movedThisRun.push(r);

              if ((++k % 50) === 0) await _yield();  // ← yield during big extractions
            }
        
            removeFolderRecursive(tempDir);
          } catch (err) {
            webContents.send(
              "organizing-log",
              `Error extracting <b>${fileName}</b>: ${err.message}`,
              "error"
            );
          }
          continue;
        }
      
        // File categorization
        const r2 = await categorizeFile(fullPath, config, webContents, dedupe);
        if (r2 && r2.dest) movedThisRun.push(r2);
        //Give UI break
        if ((++i % 50) === 0) await _yield();
      }
  
    webContents.send("organizing-done", {
      destDir: config.destDir,
      dryRun: !!config.dryRun,
      newFiles: movedThisRun,
    });
  }

module.exports = { startOrganizing, requestCancel };