const fs = require("fs");

// --- Log auto-scroll helpers ---------------------------------
if (typeof window !== "undefined" && window.__autoScroll === undefined) {
  window.__autoScroll = true; // sticky by default
}

function setAutoScrollEnabled(on) {
  if (typeof window !== "undefined") {
    window.__autoScroll = !!on;
    if (on) {
      const logArea = document.getElementById("logArea");
      if (logArea) logArea.scrollTop = logArea.scrollHeight;
    }
  }
}

function getAutoScrollEnabled() {
  return typeof window !== "undefined" ? !!window.__autoScroll : true;
}

function createListItem(value, listElement, removable = true) {
  const li = document.createElement("li");

  const input = document.createElement("input");
  input.type = "text";
  input.value = value;

  if (removable) {
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.textContent = "❌";
    removeBtn.addEventListener("click", () => li.remove());
    li.append(input, removeBtn);
  } else {
    li.append(input);
  }

  listElement.appendChild(li);
  return li;
}

// createCategoryItem(name, keywords, targetUL, opts?)
function createCategoryItem(name = "", keywords = [], targetUL, opts = {}) {
  const li = document.createElement("li");
  li.className = "category-item";

  // --- visible drag handle (first grid column) ---
  const handle = document.createElement("span");
  handle.className = "drag-handle";
  handle.textContent = "☰";
  handle.title = "Drag to reorder";
  handle.setAttribute("draggable", "true");

  // name input
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.className = "category-input";
  nameInput.placeholder = "Category name";
  nameInput.value = name;

  // keywords input
  const kwInput = document.createElement("input");
  kwInput.type = "text";
  kwInput.className = "keywords-input";
  kwInput.placeholder = "Keywords (comma-separated)";
  kwInput.value = Array.isArray(keywords) ? keywords.join(", ") : (keywords || "");

  // “MATCH ALL” chip (checkbox styled as a pill)
  const allWrap = document.createElement("label");
  allWrap.className = "match-all-chip";
  allWrap.title = "Require all keywords to appear in the file name";

  const allToggle = document.createElement("input");
  allToggle.type = "checkbox";
  allToggle.className = "match-all-toggle";
  allToggle.checked = !!opts.matchAll;

  const allText = document.createElement("span");
  allText.textContent = "MATCH ALL";

  allWrap.append(allToggle, allText);


  // visual state for MATCH ALL
  const applyAllVisual = () => {
    li.classList.toggle("match-all", allToggle.checked);
    kwInput.classList.toggle("match-all-active", allToggle.checked);
    kwInput.placeholder = allToggle.checked
      ? "All words must match (comma/space)"
      : "Keywords (comma-separated)";
  };
  allToggle.addEventListener("change", applyAllVisual);
  applyAllVisual();

  // delete button
  const delBtn = document.createElement("button");
  delBtn.className = "delete-btn";
  delBtn.type = "button";
  delBtn.textContent = "✕";
  delBtn.title = "Remove category";
  delBtn.addEventListener("click", () => li.remove());

  li.append(handle, nameInput, kwInput, allWrap, delBtn);
  targetUL.appendChild(li);
  return li;
}

function getListValues(listElement, type = "simple") {
  return Array.from(listElement.querySelectorAll("li"))
    .map(li => {
      if (type === "category") {
        const inputs = li.querySelectorAll("input[type=text]");
        return {
          name: inputs[0].value.trim(),
          keywords: inputs[1].value
            .split(",")
            .map(k => k.trim())
            .filter(Boolean)
        };
      } else {
        const input = li.querySelector("input[type=text]");
        return input?.value.trim() || li.firstChild?.textContent?.trim() || "";
      }
    })
    .filter(Boolean);
}

function appendLog(message, type = "info") {
  const logArea = document.getElementById("logArea");

  const msgDiv = document.createElement("div");

  switch (type) {
    case "error": msgDiv.style.color = "red"; break;
    case "success": msgDiv.style.color = "green"; break;
    case "warning": msgDiv.style.color = "#E65100"; break;
    default: msgDiv.style.color = "black";
  }

  const timestamp = new Date().toLocaleTimeString();
  msgDiv.dataset.type = type;
  msgDiv.dataset.timestamp = timestamp;
  msgDiv.innerHTML = `[${timestamp}] ${message}`;

  logArea.appendChild(msgDiv);

  // Sticky scroll only if user wants it
  const shouldStick = getAutoScrollEnabled();
  if (shouldStick) {
    requestAnimationFrame(() => {
      logArea.scrollTop = logArea.scrollHeight;
    });
  }

  const wasAtBottom = logArea.scrollHeight - (logArea.scrollTop + logArea.clientHeight) < 20;

  logArea.appendChild(msgDiv);

  if (getAutoScrollEnabled() && wasAtBottom) {
    requestAnimationFrame(() => {
      logArea.scrollTop = logArea.scrollHeight;
    });
  }

  // Show/hide the "Bottom" button
  const jumpBtn = document.getElementById("jumpToBottom");
  if (jumpBtn) {
    const dist = logArea.scrollHeight - (logArea.scrollTop + logArea.clientHeight);
    jumpBtn.style.display = dist > 40 ? "block" : "none";
  }
}

// --- Drag & Drop sorting for <ul> lists of <li> ---
function enableDragSort(listEl) {
  let dragging = null;

  listEl.addEventListener("dragstart", (e) => {
    const root = listEl.closest("#mainCategoriesRoot");
    if (root?.dataset.dragMode === "main") { e.preventDefault(); return; }
    const handle = e.target.closest(".drag-handle");
    if (!handle) { e.preventDefault(); return; }
    const li = handle.closest("li");
    if (!li) { e.preventDefault(); return; }
    dragging = li;
    li.classList.add("dragging");
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      try { e.dataTransfer.setData("text/plain", ""); } catch {}
    }
  });

  listEl.addEventListener("dragover", (e) => {
    if (!dragging) return;
    const root = listEl.closest("#mainCategoriesRoot");
    if (root?.dataset.dragMode === "main") return;
    e.preventDefault();
    const after = getDragAfterElement(listEl, e.clientY);
    if (after == null) listEl.appendChild(dragging);
    else listEl.insertBefore(dragging, after);
  });

  listEl.addEventListener("drop", (e) => {
    const root = listEl.closest("#mainCategoriesRoot");
    if (root?.dataset.dragMode === "main") return;
    if (!dragging) return;
    e.preventDefault();
  });

  listEl.addEventListener("dragend", () => {
    if (dragging) dragging.classList.remove("dragging");
    dragging = null;
  });
}

function getDragAfterElement(container, y) {
  const items = [...container.querySelectorAll("li:not(.dragging)")];
  let closest = { offset: Number.NEGATIVE_INFINITY, element: null };

  for (const el of items) {
    const box = el.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) {
      closest = { offset, element: el };
    }
  }
  return closest.element;
}

// --- Cross-list drag & drop for the main-category tree (precise insertion) ---
function enableCrossListDrag(rootEl) {
  let draggingLI = null;
  let hoverMain = null;

  rootEl.addEventListener("main-drag-start", () => { draggingLI = null; }, true);

  // capture phase so we never miss it
  rootEl.addEventListener("dragstart", (e) => {
    if (rootEl.dataset.dragMode === "main") return;
    const handle = e.target.closest(".drag-handle");
    if (!handle) return; // only start drags from the handle
    const li = handle.closest("li");
    if (!li) return;

    draggingLI = li;
    li.classList.add("dragging");
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      try { e.dataTransfer.setData("text/plain", ""); } catch {}
    }
  }, true);

  rootEl.addEventListener("dragend", () => {
    if (draggingLI) draggingLI.classList.remove("dragging");
    cleanupDndUI();
    draggingLI = null;
  }, true);

  function openForDnd(main) {
    if (!main || main === hoverMain) return;
    if (hoverMain && hoverMain !== main && hoverMain.dataset.openedByDnd === "1") {
      hoverMain.open = false;
      hoverMain.classList.remove("dropover");
      delete hoverMain.dataset.openedByDnd;
    }
    if (!main.open) {
      main.open = true;
      main.dataset.openedByDnd = "1";
    }
    rootEl.querySelectorAll(".main-cat.dropover").forEach(m => m.classList.remove("dropover"));
    main.classList.add("dropover");
    hoverMain = main;
  }

  function cleanupDndUI() {
    rootEl.querySelectorAll(".main-cat.dropover").forEach(m => m.classList.remove("dropover"));
    rootEl.querySelectorAll(".main-cat").forEach(m => {
      if (m.dataset.openedByDnd === "1") {
        m.open = false;
        delete m.dataset.openedByDnd;
      }
    });
    hoverMain = null;
  }

  rootEl.addEventListener("dragover", (e) => {
    if (rootEl.dataset.dragMode === "main") return;
    if (!draggingLI) return;

    const main = e.target.closest(".main-cat");
    const ul   = e.target.closest(".categories-list");
    if (!main || !ul) return;

    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    openForDnd(main);

    const after = getDragAfterElement(ul, e.clientY);
    if (after == null) {
      if (ul.lastElementChild !== draggingLI) ul.appendChild(draggingLI);
    } else if (after !== draggingLI && after.previousSibling !== draggingLI) {
      ul.insertBefore(draggingLI, after);
    }
  }, true);

  rootEl.addEventListener("drop", (e) => {
    if (rootEl.dataset.dragMode === "main") return;
    if (!draggingLI) return;
    e.preventDefault();
    cleanupDndUI();
  }, true);
}

// ---- MAIN CATEGORY TREE HELPERS ----
function createMainCategoryItem(mainName = "", categories = [], rootEl) {
  const wrap = document.createElement("details");
  wrap.className = "main-cat";
  wrap.open = true;

  const summary = document.createElement("summary");
  summary.className = "main-summary";

  const icon = document.createElement("span");
  icon.className = "folder-emoji";
  icon.textContent = "📁";
  icon.title = "Drag to reorder folders";
  icon.setAttribute("draggable", "true");

  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.value = mainName || "Main";
  nameInput.placeholder = "Main category name";
  nameInput.addEventListener("keydown", (e) => {
    if (e.key === " " || e.key === "Enter") e.stopPropagation();
  });

  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.textContent = "❌";
  removeBtn.title = "Remove main category";
  removeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    wrap.remove();
  });

  // Toggle open/close only when clicking the folder emoji
  summary.addEventListener("click", (e) => {
    const clickedFolder = e.target.closest(".folder-emoji");
    if (!clickedFolder) return;
    e.preventDefault();
    wrap.open = !wrap.open;
    wrap.dispatchEvent(new CustomEvent("main-selected", { bubbles: true }));
  });

  const ul = document.createElement("ul");
  ul.className = "categories-list";

  try { enableDragSort(ul); } catch {}

  (categories || []).forEach(c =>
    createCategoryItem(
      c.name || c.category || "",
      c.keywords || [],
      ul,
      { matchAll: !!c.matchAll }
    )
  );

  summary.append(icon, nameInput, removeBtn);
  wrap.append(summary, ul);
  rootEl.appendChild(wrap);
  return wrap;
}

function enableMainReorder(rootEl) {
  let draggingMain = null;

  // Start dragging only from the folder emoji
  rootEl.addEventListener("dragstart", (e) => {
    const handle = e.target.closest(".folder-emoji");
    if (!handle) return;
    const main = handle.closest(".main-cat");
    if (!main) return;

    rootEl.dataset.dragMode = "main";
    rootEl.classList.add("dragging-main");
    rootEl.dispatchEvent(new CustomEvent("main-drag-start"));

    draggingMain = main;
    main.classList.add("dragging");
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      try { e.dataTransfer.setData("text/plain", ""); } catch {}
    }
  }, true);

  rootEl.addEventListener("dragover", (e) => {
    if (!draggingMain) return;
    e.preventDefault();
    const container = rootEl;
    const after = getAfterMain(container, e.clientY);
    if (after == null) {
      if (container.lastElementChild !== draggingMain) container.appendChild(draggingMain);
    } else if (after !== draggingMain && after.previousSibling !== draggingMain) {
      container.insertBefore(draggingMain, after);
    }
  });

  rootEl.addEventListener("drop", (e) => {
    if (!draggingMain) return;
    e.preventDefault();
    rootEl.classList.remove("dragging-main");
    delete rootEl.dataset.dragMode;
  });

  rootEl.addEventListener("dragend", () => {
    if (draggingMain) draggingMain.classList.remove("dragging");
    draggingMain = null;
    rootEl.classList.remove("dragging-main");
    delete rootEl.dataset.dragMode;
  });
}

function getAfterMain(container, y) {
  const mains = [...container.querySelectorAll(".main-cat")]
    .filter(el => el.parentElement === container && !el.classList.contains("dragging"));

  let closest = { offset: Number.NEGATIVE_INFINITY, element: null };
  for (const el of mains) {
    const box = el.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) {
      closest = { offset, element: el };
    }
  }
  return closest.element;
}

function readMainCategories(rootEl) {
  const mains = [];
  rootEl.querySelectorAll(".main-cat").forEach(main => {
    const mainName = main.querySelector(".main-summary input")?.value?.trim() || "";
    const cats = [];
    main.querySelectorAll(".categories-list > li.category-item").forEach(li => {
      const name = li.querySelector(".category-input")?.value?.trim();
      const kwStr = li.querySelector(".keywords-input")?.value || "";
      const matchAll = !!li.querySelector(".match-all-toggle")?.checked;
      if (!name) return;
      const keywords = kwStr.split(/[,\n;]+/).map(s => s.trim()).filter(Boolean);
      cats.push({ name, keywords, matchAll });
    });
    mains.push({ name: mainName, categories: cats });
  });
  return mains;
}

module.exports = {
  createListItem,
  createCategoryItem,
  getListValues,
  appendLog,
  enableDragSort,
  enableCrossListDrag,
  enableMainReorder,
  createMainCategoryItem,
  readMainCategories,
  setAutoScrollEnabled,
  getAutoScrollEnabled,
};