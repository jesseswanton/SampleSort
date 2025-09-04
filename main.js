const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const organizer = require("./organizer");
const { walkDir, getFileDuration, moveFileToBPMFolder, getParentBpmValue, uniqueDestPath, isBpmDirName, firstNonBpmAncestorDir, isInsideBpmFolder } = require("./bpmUtils");

let mainWindow;
const configPath = path.join(__dirname, "config.json");

const yieldIO = () => new Promise(res => setImmediate(res));

// -------------------- Helper --------------------
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
    fullscreen: false
  });

  mainWindow.maximize();
  mainWindow.loadFile("renderer/index.html");

  mainWindow.webContents.on("render-process-gone", (_e, details) => {
    console.error("Renderer process gone:", details);
    // optional: surface in UI
    mainWindow.webContents.send("organizing-log", `Renderer crashed: ${details.reason}`, "error");
  });

  app.on("gpu-process-crashed", (_e, killed) => {
    console.error("GPU process crashed. Killed:", killed);
  });
}

// -------------------- App --------------------
app.whenReady().then(createWindow);

// -------------------- IPC Handlers --------------------

// ipcMain.handle("toggle-fullscreen", () => {
//     if (mainWindow) {
//       const isFullscreen = mainWindow.isFullScreen();
//       mainWindow.setFullScreen(!isFullscreen);
//       mainWindow.webContents.send("fullscreen-changed", !isFullscreen);
//     }
//   });

ipcMain.handle("pick-folder", async (_e, { defaultPath }) => {
  const opts = {
    properties: ["openDirectory", "createDirectory"],
  };
  if (defaultPath && fs.existsSync(defaultPath)) {
    // if a file is pasted, use its folder
    const stat = fs.lstatSync(defaultPath);
    opts.defaultPath = stat.isDirectory() ? defaultPath : path.dirname(defaultPath);
  }
  const { canceled, filePaths } = await dialog.showOpenDialog(opts);
  return canceled ? null : (filePaths[0] || null);
});

// Load config
ipcMain.handle("load-config", async () => {
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    return JSON.parse(raw);
  } catch (err) {
    console.error("Failed to load config:", err);
    return {};
  }
});

// Save config
ipcMain.handle("save-config", async (event, updatedConfig) => {
  try {
    fs.writeFileSync(configPath, JSON.stringify(updatedConfig, null, 2));
    console.log("Config saved successfully!");
    return true;
  } catch (err) {
    console.error("Failed to save config:", err);
    throw new Error(err.message);
  }
});

// Open folder dialog
ipcMain.handle("open-folder-dialog", async () => {
  return await dialog.showOpenDialog({ properties: ["openDirectory"] });
});

// Open path in file explorer
ipcMain.handle("open-path", async (event, folderPath) => {
  if (folderPath && fs.existsSync(folderPath)) {
    await shell.openPath(folderPath);
    return true;
  }
  return false;
});

// BPM Sort (prepare list for renderer)
ipcMain.handle("prepare-bpm-files", async (event, { destDir, config, limitTo }) => {
  if (config?.bpmDebug) {
    event.sender.send("organizing-log", "Preparing BPM files…", "info");
  }

  const allowed = new Set(
    (config.extensions || []).map(e => String(e).toLowerCase().replace(/^\./, ""))
  );
  const threshold = Number(config.BPMThreshold || 0);

  // Collect candidates
  const candidates = [];

  const addIfOk = (file) => {
    if (!file) return;

    if (file.includes(`${path.sep}_Duplicates${path.sep}`)) return;

    try {
      const abs = path.resolve(file);
      if (isInsideBpmFolder(abs)) {
        if (config?.bpmDebug) {
          const base = path.basename(file);
          event.sender.send("organizing-log", `Skip (already in BPM folder): <b>${base}</b>`, "info");
        }
        return;
      }
    } catch { }

    try {
      const st = fs.statSync(file);
      if (!st.isFile()) return;
      const ext = path.extname(file).toLowerCase().replace(/^\./, "");
      if (allowed.size && !allowed.has(ext)) return;
      candidates.push(path.resolve(file));
    } catch { }
  };

  // Use only the files in current sort (limitTo), else scan whole tree
  if (Array.isArray(limitTo)) {
    if (limitTo.length === 0) return [];
    for (const p of limitTo) addIfOk(p);
  } else {
    walkDir(destDir, addIfOk);
  }

  // Build worklist with filename/parent-BPM shortcuts & threshold filtering
  const filesToAnalyze = [];
  for (let i = 0; i < candidates.length; i++) {
    const file = candidates[i];

    // prefer BPM from parent
    const parentBpm = getParentBpmValue(file);
    if (parentBpm != null) {
      filesToAnalyze.push({ file, skipDetection: true, bpmValue: parentBpm });
      continue;
    }

    // or BPM in filename
    const base = path.basename(file);
    const m = base.match(/\b(\d{2,3})\s*bpm\b/i) || base.match(/(\d{2,3})\s*[-_ ]?\s*bpm/i);
    if (m) {
      const bpmVal = parseInt(m[1], 10);
      if (Number.isFinite(bpmVal)) {
        filesToAnalyze.push({ file, skipDetection: true, bpmValue: bpmVal });
        continue;
      }
    }

    // threshold: only skip if we can determine duration and it’s below threshold
    if (threshold > 0) {
      try {
        const dur = await getFileDuration(file);
        if (dur != null && dur < threshold) {
          if (config?.bpmDebug) {
            event.sender.send(
              "organizing-log",
              `Skip (below threshold ${threshold}s): <b>${base}</b> (${dur.toFixed(2)}s)`,
              "info"
            );
          }
          continue;
        }
      } catch {
        // duration unknown — let renderer try detection
      }
    }

    filesToAnalyze.push({ file, skipDetection: false });

    if ((i % 200) === 0) {
      await new Promise(r => setImmediate(r));
    }
  }

  if (config?.bpmDebug) {
    event.sender.send("organizing-log", `Prepared ${filesToAnalyze.length} file(s) for BPM analysis.`, "info");
  }
  return filesToAnalyze;
});

// crude key token detector: A, A#, Bb, with optional Maj/Min around word/dash/underscore boundaries
const KEY_RE = /(?:^|[\s_\-])([A-G](?:#|b)?)(?:\s*(maj(?:or)?|min(?:or)?))?(?=$|[\s_\-])/i;

function detectKeyFromName(name) {
  const base = String(name || "").replace(/\.[a-z0-9]+$/i, "");
  const m = base.match(KEY_RE);
  if (!m) return null;

  // Preserve accidental, force letter uppercase
  const raw = m[1];            // e.g. "Bb", "A#", "e"
  const letter = raw[0].toUpperCase();
  const accidental = raw.slice(1); // "", "#" or "b"
  const note = letter + accidental;

  const qualRaw = (m[2] || "").toLowerCase();
  let quality = null;
  if (qualRaw.startsWith("maj")) quality = "Maj";
  else if (qualRaw.startsWith("min")) quality = "Min";

  return { note, quality }; // e.g. { note:"Bb", quality:"Min" } or { note:"E", quality:null }
}

// Handle key folders
ipcMain.handle("apply-key-folders", async (_evt, {
  rootDir, extensions = [], dryRun, debug, keyFromParent, keyNoteOnlyFallback, limitTo
}) => {
  if (!rootDir || !fs.existsSync(rootDir)) {
    throw new Error(`Root directory not found: ${rootDir}`);
  }

  const extSet = new Set(
    (extensions || []).map(e => String(e).toLowerCase().replace(/^\./, ""))
  );

  const pending = [];

  const consider = (file) => {
    if (!file) return;
    if (file.includes(`${path.sep}_Duplicates${path.sep}`)) return;
    try {
      const st = fs.statSync(file);
      if (!st.isFile()) return;
      const ext = path.extname(file).slice(1).toLowerCase();
      if (extSet.size && !extSet.has(ext)) return;
      pending.push(path.resolve(file));
    } catch { }
  };

  //Only files in current sort
  if (Array.isArray(limitTo)) {
    if (limitTo.length === 0) return 0;
    for (const p of limitTo) consider(p);
  } else {
    walkDir(rootDir, consider);
  }

  let moved = 0;
  for (let i = 0; i < pending.length; i++) {
    const file   = pending[i];
    const base   = path.basename(file);
    const parent = path.basename(path.dirname(file));

    const infoFromName = detectKeyFromName(base);
    const info = infoFromName || (keyFromParent ? detectKeyFromName(parent) : null);
    if (!info) {
      if ((i % 100) === 0) await new Promise(r => setImmediate(r));
      continue;
    }

    const keyLabel =
      info.quality ? `${info.note} ${info.quality}` :
      (keyNoteOnlyFallback ? info.note : null);

    if (!keyLabel) {
      if ((i % 100) === 0) await new Promise(r => setImmediate(r));
      continue;
    }

    // already inside a matching key folder? skip
    const parentName = path.basename(path.dirname(file));
    if (parentName === keyLabel) {
      if ((i % 100) === 0) await new Promise(r => setImmediate(r));
      continue;
    }

    // choose base dir: if current dir *is* a BPM dir, use it, otherwise first non-BPM ancestor
    const dirNow  = path.dirname(file);
    const baseDir = isBpmDirName(path.basename(dirNow)) ? dirNow : firstNonBpmAncestorDir(file);
    const keyDir  = path.join(baseDir, keyLabel);

    if (!dryRun) {
      fs.mkdirSync(keyDir, { recursive: true });
      const dest = uniqueDestPath(keyDir, path.basename(file));
      try {
        fs.renameSync(file, dest);
      } catch (e) {
        if (e.code === "EXDEV") {
          fs.copyFileSync(file, dest);
          fs.unlinkSync(file);
        } else {
          throw e;
        }
      }
    }

    moved++;
    if (debug) {
      _evt.sender.send(
        "organizing-log",
        `${dryRun ? "[DRY RUN] " : ""}Key sort: <b>${base}</b> → <b>${path.join(path.basename(baseDir), keyLabel)}</b>`,
        "info"
      );
    }

    if ((i % 100) === 0) {
      await new Promise(r => setImmediate(r));
    }
  }

  return moved;
});

// Handle BPM results
ipcMain.handle("bpm-results", async (_event, payload) => {
  const items = Array.isArray(payload) ? payload : (payload?.items || []);
  const sortByKey = !!payload?.sortByKey;
  const dryRun = !!payload?.dryRun;

  const counts = {};
  let processed = 0;
  let i = 0;

  for (const { file, bpmValue, keyValue } of items) {
    if (!file || !isFinite(bpmValue)) continue;

    const opts = { keyValue: sortByKey ? keyValue : null, dryRun };

    try {
      moveFileToBPMFolder(file, bpmValue, opts);
      const key = Math.round(Number(bpmValue));
      counts[key] = (counts[key] || 0) + 1;
      processed++;
    } catch (err) {
    }

    // Yield to the main loop every 50 files
    if ((++i % 50) === 0) {
      await yieldIO();
    }
  }

  return processed;
});

ipcMain.on("renderer-error", (_e, msg) => {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("organizing-log", msg, "error");
    }
  } catch {}
});

// Start organizing
ipcMain.on("start-organizing", (event, config) => {
  organizer.startOrganizing(config, event.sender);
});

// Cancel organizing
ipcMain.handle("organizing-cancel", () => {
  organizer.requestCancel();
});