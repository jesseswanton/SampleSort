const { ipcRenderer } = require("electron");
const fs = require("fs");
const path = require("path");
const bpmDetective = require("bpm-detective");
const {
  createListItem,
  createCategoryItem,
  getListValues,
  appendLog,
  enableDragSort,
  enableCrossListDrag,
  createMainCategoryItem,
  readMainCategories,
  enableMainReorder,
  setAutoScrollEnabled,
} = require("./helpers");
const { showNotification } = require("./ui");
const { isDuplicatesPath } = require("../bpmUtils");
const { setTimeout: sleep } = require("timers/promises");

// Hard safety caps for BPM decode
const MAX_DECODE_BYTES = (window.BPM_MAX_DECODE_MB || 64) * 1024 * 1024; // 64 MB
const LOG_BIG_FILE_HINT = "File too large to decode safely for BPM (consider raising the limit).";

const yieldToUI = () =>
  (typeof requestAnimationFrame === "function")
    ? new Promise(resolve => requestAnimationFrame(resolve))
    : sleep(0);

window.addEventListener("error", (e) => {
  try { ipcRenderer.send("renderer-error", `Renderer error: ${e.message}`); } catch {}
});
window.addEventListener("unhandledrejection", (e) => {
  try { ipcRenderer.send("renderer-error", `Unhandled promise rejection: ${e.reason?.message || e.reason}`); } catch {}
});

window.addEventListener('load', () => {
  const b = document.body;
  b.classList.add('is-ready');

  const onDone = () => b.classList.remove('preload');
  b.addEventListener(
    'transitionend',
    (e) => {
      if (e.target === b && e.propertyName === 'opacity') onDone();
    },
    { once: true }
  );
});

function setStartButtonLabel(txt) {
  const lab = document.querySelector('#startButton .btn-label');
  if (lab) lab.textContent = txt;
}

// Audio decoding (WebAudio)
async function decodeToAudioBuffer(nodeBuffer) {
  const arrayBuffer = nodeBuffer.buffer.slice(
    nodeBuffer.byteOffset,
    nodeBuffer.byteOffset + nodeBuffer.byteLength
  );
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const ctx = new AudioCtx();
  try {
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
    return audioBuffer;
  } finally {
    if (typeof ctx.close === "function") {
      try { await ctx.close(); } catch {}
    }
  }
}

// BPM Sorting (must be in renderer to work with WebAudio)
async function sortByBPM(ipcRenderer, destDir, config, appendLog ) {
  resetBpmCancel();

  const scanDir = config.dryRun ? config.samplesDir : destDir;
  if (!scanDir) {
    appendLog("No directory available for BPM analysis.", "error");
    return 0;
  }

  const bpmThresh = Number(config.BPMThreshold || 0);

  const limitTo = Array.isArray(config.limitTo)
    ? config.limitTo
    : (config.limitTo ? [config.limitTo] : []);

  const items = await ipcRenderer.invoke("prepare-bpm-files", { 
    destDir: scanDir, 
    config, 
    limitTo,
  });

  if (!items || items.length === 0) {
    appendLog("No files found for BPM analysis.", "warning");
    return 0;
  }

  const results = [];
  let takenFromName = 0, detected = 0, failed = 0;
  let idx = 0;

  for (const it of items) {
    if (bpmCancel.requested) {
      appendLog("BPM analysis cancelled by user.", "warning");
      break;
    }


    const file = typeof it === "string" ? it : it.file;
    if (!file) continue;
    if (isDuplicatesPath(file)) continue;
    const extLower = path.extname(file).toLowerCase();
      if (extLower === ".mid" || extLower === ".midi") {
        continue;
      }

    const name   = file.split(/[\\/]/).pop();
    const parent = path.basename(path.dirname(file));

    // Key value that the BPM mover can use later
    const keyFromNameOnly = detectKeyFromName(name);
    const keyValue = config.sortByKey
      ? (config.keyFromParent ? (keyFromNameOnly || detectKeyFromName(parent)) : keyFromNameOnly)
      : null;

    try {
      // Use file name first
      if (it.skipDetection && isFinite(it.bpmValue)) {
        if (config.bpmDebug) 
          appendLog(`Using filename/parent BPM <b>${it.bpmValue}</b> for <b>${name}</b>`, "info");
        results.push({ file, bpmValue: it.bpmValue, keyValue, bpmDebug: config.bpmDebug });
        takenFromName++;
        continue;
      }

      throwIfBpmCancelled();

      let stat;
      try {
        stat = fs.statSync(file);
      } catch (e) {
        if (config.bpmDebug) appendLog(`Stat failed for <b>${name}</b>: ${e.message}`, "warning");
        failed++;
        continue;
      }

      if (stat.size > MAX_DECODE_BYTES) {
        appendLog(`Skipping <b>${name}</b> (${(stat.size / (1024*1024)).toFixed(1)} MB). ${LOG_BIG_FILE_HINT}`, "warning");
        failed++;
        continue;
      }

      let nodeBuffer = null;
      let audioBuffer = null;

      try {

        nodeBuffer = await fs.promises.readFile(file);
        throwIfBpmCancelled();
        
        audioBuffer = await decodeToAudioBuffer(nodeBuffer);
        throwIfBpmCancelled();
        
      } catch (e) {

        const msg = String(e && e.message || e);
        if (/Array buffer allocation failed/i.test(msg)) {
          appendLog(`Skipping <b>${name}</b>: ${LOG_BIG_FILE_HINT}`, "warning");
          failed++;
          nodeBuffer = null;
          audioBuffer = null;
          await sleep(0);
          continue;
        }
        if (config.bpmDebug) appendLog(`Decode failed for <b>${name}</b>: ${msg}`, "warning");
        nodeBuffer = null;
        audioBuffer = null;
        await sleep(0);
        continue;
      }

      if (!audioBuffer || !isFinite(audioBuffer.duration) || audioBuffer.duration <= 0) {
        if (config.bpmDebug) appendLog(`Skipping <b>${name}</b> (unable to decode)`, "warning");
        failed++;
        nodeBuffer = null;
        audioBuffer = null;
        await sleep(0);
        continue;
      }

      if (audioBuffer.duration < bpmThresh) {
        if (config.bpmDebug) {
          appendLog(
            `Skipping <b>${name}</b> (duration ${audioBuffer.duration.toFixed(
              2
            )}s is below threshold).`,
            "info"
          );
        }
        continue;
      }

      const bpmValue = bpmDetective(audioBuffer);

      if (isFinite(bpmValue)) {
        const fromName = /\b(\d{2,3})\s?bpm\b/i.test(name);
        if (fromName) takenFromName++; else detected++;

        if (config.bpmDebug) appendLog(`Detected BPM: <b>${bpmValue}</b> for <b>${name}</b>`, "success");
        results.push({ file, bpmValue, keyValue });
      } else {
        failed++;
        if (config.bpmDebug) appendLog(`BPM not found for <b>${name}</b>`, "warning");
      }
    } catch (err) {
      failed++;
      if (config.bpmDebug) appendLog(`Failed BPM detection for <b>${name}</b>: ${err.message}`, "error");
    }

    audioBuffer = null;
    nodeBuffer = null;

    if ((++idx % 30) === 0) await yieldToUI();
  }

  if (bpmCancel.requested) {
    appendLog(`⏹ Cancelled during BPM Sort. Partial results: ${results.length} collected.`, "warning");
    return results.length;

  }

  if (config.dryRun) {
    appendLog(
      `[DRY RUN] BPM Analysis run. Would move <b>${results.length}</b> files `
      + `(from name: ${takenFromName}, detected: ${detected}, failed: ${failed}).`,
      "info"
    );
    return results.length;
  }

  const processed = await ipcRenderer.invoke("bpm-results", {
    items: results,
    sortByKey: !!config.sortByKey,
    dryRun: !!config.dryRun
  });

  appendLog(
    `✅ BPM sorting complete. Processed: ${processed} `
    + `(from name: ${takenFromName}, detected: ${detected}, failed: ${failed}).`,
    "info"
  );
  return processed;
}

// ---- Key detection helper ----
function detectKeyFromName(str) {
  if (!str) return null;
  const s = String(str);

  // Match: note [#|b|♭] + optional space/sep + optional quality (maj/major/M or min/minor/m)
  // Accepts tight forms like "BbMin" and spaced forms like "A# Major"
  const re = /(?:^|[\s_\-\(\[\{])([A-Ga-g])([#b♭]?)(?:\s*|[-_]?)(maj(?:or)?|M|min(?:or)?|m)?(?=\b|[\s_\-\)\]\}\.])/;
  const m = s.match(re);
  if (!m) return null;

  let note = m[1].toUpperCase();
  let acc = m[2] || "";
  if (acc === "♭") acc = "b";
  if (acc === "#" || acc === "b") note += acc;

  let qual = (m[3] || "").toLowerCase();
  if (/^(maj|major|m)$/i.test(qual)) {
    // Treat capital 'M' as Major
    return `${note} Maj`;
  } else if (/^(min|minor|m)$/i.test(qual)) {
    // Lowercase 'm' => Min; (the line above also catches 'm', so keep order)
    return `${note} Min`;
  }

  // If no quality was found, return the note alone (e.g., "A")
  return note;
}

// ---- Cancellation for BPM pass ----
const bpmCancel = { requested: false };
function requestBpmCancel() { bpmCancel.requested = true; }
function resetBpmCancel() { bpmCancel.requested = false; }
function throwIfBpmCancelled() {
  if (bpmCancel.requested) {
    const err = new Error("__BPM_CANCELLED__");
    err._bpmCancelled = true;
    throw err;
  }
}

function setupCascade(rootSelectorOrEl, startIndex = 1) {
  const root = typeof rootSelectorOrEl === 'string'
    ? document.querySelector(rootSelectorOrEl)
    : rootSelectorOrEl;
  if (!root) return;

  let i = startIndex;

  const tag = (el) => {
    if (!(el instanceof Element)) return;
    if (el.dataset.animated) return;
    el.classList.add('fade-child');
    el.style.setProperty('--i', String(i++));
    el.dataset.animated = '1';
  };

  // Tag existing children
  Array.from(root.children).forEach(tag);

  // Watch for future children
  const mo = new MutationObserver((mutations) => {
    for (const m of mutations) {
      m.addedNodes.forEach(tag);
    }
  });
  mo.observe(root, { childList: true });
  setTimeout(() => document.body.classList.add('interactive'), 1000);
  return mo; // keep if you ever want to disconnect()
}

// DOM + UI wiring
document.addEventListener("DOMContentLoaded", async () => {
  // Cache all DOM elements
  const els = {
    samplesDir: document.getElementById("samplesDir"),
    destDir: document.getElementById("destDir"),
    moveFiles: document.getElementById("moveFiles"),
    keepArchives: document.getElementById("keepArchives"),
    dryRun: document.getElementById("dryRun"),
    checkParentFolder: document.getElementById("checkParentFolder"),
    checkLength: document.getElementById("checkLength"),
    lengthThreshold: document.getElementById("lengthThreshold"),
    sortByBPM: document.getElementById("sortByBPM"),
    bpmOptions: document.getElementById("bpmOptions"),
    bpmDebug: document.getElementById("bpmDebug"),
    BPMThreshold: document.getElementById("BPMThreshold"),
    mainRoot: document.getElementById("mainCategoriesRoot"),
    addMainCategoryBtn: document.getElementById("addMainCategoryBtn"),
    closeFoldersBtn: document.getElementById("closeFoldersBtn"),
    categoriesList: document.getElementById("categoriesList"),
    extensionsList: document.getElementById("extensionsList"),
    archiveExtensionsList: document.getElementById("archiveExtensionsList"),
    addCategoryBtn: document.getElementById("addCategoryBtn"),
    newCategoryInput: document.getElementById("newCategoryInput"),
    newKeywordsInput: document.getElementById("newKeywordsInput"),
    saveConfigBtn: document.getElementById("saveConfigBtn"),
    startButton: document.getElementById("startButton"),
    moveWarning: document.getElementById("moveWarning"),
    browseSamplesBtn: document.getElementById("browseSamplesBtn"),
    browseDestBtn: document.getElementById("browseDestBtn"),
    // toggleFullscreenBtn: document.getElementById("toggleFullscreenBtn"),
    exportLogBtn: document.getElementById("exportLogBtn"),
    clearLogBtn: document.getElementById("clearLogBtn"),
    logArea: document.getElementById("logArea"),
    configForm: document.getElementById("configForm"),
    catFilter: document.getElementById("catFilter"),
    kwFilter: document.getElementById("kwFilter"),
    catSortBtn: document.getElementById("catSortBtn"),
    kwSortBtn: document.getElementById("kwSortBtn"),
    dedupeEnabled: document.getElementById("dedupeEnabled"),
    dedupeMode: document.getElementById("dedupeMode"),
    dedupePreferDest: document.getElementById("dedupePreferDest"),
    dedupeControls: document.getElementById("dedupeControls"),
    dedupeAlgo: document.getElementById("dedupeAlgo"),
    keepPackSubfolder: document.getElementById("keepPackSubfolder"),
    examplePath: document.getElementById("examplePath"),
    keyOptions: document.getElementById("keyOptions"),
    sortByKey: document.getElementById("sortByKey"),
    keyFromParent: document.getElementById("keyFromParent"),
    sortMidiToFolder: document.getElementById("sortMidiToFolder"),
    postProcessBtn: document.getElementById("postProcessBtn"),
    postProcessWrap: document.getElementById("postProcessWrap"),
    postProcessToggle: document.getElementById("enablePostProcess"),
  };

  //BPM/Key only sort
  const syncPostProcessVisibility = () => {
  if (!els.postProcessWrap || !els.postProcessToggle) return;
    els.postProcessWrap.style.display = els.postProcessToggle.checked ? "flex" : "none";
  };
  els.postProcessToggle?.addEventListener("change", syncPostProcessVisibility);
  syncPostProcessVisibility();

  els.postProcessBtn?.addEventListener("click", async () => {
    const ppBtn = els.postProcessBtn;
    ppBtn.disabled = true;
    const root = (els.destDir?.value || "").trim();
    if (!root) {
      appendLog("Pick a Destination Directory first.", "error");
      return;
    }

    const extensionsArr = getListValues(els.extensionsList)
      .map(e => String(e).toLowerCase().replace(/^\./, "").trim())
      .filter(Boolean);

    // Force scanning the DESTINATION even in dry-run by setting both to root
    const bpmCfg = {
      sortByBPM: !!els.sortByBPM.checked,
      BPMThreshold: Number(els.BPMThreshold.value) || 0,
      bpmDebug: !!els.bpmDebug.checked,
      extensions: extensionsArr,
      dryRun: !!els.dryRun.checked,
      samplesDir: root,
      destDir: root,
      sortByKey: !!els.sortByKey?.checked,
      keyFromParent: !!els.keyFromParent?.checked,
      keyNoteOnlyFallback: !!document.getElementById("keyNoteOnlyFallback")?.checked,
    };

    try {
      els.startButton.disabled = true;
      setStartButtonLabel("Analyzing BPM…");
      setAutoScrollEnabled(true);

      if (bpmCfg.sortByBPM) {
        appendLog("Starting BPM sort on Destination…", "warning");
        const processed = await sortByBPM(ipcRenderer, root, bpmCfg, appendLog);
        appendLog(`BPM sorting complete. ${processed} files processed.`, "info");
      } else {
        appendLog("BPM sort is not enabled.", "info");
      }

      if (!bpmCancel.requested && els.sortByKey?.checked) {
        appendLog("Applying Key subfolders on Destination…", "warning");
        let movedKeyCount = await ipcRenderer.invoke("apply-key-folders", {
          rootDir: root,
          extensions: extensionsArr,
          dryRun: !!els.dryRun.checked,
          debug: !!els.bpmDebug.checked,
          keyFromParent: !!els.keyFromParent?.checked,
          keyNoteOnlyFallback: !!document.getElementById("keyNoteOnlyFallback")?.checked,
        });
        if (!Number.isFinite(movedKeyCount)) movedKeyCount = 0;
        appendLog(`Key sort complete. ${movedKeyCount} file(s) updated.`, "info");
      } else if (bpmCancel.requested) {
        appendLog("⏹ Key sorting cancelled.", "info");
      }

      await new Promise(r => setTimeout(r, 100));
      if (!els.dryRun.checked) {
        appendLog("✅ BPM/Key process complete!", "info");
        const openBtn = document.createElement("button");
        openBtn.textContent = "Open Folder";
        openBtn.style.marginLeft = "10px";
        openBtn.onclick = () => ipcRenderer.invoke("open-path", root);
        els.logArea.appendChild(openBtn);
      } else {
        appendLog("☑️ Dry run complete! No files altered.", "info");
      }
    } catch (err) {
      appendLog(`Post-process failed: ${err.message}`, "error");
    } finally {
      els.startButton.disabled = false;
      setStartButtonLabel("Start");
      ppBtn.disabled = false;
    }
  });

  const hasTree = !!els.mainRoot;
  let selectedMain = null;
  const mainsRoot = document.getElementById("mainCategoriesRoot");
  if (!mainsRoot) return;

  // start sticky by default
  setAutoScrollEnabled(true);

  // keep sticky on only if user is at bottom
  els.logArea?.addEventListener("scroll", () => {
    const atBottom = els.logArea.scrollHeight - (els.logArea.scrollTop + els.logArea.clientHeight) < 20;
    window.__autoScroll = atBottom; // shared flag used by appendLog
  });

  // Jump-to-bottom visibility + click handler
  const jumpBtn = document.getElementById("jumpToBottom");
  if (jumpBtn && els.logArea) {
    jumpBtn.style.pointerEvents = "auto";
    const showBtnIfAwayFromBottom = () => {
      const { scrollTop, scrollHeight, clientHeight } = els.logArea;
      const dist = scrollHeight - (scrollTop + clientHeight);
      jumpBtn.style.display = dist > 40 ? "block" : "none";
    };
    els.logArea.addEventListener("scroll", showBtnIfAwayFromBottom);

    jumpBtn.addEventListener("click", () => {
      setAutoScrollEnabled(true);
      els.logArea.scrollTop = els.logArea.scrollHeight;
      jumpBtn.style.display = "none";
    });
  }

  document.getElementById("stopButton")?.addEventListener("click", () => {
    ipcRenderer.invoke("organizing-cancel");
    setStartButtonLabel("Start");
    els.startButton.disabled = false;
  });

  // Helpers
  function triggerError(input) {
    input.classList.add("error-border");
    input.classList.remove("error-shake");
    void input.offsetWidth;
    input.classList.add("error-shake");
  }
  function addValidationListener(input) {
    input.addEventListener("input", () => {
      if (input.value.trim() !== "") {
        input.classList.remove("error-border", "error-shake");
      }
    });
  } 

  function selectMain(detailsEl) {
    if (!detailsEl) return;
    // clear previous
    els.mainRoot.querySelectorAll(".main-cat.selected")
      .forEach(d => d.classList.remove("selected"));
    // set new
    detailsEl.classList.add("selected");
    selectedMain = detailsEl;
    updateAddBtnLabel();
  }
  
  function selectedMainName() {
    const name = selectedMain?.querySelector(".main-summary input")?.value?.trim();
    return name || "Main";
  }

  function currentCategoryName() {
    const typed = (els.newCategoryInput?.value || "").trim();
    if (typed) return typed;
  
    const firstCatInput = selectedMain?.querySelector('.categories-list > li input[type="text"]');
    const val = firstCatInput?.value?.trim();
    return val || "Category";
  }  
  
  function updateAddBtnLabel() {
    if (!els.addCategoryBtn) return;
    if (selectedMain) {
      els.addCategoryBtn.textContent = `Add Category (to ${selectedMainName()})`;
    } else {
      els.addCategoryBtn.textContent = "Add Category";
    }
  }

  function singularize(cat) {
    const c = String(cat || "").trim();
    // don't touch words that end with "ss" (e.g., "bass")
    if (/ss$/i.test(c)) return c;
    // drop trailing "es" (e.g., "classes" -> "class")
    if (/es$/i.test(c)) return c.slice(0, -2);
    // otherwise drop a single trailing "s"
    if (/s$/i.test(c)) return c.slice(0, -1);
    return c;
  }

  //Example Path builder
  function buildExamplePath(cfg) {
    const root = (cfg.destDir?.trim() || "D:\\Destination Directory");
  
    const main = (selectedMainName() || cfg.main?.trim() || "Folder");

    const cat  = (currentCategoryName() || cfg.category?.trim() || "Category");
  
    const pack = "SamplePack";
    const collection = "Collection";
    const packLabel  = `${pack} (${collection})`;

    const file = `${singularize(cat)}01.wav`;
    const bpm  = "100 BPM";
    const key  = "Bb Maj";
  
    const parts = [root, main, cat];
  
    const lenTh = Number(cfg.lengthThreshold || 0);
    if (cfg.checkLength && lenTh > 0) parts.push(`${cat} - Over ${lenTh} seconds`);
  
    if (cfg.keepPackSubfolder) parts.push(packLabel);
    if (cfg.sortByBPM) parts.push(bpm);
    if (cfg.sortByKey) parts.push(key);
  
    parts.push(file);
    return parts.join("\\");
  }  

  function updateExample() {
    const cfg = {
      destDir: els.destDir?.value,
      checkLength: els.checkLength?.checked,
      lengthThreshold: els.lengthThreshold?.value,
      sortByBPM: els.sortByBPM?.checked,
      keepPackSubfolder: els.keepPackSubfolder?.checked,
      main: selectedMainName(),
      category: currentCategoryName(),
      sortByKey: els.sortByKey?.checked,
    };
    els.examplePath.textContent = buildExamplePath(cfg);
  }

  // select the folder you click/focus in
  els.mainRoot.addEventListener("mousedown", (e) => {
    const d = e.target.closest(".main-cat");
    if (d) selectMain(d);
  });
  els.mainRoot.addEventListener("focusin", (e) => {
    const d = e.target.closest(".main-cat");
    if (d) selectMain(d);
  });

  // keep label live as you rename the main
  els.mainRoot.addEventListener("input", (e) => {
    if (selectedMain && selectedMain.contains(e.target) &&
        e.target.matches(".main-summary input")) {
      updateAddBtnLabel();
    }
  });

  els.mainRoot.addEventListener("main-selected", (e) => {
    const d = e.target.closest(".main-cat");
    if (d) selectMain(d);
  });  

  // Add Extension
  const newExtInput = document.getElementById("newExtensionInput");
  const addExtBtn = document.getElementById("addExtensionBtn");
  addExtBtn.addEventListener("click", () => {
    const val = (newExtInput.value || "").trim().toLowerCase().replace(/^\./, "");
    if (!val) return;
    createListItem(val, els.extensionsList);
    newExtInput.value = "";
  });

  // Enable drag and drop (Legacy)
  if (typeof enableDragSort === "function" && els.categoriesList) {
    enableDragSort(els.categoriesList);
  }  

  // Add FILTER and SORT
  function categoryNameOf(li) {
    return (li.querySelectorAll('input[type="text"]')[0]?.value || "").trim().toLowerCase();
  }
  function keywordsStringOf(li) {
    return (li.querySelectorAll('input[type="text"]')[1]?.value || "").trim().toLowerCase();
  }
  
  // Apply filters to all mains; expand mains that have matches
  function applyTreeFilters(cq, kq) {
    cq = (cq || "").toLowerCase();
    kq = (kq || "").toLowerCase();
  
    els.mainRoot.querySelectorAll(".main-cat").forEach(main => {
      const mainName = (main.querySelector(".main-summary input")?.value || "").toLowerCase();
      let anyChildVisible = false;
  
      main.querySelectorAll(".categories-list > li").forEach(li => {
        const name = categoryNameOf(li);
        const kw   = keywordsStringOf(li);
        const match =
          (!cq || name.includes(cq) || mainName.includes(cq)) &&
          (!kq || kw.includes(kq) || name.includes(kq)); // allow either box to match both
        li.style.display = match ? "" : "none";
        if (match) anyChildVisible = true;
      });
  
      // Show main if its name matches OR it has visible children
      const showMain = (!cq && !kq) ? true : (mainName.includes(cq) || anyChildVisible);
      main.style.display = showMain ? "" : "none";
      if (showMain && anyChildVisible) main.open = true; // auto-open to reveal matches
    });
  }
  
  // Sort categories within each main (by name or by first keyword)
  function sortTree(by = "name", dir = "asc") {
    const factor = dir === "desc" ? -1 : 1;
  
    els.mainRoot.querySelectorAll(".main-cat .categories-list").forEach(ul => {
      const items = Array.from(ul.children);
      items.sort((a, b) => {
        const aKey = (by === "name")
          ? categoryNameOf(a)
          : (keywordsStringOf(a).split(/[,\n;]+/).map(s=>s.trim()).filter(Boolean)[0] || "");
        const bKey = (by === "name")
          ? categoryNameOf(b)
          : (keywordsStringOf(b).split(/[,\n;]+/).map(s=>s.trim()).filter(Boolean)[0] || "");
        return factor * aKey.localeCompare(bKey, undefined, { sensitivity: "base", numeric: true });
      });
      items.forEach(li => ul.appendChild(li));
    });
  }
  
  // Wire inputs
  const onFilter = () => applyTreeFilters(els.catFilter?.value, els.kwFilter?.value);
  els.catFilter?.addEventListener("input", onFilter);
  els.kwFilter?.addEventListener("input", onFilter);

  // Category sort button
  els.catSortBtn?.addEventListener("click", () => {
    const dir = els.catSortBtn.dataset.dir || "asc";
    sortTree("name", dir);
    const next = dir === "asc" ? "desc" : "asc";
    els.catSortBtn.dataset.dir = next;
    els.catSortBtn.textContent = next === "asc" ? "Sort Categories A → Z" : "Sort Categories Z → A";
  });

  // Keyword sort button
  els.kwSortBtn?.addEventListener("click", () => {
    const dir = els.kwSortBtn.dataset.dir || "asc";
    sortTree("keyword", dir);
    const next = dir === "asc" ? "desc" : "asc";
    els.kwSortBtn.dataset.dir = next;
    els.kwSortBtn.textContent = next === "asc" ? "Sort Keywords A → Z" : "Sort Keywords Z → A";
  });  

  els.closeFoldersBtn?.addEventListener("click", () => {
    els.mainRoot.querySelectorAll(".main-cat").forEach(d => d.open = false);
  });

  const stopBtn = document.getElementById("stopButton");
  stopBtn?.addEventListener("click", async () => {
    requestBpmCancel();
    try { await ipcRenderer.invoke("organizing-cancel"); } catch {}
    appendLog("⏹ Sorting cancelled.", "warning");
  });


  // Write config -> UI
  function populateUI(cfg) {
    els.samplesDir.value = cfg.samplesDir || "";
    els.destDir.value = cfg.destDir || "";
    els.moveFiles.checked = cfg.moveFiles ?? false;
    els.keepArchives.checked = cfg.keepArchives ?? true;
    els.dryRun.checked = cfg.dryRun ?? true;
    els.checkParentFolder.checked = cfg.checkParentFolder ?? true;
    els.sortMidiToFolder.checked = cfg.sortMidiToFolder ?? true;
    // els.midiFolderName.value = cfg.midiFolderName || "MIDI";
    els.checkLength.checked = cfg.checkLength ?? true;
    els.lengthThreshold.value = cfg.lengthThreshold || 5;
    els.sortByBPM.checked = cfg.sortByBPM ?? true;
    els.BPMThreshold.value = cfg.BPMThreshold || 5;
    els.bpmDebug.checked = cfg.bpmDebug ?? false;
    els.dedupeEnabled.checked = cfg.dedupeEnabled ?? false;
    els.dedupeMode.value = cfg.dedupeMode || "skip";
    els.dedupePreferDest.checked = cfg.dedupePreferDest ?? true;
    els.dedupeControls.style.display = els.dedupeEnabled.checked ? "block" : "none";
    els.dedupeEnabled.addEventListener("change", () => {
    els.dedupeControls.style.display = els.dedupeEnabled.checked ? "block" : "none";
    els.dedupeAlgo.value = cfg.dedupeAlgo || "sha256"; });
    els.keepPackSubfolder.checked = cfg.keepPackSubfolder ?? false;
    if (els.packDepth) els.packDepth.value = cfg.packDepth ?? 1;
    els.sortByKey.checked = cfg.sortByKey ?? false;
    els.keyOptions.style.display = els.sortByKey.checked ? "block" : "none";
    els.sortByKey.addEventListener("change", () => {
      els.keyOptions.style.display = els.sortByKey.checked ? "block" : "none";
      updateExample();
    });
    els.keyFromParent.checked = cfg.keyFromParent ?? true;

    // extensions
    els.extensionsList.innerHTML = "";
    (cfg.extensions || []).forEach(ext => createListItem(ext, els.extensionsList));

    els.archiveExtensionsList.innerHTML = "";
    (cfg.archiveExtensions || []).forEach(ext => {
      const li = createListItem(ext, els.archiveExtensionsList, false);
      li.querySelector("input").readOnly = true;
    });

    els.bpmOptions.style.display = els.sortByBPM.checked ? "block" : "none";
    els.sortByBPM.addEventListener("change", () => {
      els.bpmOptions.style.display = els.sortByBPM.checked ? "block" : "none";
    });

    // Folder and categories
    els.mainRoot.innerHTML = "";
    if (els.categoriesList) els.categoriesList.innerHTML = "";
    
    if (hasTree) {
      enableCrossListDrag(els.mainRoot);
      enableMainReorder(mainsRoot);
    
      if (Array.isArray(cfg.mainCategories) && cfg.mainCategories.length) {
        cfg.mainCategories.forEach(m => {
          createMainCategoryItem(m.name, m.categories, els.mainRoot);
        });
      } else {
        const flat = Object.entries(cfg.categories || {})
          .map(([name, keywords]) => ({ name, keywords }));
        createMainCategoryItem("", flat, els.mainRoot);
      }
    
      const firstMain = els.mainRoot.querySelector(".main-cat");
      if (firstMain) selectMain(firstMain);
    } else if (els.categoriesList) {
      Object.entries(cfg.categories || {}).forEach(([cat, keywords]) =>
        createCategoryItem(cat, keywords, els.categoriesList)
      );
      if (typeof enableDragSort === "function") enableDragSort(els.categoriesList);
    }
    
    const togglePackDepth = () =>
      document.getElementById("packDepthWrap").style.display =
        els.keepPackSubfolder.checked ? "block" : "none";
    togglePackDepth();
    els.keepPackSubfolder.addEventListener("change", () => { togglePackDepth(); updateExample(); });
    els.packDepth?.addEventListener("input", updateExample);

    if (els.postProcessToggle) els.postProcessToggle.checked = !!cfg.enablePostProcess;
    syncPostProcessVisibility();
  }

  // Read config <- UI (for saving)
  function collectConfigForSave() {
    let mainCategories = [];
    let flatCategories = {};
  
    if (hasTree) {
      // Read the tree from the DOM
      mainCategories = readMainCategories(els.mainRoot); // [{name, categories:[{name, keywords}]}]
  
      // Also emit a flat map for back-compat or any logic that still expects it
      mainCategories.forEach(m => {
        (m.categories || []).forEach(c => {
          if (c.name) flatCategories[c.name] = c.keywords || [];
        });
      });
    } else {
      // Flat editor
      const catPairs = getListValues(els.categoriesList, "category")
        .filter(c => c.name)
        .map(c => [c.name, c.keywords]);
      flatCategories = Object.fromEntries(catPairs);
  
      // Wrap into one main for organizer compatibility
      mainCategories = [{
        name: "General",
        categories: Object.entries(flatCategories).map(([name, keywords]) => ({ name, keywords }))
      }];
    }
  
    return {
      samplesDir: els.samplesDir.value,
      destDir: els.destDir.value,
      moveFiles: els.moveFiles.checked,
      keepArchives: els.keepArchives.checked,
      dryRun: els.dryRun.checked,
      extensions: getListValues(els.extensionsList),
      archiveExtensions: getListValues(els.archiveExtensionsList),
      checkParentFolder: els.checkParentFolder.checked,
      checkLength: els.checkLength.checked,
      lengthThreshold: Number(els.lengthThreshold.value),
      sortByBPM: els.sortByBPM.checked,
      BPMThreshold: Number(els.BPMThreshold.value),
      bpmDebug: els.bpmDebug.checked,
      mainCategories,
      categories: flatCategories,
      dedupeEnabled: els.dedupeEnabled?.checked || false,
      dedupeMode: els.dedupeMode?.value || "skip",
      dedupePreferDest: !!els.dedupePreferDest?.checked,
      dedupeAlgo: els.dedupeAlgo?.value || "sha256",
      keepPackSubfolder: els.keepPackSubfolder.checked,
      packDepth: Math.max(1, Number(els.packDepth?.value || 1)),
      sortByKey: !!els.sortByKey?.checked,
      keyFromParent: !!els.keyFromParent?.checked,
      keyNoteOnlyFallback: !!els.keyNoteOnlyFallback?.checked,
      sortMidiToFolder: !!els.sortMidiToFolder?.checked,
      midiFolderName: (els.midiFolderName?.value || "MIDI").trim(),
      enablePostProcess: !!els.postProcessToggle?.checked,
    };
  }

  // Load initial config
  const config = await ipcRenderer.invoke("load-config");
  populateUI(config);

  setupCascade('#mainCategoriesRoot', 9);

  els.browseSamplesBtn.addEventListener("click", async () => {
    const startAt = els.samplesDir.value.trim();
    const picked = await ipcRenderer.invoke("pick-folder", { defaultPath: startAt });
    if (picked) els.samplesDir.value = picked;
  });

  els.browseDestBtn.addEventListener("click", async () => {
    const startAt = els.destDir.value.trim();
    const picked = await ipcRenderer.invoke("pick-folder", { defaultPath: startAt });
    if (picked) {
      els.destDir.value = picked;
      updateExample();
    }
  });


  // Example Path
  ["destDir","checkLength","lengthThreshold","sortByBPM","keepPackSubfolder","sortByKey"]
  .forEach(id=>{
    document.getElementById(id)?.addEventListener("input", updateExample);
    document.getElementById(id)?.addEventListener("change", updateExample);
  });

  els.newCategoryInput?.addEventListener("input", updateExample);

  els.mainRoot?.addEventListener("main-selected", updateExample);
  els.mainRoot?.addEventListener("input", (e) => {
    if (selectedMain && selectedMain.contains(e.target)) updateExample();
  });

  updateExample();

  els.newCategoryInput?.addEventListener("input", updateExample);
  els.mainRoot?.addEventListener("main-selected", updateExample);
  els.mainRoot?.addEventListener("input", (e) => {
    if (e.target.matches(".main-summary input")) updateExample();
  });

  // Add Main Category
  if (hasTree && els.addMainCategoryBtn) {
    els.addMainCategoryBtn.addEventListener("click", () => {
      const main = createMainCategoryItem("New Main", [], els.mainRoot);
      main.open = true;
      selectMain(main);
      const input = main.querySelector(".main-summary input");
      input?.focus(); input?.select();
    });
  }

  //Add Category button
  els.addCategoryBtn.addEventListener("click", () => {
    const name = els.newCategoryInput.value.trim();
    const keywords = els.newKeywordsInput.value
      .split(/[,\n;]+/)
      .map(s => s.trim())
      .filter(Boolean);
  
    if (!name) return;
  
    if (hasTree) {
      let target = selectedMain?.querySelector(".categories-list") ||
                   els.mainRoot.querySelector(".main-cat[open] .categories-list") ||
                   els.mainRoot.querySelector(".main-cat .categories-list");
    
      if (!target) {
        const main = createMainCategoryItem("General", [], els.mainRoot);
        main.open = true;
        selectMain(main);
        target = main.querySelector(".categories-list");
        if (typeof enableDragSort === "function") enableDragSort(target);
      }
      createCategoryItem(name, keywords, target);
    } else {
      createCategoryItem(name, keywords, els.categoriesList);
    }
  
    els.newCategoryInput.value = "";
    els.newKeywordsInput.value = "";
  });
  
  // Export log button
  els.exportLogBtn.addEventListener("click", () => {
    const logText = Array.from(els.logArea.children)
      .map(div => {
        const ts = div.dataset.timestamp || "";
        const type = div.dataset.type?.toUpperCase() || "INFO";
        const message = div.textContent.replace(/^\[.*?\]\s*/, "");
        return `[${type}] [${ts}] ${message}`;
      })
      .join("\n");

    // Readable local filename
    const now = new Date();
    const pad = n => String(n).padStart(2, "0");
    const yyyy = now.getFullYear();
    const MM = pad(now.getMonth() + 1);
    const dd = pad(now.getDate());
    let hh = now.getHours();
    const min = pad(now.getMinutes());
    const ss = pad(now.getSeconds());
    const ampm = hh >= 12 ? "PM" : "AM";
    hh = hh % 12 || 12;

    const stamp = `${yyyy}-${MM}-${dd}_${hh}-${min}-${ss}${ampm}`;
    const fileName = `SampleSort_Log_${stamp}.txt`;

    const blob = new Blob([logText], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(url);
  });

  // Clear log button
  els.clearLogBtn.addEventListener("click", () => {

    if (!window.confirm("Clear the log?")) 
    return;

    els.logArea.innerHTML = "";
    if (jumpBtn) jumpBtn.style.display = "none";
    setAutoScrollEnabled(true);
  });

  // Prevent form submit navigation
  els.configForm?.addEventListener("submit", e => e.preventDefault());

  // Move warning
  els.moveFiles.addEventListener("change", () => {
    els.moveWarning.classList.toggle("show", els.moveFiles.checked);
  });

  // Save config
  els.saveConfigBtn.addEventListener("click", async () => {
    try {
      const updated = collectConfigForSave();
      await ipcRenderer.invoke("save-config", updated);
      showNotification("Saved!", "success");
    } catch (err) {
      showNotification("Failed to save config: " + err.message, "error");
    }
  });

  // Start organizing button
  els.startButton.addEventListener("click", () => {
    setAutoScrollEnabled(true);
    const jumpBtn = document.getElementById("jumpToBottom");
    if (jumpBtn) jumpBtn.style.display = "none";

    addValidationListener(els.samplesDir);
    addValidationListener(els.destDir);

    // reset errors
    els.samplesDir.classList.remove("error-border", "error-shake");
    els.destDir.classList.remove("error-border", "error-shake");

    const samplesDirVal = els.samplesDir.value.trim();
    const destDirVal = els.destDir.value.trim();

    if (!samplesDirVal) {
      triggerError(els.samplesDir);
      appendLog("Please select a Sample Directory.", "error");
      return;
    }
    if (!destDirVal) {
      triggerError(els.destDir);
      appendLog("Please select a Destination Directory.", "error");
      return;
    }

    // Build run config for organizer
    let categoriesObj = {};
    if (hasTree) {
      readMainCategories(els.mainRoot).forEach(m =>
        (m.categories || []).forEach(c => { if (c.name) categoriesObj[c.name] = c.keywords || []; })
      );
    } else {
      getListValues(els.categoriesList, "category").forEach(c => {
        if (c.name) categoriesObj[c.name] = c.keywords;
      });
    }

    // Build run config for organizer
    let mains = null;

    if (hasTree) {
      mains = readMainCategories(document.getElementById("mainCategoriesRoot"));
    } else {
      categoriesObj = {};
      getListValues(els.categoriesList, "category").forEach(c => {
        if (c.name) categoriesObj[c.name] = c.keywords;
      });
    }
    
    const runConfig = {
      samplesDir: samplesDirVal,
      destDir: destDirVal,
      moveFiles: els.moveFiles.checked,
      keepArchives: els.keepArchives.checked,
      dryRun: els.dryRun.checked,
      // categories: categoriesObj,
      extensions: getListValues(els.extensionsList),
      archiveExtensions: getListValues(els.archiveExtensionsList),
      checkParentFolder: els.checkParentFolder.checked,
      checkLength: els.checkLength.checked,
      lengthThreshold: Number(els.lengthThreshold.value),
      sortByBPM: els.sortByBPM.checked,
      BPMThreshold: Number(els.BPMThreshold.value),
      dedupeEnabled: els.dedupeEnabled?.checked || false,
      dedupeMode: els.dedupeMode?.value || "skip",
      dedupePreferDest: !!els.dedupePreferDest?.checked,
      dedupeAlgo: els.dedupeAlgo?.value || "sha256",
      keepPackSubfolder: !!els.keepPackSubfolder?.checked,
      packDepth: Math.max(1, Number(els.packDepth?.value || 1)),
      keyNoteOnlyFallback: !!document.getElementById("keyNoteOnlyFallback")?.checked,
      sortMidiToFolder: !!els.sortMidiToFolder?.checked,
      midiFolderName: (els.midiFolderName?.value || "MIDI").trim(),
    };

    if (mains && mains.length) {
      runConfig.mainCategories = mains;
      delete runConfig.categories;
    } else {
      runConfig.categories = categoriesObj;
    }

    els.startButton.disabled = true;
    setStartButtonLabel("Organizing...");
    // appendLog(
    //   `Options: keepArchives=${els.keepArchives.checked}, dryRun=${els.dryRun.checked}, destDir=${destDirVal}`,
    //   "info"
    // );

    ipcRenderer.send("start-organizing", runConfig);
  });

  // Main -> log pass-through
  ipcRenderer.on("organizing-log", (_event, message, type = "info") => {
    appendLog(message, type);
    if (type === "error") {
      els.startButton.disabled = false;
      setStartButtonLabel("Start");
    }
  });

  // Finished organizing -> optional BPM or Key step
  ipcRenderer.on("organizing-done", async (_event, payload) => {
    const setReady = () => {
      els.startButton.disabled = false;
      setStartButtonLabel("Start");
    };

    const destDir  = typeof payload === "string" ? payload : payload?.destDir;
    const newFiles = Array.isArray(payload?.newFiles) ? payload.newFiles : [];
    const isDryRun = (typeof payload === "object" && "dryRun" in payload)
      ? !!payload.dryRun
      : !!els.dryRun?.checked;

    const limitTo = newFiles
      .map(f => f?.dest || f)
      .filter(Boolean)
      .map(p => path.resolve(p));

    if (limitTo.length === 0) {
      setAutoScrollEnabled(true);
      appendLog("No new files to process; skipping BPM/Key.", "warning");

        if (!isDryRun) {
          appendLog("✅ SampleSort complete!", "info");
          const openBtn = document.createElement("button");
          openBtn.textContent = "Open Folder";
          openBtn.style.marginLeft = "10px";
          openBtn.onclick = () => ipcRenderer.invoke("open-path", destDir);
          els.logArea.appendChild(openBtn);
        } else {
          appendLog("☑️ Dry run of SampleSort complete! No files altered. Uncheck Preview run to copy or move files.", "info");
        }

      setReady();
      return;
    }

    setAutoScrollEnabled(true);

    try {
      // Build extensions list
      const extensionsArr = getListValues(els.extensionsList)
        .map(e => String(e).toLowerCase().replace(/^\./, "").trim())
        .filter(Boolean);

      // BPM config
      const bpmCfg = {
        sortByBPM: !!els.sortByBPM.checked,
        BPMThreshold: Number(els.BPMThreshold.value) || 0,
        bpmDebug: !!els.bpmDebug.checked,
        extensions: extensionsArr,
        dryRun: isDryRun,
        samplesDir: els.samplesDir.value.trim(),
        destDir,
        sortByKey: !!els.sortByKey?.checked,
        keyFromParent: !!els.keyFromParent?.checked,
        keyNoteOnlyFallback: !!document.getElementById("keyNoteOnlyFallback")?.checked,
        limitTo,
      };

      // BPM step
      if (bpmCfg.sortByBPM) {
        els.startButton.disabled = true;
        setStartButtonLabel("Analyzing...");
        appendLog("Starting BPM sort...", "warning");

        const processed = await sortByBPM(ipcRenderer, destDir, bpmCfg, appendLog);
        appendLog(`BPM sorting complete. ${processed} files processed.`, "info");
      } else {
        appendLog("BPM sort is not enabled.", "info");
      }

      // Key step
      if (!bpmCancel.requested && els.sortByKey?.checked) {
        appendLog("Applying Key subfolders…", "warning");

        const keyRoot = isDryRun ? els.samplesDir.value.trim() : destDir;

        let movedKeyCount = await ipcRenderer.invoke("apply-key-folders", {
          rootDir: keyRoot,
          extensions: extensionsArr,
          dryRun: isDryRun,
          debug: !!els.bpmDebug.checked,
          keyFromParent: !!els.keyFromParent?.checked,
          keyNoteOnlyFallback: !!document.getElementById("keyNoteOnlyFallback")?.checked,
          limitTo,
        });

        if (!Number.isFinite(movedKeyCount)) movedKeyCount = 0;
        appendLog(`Key sort complete. ${movedKeyCount} file(s) updated.`, "info");
      } else if (bpmCancel.requested) {
        appendLog("⏹ Key sorting cancelled.", "info");
      }

    } catch (err) {
      appendLog(`Failed BPM/Key step: ${err.message}`, "error");
    } finally {

      await sleep(100);

      if (!isDryRun) {
        appendLog("✅ SampleSort complete!", "info");
        const openBtn = document.createElement("button");
        openBtn.textContent = "Open Folder";
        openBtn.style.marginLeft = "10px";
        openBtn.onclick = () => ipcRenderer.invoke("open-path", destDir);
        els.logArea.appendChild(openBtn);
      } else {
        appendLog("☑️ Dry run of SampleSort complete! No files altered. Uncheck Preview run to copy or move files.", "info");
      }

      setReady();
    }
  });
});