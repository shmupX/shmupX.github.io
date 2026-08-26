// editor.js — the Code Editor app for the CMG Desktop.
//
// Layout mirrors the Phaser Desktop code editor: menu row (File / Edit /
// View), a Files/Assets sidebar over the shared workspace, a tab strip,
// line-number gutter, and a status bar with path · Ln,Col · language. The
// editor core is dependency-free: a transparent <textarea> stacked on a
// highlighted <pre>, scroll-synced, so native editing (undo, IME, selection)
// keeps working while a small regex tokenizer paints the tokens.
//
// env contract (provided by desktop.js):
//   getWorkspace(): FileSystemDirectoryHandle | null
//   requestWorkspace(): Promise<handle|null>   — user-gesture picker
//   openIframe(title, url, lucideName)         — preview windows
//   openImage(name, blob)                      — image viewer window
//   notify(text)                               — toast
// Instances register with onWorkspaceChanged so a folder picked in the
// Files app shows up in every editor's sidebar too.

import * as fs from "./fs.js";
import { glyphIcon } from "./icons.js";

const KEYWORDS = {
  js: "abstract async await break case catch class const continue debugger default delete do else enum export extends finally for from function get if implements import in instanceof interface let new of private protected public return set static super switch this throw try type typeof var void while with yield as declare namespace readonly satisfies keyof infer is",
  css: "",
  html: "",
  json: "",
  md: "",
  py: "and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case",
  sh: "if then else elif fi for while until do done case esac function in select time coproc",
};
const LITERALS = "true false null undefined None True False NaN Infinity";

function langOf(name) {
  const e = fs.ext(name);
  if (["js", "mjs", "cjs", "jsx", "ts", "tsx", "svelte"].includes(e)) return "js";
  if (["json", "map", "lock"].includes(e)) return "json";
  if (["css"].includes(e)) return "css";
  if (["html", "htm", "xml", "svg", "vue", "astro", "tmx"].includes(e)) return "html";
  if (["md", "markdown"].includes(e)) return "md";
  if (["py"].includes(e)) return "py";
  if (["sh", "bash"].includes(e)) return "sh";
  return "plain";
}

const LANG_LABEL = {
  js: "JAVASCRIPT",
  json: "JSON",
  css: "CSS",
  html: "HTML",
  md: "MARKDOWN",
  py: "PYTHON",
  sh: "SHELL",
  plain: "PLAIN TEXT",
};

function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// String-literal patterns written so the two alternatives can never match the
// same character — a backslash only ever takes the escape branch. The obvious
// form, (?:\\.|[^"\n])*, is ambiguous and backtracks exponentially on an
// unterminated string full of backslashes, which is exactly what a file looks
// like mid-keystroke.
const STR_DQ = '"(?:[^"\\\\\\n]|\\\\.)*"';
const STR_SQ = "'(?:[^'\\\\\\n]|\\\\.)*'";
const STR_TICK = "`(?:[^`\\\\]|\\\\[\\s\\S])*`";

// Ordered token rules per language; first match wins. Each rule is
// [cssClass, regexSource]. Combined into one global regex, everything
// between matches passes through as plain text.
function rulesFor(lang) {
  const kw = KEYWORDS[lang];
  const kwRule = kw
    ? ["kw", `\\b(?:${kw.trim().split(/\s+/).join("|")})\\b`]
    : null;
  const litRule = ["lit", `\\b(?:${LITERALS.split(" ").join("|")})\\b`];
  const num = ["num", "\\b0[xXbBoO][0-9a-fA-F]+\\b|\\b\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b"];
  switch (lang) {
    case "js":
      return [
        ["cmt", "\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/"],
        ["str", `${STR_TICK}|${STR_DQ}|${STR_SQ}`],
        ["prop", "[A-Za-z_$][\\w$]*(?=\\s*:)"],
        kwRule,
        litRule,
        num,
        ["fn", "[A-Za-z_$][\\w$]*(?=\\s*\\()"],
        ["brace", "[{}\\[\\]()]"],
      ].filter(Boolean);
    case "json":
      return [
        ["prop", `${STR_DQ}(?=\\s*:)`],
        ["str", STR_DQ],
        litRule,
        num,
        ["brace", "[{}\\[\\]]"],
      ];
    case "css":
      return [
        ["cmt", "\\/\\*[\\s\\S]*?\\*\\/"],
        ["str", `${STR_DQ}|${STR_SQ}`],
        ["kw", "@[\\w-]+"],
        ["prop", "[\\w-]+(?=\\s*:)"],
        ["num", "-?\\b\\d+(?:\\.\\d+)?(?:px|em|rem|vh|vw|s|ms|%|deg|fr)?\\b"],
        ["fn", "[\\w-]+(?=\\()"],
        ["brace", "[{}]"],
      ];
    case "html":
      return [
        ["cmt", "<!--[\\s\\S]*?-->"],
        ["str", "\"[^\"]*\"|'[^']*'"],
        ["kw", "</?[a-zA-Z][\\w-]*|/?>"],
        ["prop", "\\b[a-zA-Z-]+(?==)"],
      ];
    case "md":
      return [
        ["kw", "^#{1,6}[^\\n]*$"],
        ["cmt", "```[\\s\\S]*?```|`[^`\\n]*`"],
        ["str", "\\*\\*[^*\\n]+\\*\\*|_[^_\\n]+_"],
        ["fn", "\\[[^\\]\\n]*\\]\\([^)\\n]*\\)"],
      ];
    case "py":
    case "sh":
      return [
        ["cmt", "#[^\\n]*"],
        ["str", `"""[\\s\\S]*?"""|'''[\\s\\S]*?'''|${STR_DQ}|${STR_SQ}`],
        kwRule,
        litRule,
        num,
        ["fn", "[A-Za-z_][\\w]*(?=\\s*\\()"],
      ].filter(Boolean);
    default:
      return [];
  }
}

const ruleCache = new Map();
const HIGHLIGHT_LIMIT = 400_000; // beyond this, plain text — keep typing snappy

export function highlight(text, lang) {
  if (lang === "plain" || text.length > HIGHLIGHT_LIMIT) return esc(text);
  let compiled = ruleCache.get(lang);
  if (!compiled) {
    const rules = rulesFor(lang);
    compiled = {
      classes: rules.map((r) => r[0]),
      re: new RegExp(rules.map((r) => `(${r[1]})`).join("|"), "gm"),
    };
    ruleCache.set(lang, compiled);
  }
  let out = "";
  let last = 0;
  compiled.re.lastIndex = 0;
  for (const m of text.matchAll(compiled.re)) {
    let g = 0;
    while (m[g + 1] === undefined) g++;
    out += esc(text.slice(last, m.index));
    out += `<span class="tk-${compiled.classes[g]}">${esc(m[0])}</span>`;
    last = m.index + m[0].length;
  }
  return out + esc(text.slice(last));
}

let untitledCounter = 0;

export class CodeEditor {
  constructor(env) {
    this.env = env;
    this.tabs = [];
    this.active = -1;
    this.wrap = false;
    this.fontSize = 13;
    this.buildDom();
  }

  buildDom() {
    const el = document.createElement("div");
    el.className = "editor-app";
    el.innerHTML = `
      <div class="ed-menubar">
        <div class="ed-menus"></div>
        <div class="ed-menu-center"></div>
        <div class="ed-menus-right"></div>
      </div>
      <div class="ed-main">
        <aside class="ed-sidebar">
          <div class="ed-side-tabs">
            <button class="ed-side-tab active" data-pane="files">Files</button>
            <button class="ed-side-tab" data-pane="assets">Assets</button>
          </div>
          <div class="ed-tree" data-pane-el="files"></div>
          <div class="ed-assets" data-pane-el="assets" hidden></div>
        </aside>
        <div class="ed-editor-col">
          <div class="ed-tabstrip"></div>
          <div class="ed-code-wrap">
            <div class="ed-gutter"></div>
            <div class="ed-code-area">
              <pre class="ed-hl" aria-hidden="true"><code></code></pre>
              <textarea class="ed-input" spellcheck="false" autocapitalize="off" autocomplete="off" wrap="off"></textarea>
            </div>
            <div class="ed-empty">
              <div class="ed-empty-inner">
                <div class="ed-empty-glyph">&lt;/&gt;</div>
                <p>Open a file from the sidebar,<br>or <b>File &gt; New File</b>.</p>
              </div>
            </div>
          </div>
          <div class="ed-status">
            <span class="ed-status-path"></span>
            <span class="ed-status-right">
              <span class="ed-status-pos">Ln 1, Col 1</span>
              <span class="ed-status-lang">PLAIN TEXT</span>
            </span>
          </div>
        </div>
      </div>
    `;
    this.el = el;
    this.treeEl = el.querySelector(".ed-tree");
    this.assetsEl = el.querySelector(".ed-assets");
    this.tabstrip = el.querySelector(".ed-tabstrip");
    this.gutter = el.querySelector(".ed-gutter");
    this.hl = el.querySelector(".ed-hl code");
    this.hlPre = el.querySelector(".ed-hl");
    this.input = el.querySelector(".ed-input");
    this.emptyEl = el.querySelector(".ed-empty");
    this.statusPath = el.querySelector(".ed-status-path");
    this.statusPos = el.querySelector(".ed-status-pos");
    this.statusLang = el.querySelector(".ed-status-lang");

    this.buildMenus(el.querySelector(".ed-menus"));
    this.buildPreviewButton(el.querySelector(".ed-menu-center"));

    for (const btn of el.querySelectorAll(".ed-side-tab")) {
      btn.addEventListener("click", () => {
        for (const b of el.querySelectorAll(".ed-side-tab")) {
          b.classList.toggle("active", b === btn);
        }
        const pane = btn.dataset.pane;
        this.treeEl.hidden = pane !== "files";
        this.assetsEl.hidden = pane !== "assets";
        if (pane === "assets") this.renderAssets();
      });
    }

    this.input.addEventListener("input", () => this.onInput());
    this.input.addEventListener("scroll", () => this.syncScroll());
    const posEvents = ["keyup", "click", "input", "select"];
    for (const ev of posEvents) {
      this.input.addEventListener(ev, () => this.updatePos());
    }
    this.input.addEventListener("keydown", (e) => this.onEditorKey(e));
    el.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        this.save();
      }
    });

    this.renderTree();
    this.renderTabs();
    this.applyView();
  }

  buildPreviewButton(container) {
    this.previewBtn = document.createElement("button");
    this.previewBtn.className = "btn-accent ed-preview";
    this.previewBtn.innerHTML = "&#9655; Preview";
    this.previewBtn.title = "Open this HTML file in a preview window";
    this.previewBtn.addEventListener("click", () => this.preview());
    container.appendChild(this.previewBtn);
  }

  buildMenus(bar) {
    const menus = {
      File: [
        ["New File", () => this.newFile()],
        ["Open Folder\u2026", () => this.openFolder()],
        ["Save", () => this.save(), "Ctrl+S"],
        ["Download", () => this.download()],
        ["Close Tab", () => this.closeTab(this.active)],
      ],
      Edit: [
        ["Undo", () => this.exec("undo"), "Ctrl+Z"],
        ["Redo", () => this.exec("redo"), "Ctrl+Y"],
        ["Cut", () => this.exec("cut"), "Ctrl+X"],
        ["Copy", () => this.exec("copy"), "Ctrl+C"],
        ["Paste", () => this.paste(), "Ctrl+V"],
        ["Select All", () => {
          this.input.focus();
          this.input.select();
        }, "Ctrl+A"],
      ],
      View: [
        ["Toggle Word Wrap", () => {
          this.wrap = !this.wrap;
          this.applyView();
        }],
        ["Larger Text", () => {
          this.fontSize = Math.min(22, this.fontSize + 1);
          this.applyView();
        }],
        ["Smaller Text", () => {
          this.fontSize = Math.max(9, this.fontSize - 1);
          this.applyView();
        }],
      ],
    };
    for (const [name, items] of Object.entries(menus)) {
      const btn = document.createElement("button");
      btn.className = "ed-menu-btn";
      btn.textContent = name;
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.showMenu(btn, items);
      });
      bar.appendChild(btn);
    }
  }

  showMenu(anchor, items) {
    document.querySelector(".ed-menu-pop")?.remove();
    const pop = document.createElement("div");
    pop.className = "ed-menu-pop";
    for (const [label, fn, hint] of items) {
      const item = document.createElement("button");
      item.className = "ed-menu-item";
      item.innerHTML = `<span>${label}</span>${hint ? `<kbd>${hint}</kbd>` : ""}`;
      item.addEventListener("click", () => {
        pop.remove();
        fn();
      });
      pop.appendChild(item);
    }
    const r = anchor.getBoundingClientRect();
    pop.style.left = `${r.left}px`;
    pop.style.top = `${r.bottom + 2}px`;
    document.body.appendChild(pop);
    const dismiss = (e) => {
      if (!pop.contains(e.target)) {
        pop.remove();
        document.removeEventListener("pointerdown", dismiss, true);
      }
    };
    document.addEventListener("pointerdown", dismiss, true);
  }

  exec(cmd) {
    this.input.focus();
    document.execCommand(cmd);
    this.onInput();
  }

  async paste() {
    this.input.focus();
    try {
      const text = await navigator.clipboard.readText();
      this.input.setRangeText(text, this.input.selectionStart, this.input.selectionEnd, "end");
      this.onInput();
    } catch (_e) {
      this.env.notify("Clipboard blocked — use Ctrl+V in the editor.");
    }
  }

  applyView() {
    this.input.wrap = this.wrap ? "soft" : "off";
    const area = this.el.querySelector(".ed-code-area");
    area.classList.toggle("wrap", this.wrap);
    // One logical line can span several visual rows once wrapping is on, so a
    // one-number-per-line gutter would drift further out of alignment down the
    // file. Hide it rather than show wrong numbers.
    this.gutter.classList.toggle("gutter-off", this.wrap);
    for (const n of [this.input, this.hlPre, this.gutter]) {
      n.style.fontSize = `${this.fontSize}px`;
    }
    this.rehighlight();
  }

  // ---- tabs ------------------------------------------------------------

  tab() {
    return this.tabs[this.active] ?? null;
  }

  openTab(tab) {
    const existing = this.tabs.findIndex((t) =>
      t.path === tab.path && tab.path !== null
    );
    if (existing !== -1) {
      this.activate(existing);
      return;
    }
    this.tabs.push(tab);
    this.activate(this.tabs.length - 1);
  }

  activate(i) {
    const prev = this.tab();
    if (prev) prev.text = this.input.value;
    this.active = i;
    const t = this.tab();
    if (t) {
      this.input.value = t.text;
      this.input.scrollTop = 0;
      this.input.scrollLeft = 0;
    }
    this.renderTabs();
    this.rehighlight();
    this.updateStatus();
    if (t) this.input.focus();
  }

  closeTab(i) {
    const t = this.tabs[i];
    if (!t) return;
    if (i === this.active) t.text = this.input.value;
    if (t.text !== t.savedText) {
      if (!confirm(`"${t.name}" has unsaved changes. Close anyway?`)) return;
    }
    // Track the active tab by identity — splicing an earlier tab shifts
    // indices, and activate() must never save the textarea into the wrong tab.
    const activeTab = this.tabs[this.active];
    this.tabs.splice(i, 1);
    if (t === activeTab) {
      this.active = -1; // closed tab is gone; nothing to save on activate
      const next = Math.min(i, this.tabs.length - 1);
      if (next >= 0) this.activate(next);
      else {
        this.input.value = "";
        this.renderTabs();
        this.rehighlight();
        this.updateStatus();
      }
    } else {
      this.active = this.tabs.indexOf(activeTab);
      this.renderTabs();
    }
  }

  renderTabs() {
    this.tabstrip.textContent = "";
    this.tabs.forEach((t, i) => {
      const el = document.createElement("div");
      el.className = "ed-tab" + (i === this.active ? " active" : "");
      const dirty = (i === this.active ? this.input.value : t.text) !== t.savedText;
      el.innerHTML = `
        <span class="ed-tab-glyph"></span>
        <span class="ed-tab-name"></span>
        <button class="ed-tab-close" title="Close">${dirty ? "&#9679;" : "&#10005;"}</button>`;
      el.querySelector(".ed-tab-glyph").appendChild(glyphIcon("file-text", "xs"));
      el.querySelector(".ed-tab-name").textContent = t.name;
      el.addEventListener("click", () => this.activate(i));
      el.addEventListener("auxclick", (e) => {
        if (e.button === 1) this.closeTab(i);
      });
      el.querySelector(".ed-tab-close").addEventListener("click", (e) => {
        e.stopPropagation();
        this.closeTab(i);
      });
      this.tabstrip.appendChild(el);
    });
    this.emptyEl.hidden = this.tabs.length > 0;
    this.input.parentElement.style.visibility = this.tabs.length ? "" : "hidden";
    this.gutter.style.visibility = this.tabs.length ? "" : "hidden";
    const t = this.tab();
    this.previewBtn.disabled = !t || langOf(t.name) !== "html";
  }

  // ---- editing ---------------------------------------------------------

  onEditorKey(e) {
    if (e.key === "Tab" && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      this.input.setRangeText("  ", this.input.selectionStart, this.input.selectionEnd, "end");
      this.onInput();
    }
  }

  onInput() {
    const t = this.tab();
    if (!t) return;
    t.text = this.input.value;
    if (!this.hlPending) {
      this.hlPending = true;
      requestAnimationFrame(() => {
        this.hlPending = false;
        this.rehighlight();
      });
    }
    // Dirty dot without a full strip rebuild.
    const btn = this.tabstrip.children[this.active]?.querySelector(".ed-tab-close");
    if (btn) btn.innerHTML = t.text !== t.savedText ? "&#9679;" : "&#10005;";
  }

  rehighlight() {
    const t = this.tab();
    const text = t ? this.input.value : "";
    const lang = t ? langOf(t.name) : "plain";
    // Trailing newline keeps the pre's last line height in sync with textarea.
    this.hl.innerHTML = highlight(text, lang) + "\n";
    const lines = text.split("\n").length;
    if (this.gutterLines !== lines) {
      this.gutterLines = lines;
      let g = "";
      for (let i = 1; i <= lines; i++) g += i + "\n";
      this.gutter.textContent = g;
    }
    this.syncScroll();
  }

  syncScroll() {
    this.hlPre.scrollTop = this.input.scrollTop;
    this.hlPre.scrollLeft = this.input.scrollLeft;
    this.gutter.scrollTop = this.input.scrollTop;
  }

  updatePos() {
    const p = this.input.selectionStart ?? 0;
    const before = this.input.value.slice(0, p);
    const line = (before.match(/\n/g)?.length ?? 0) + 1;
    const col = p - before.lastIndexOf("\n");
    this.statusPos.textContent = `Ln ${line}, Col ${col}`;
  }

  updateStatus() {
    const t = this.tab();
    this.statusPath.textContent = t ? (t.path ?? t.name) : "";
    this.statusLang.textContent = t ? LANG_LABEL[langOf(t.name)] : "";
    this.updatePos();
  }

  // ---- file operations -------------------------------------------------

  // Asked by the window manager before the editor window closes: closing the
  // frame must not silently drop edits the way closing one tab never does.
  confirmClose() {
    const active = this.tab();
    if (active) active.text = this.input.value;
    const dirty = this.tabs.filter((t) => t.text !== t.savedText);
    if (!dirty.length) return true;
    const names = dirty.map((t) => t.name).join(", ");
    return confirm(
      `${dirty.length} file${dirty.length === 1 ? " has" : "s have"} unsaved changes (${names}). Close the editor anyway?`,
    );
  }

  newFile() {
    const name = `untitled-${++untitledCounter}.js`;
    this.openTab({ name, path: null, handle: null, dir: null, text: "", savedText: "" });
  }

  async openFolder() {
    const handle = await this.env.requestWorkspace();
    if (handle) this.renderTree();
  }

  async openFileEntry(fileHandle, path, dirHandle) {
    if (fs.kindOf(fileHandle.name) === "image") {
      this.env.openImage(fileHandle.name, await fs.readFileBlob(fileHandle));
      return;
    }
    if (fs.kindOf(fileHandle.name) === "binary" || fs.kindOf(fileHandle.name) === "audio") {
      this.env.notify(`"${fileHandle.name}" is not a text file.`);
      return;
    }
    try {
      const { text } = await fs.readFileText(fileHandle);
      this.openTab({
        name: fileHandle.name,
        path,
        handle: fileHandle,
        dir: dirHandle,
        text,
        savedText: text,
      });
    } catch (e) {
      this.env.notify(`Could not open ${fileHandle.name}: ${e.message || e}`);
    }
  }

  async save() {
    const t = this.tab();
    if (!t) return;
    t.text = this.input.value;
    if (!t.handle) {
      const ws = this.env.getWorkspace();
      if (ws) {
        const name = prompt("Save as (in workspace root):", t.name);
        if (!name) return;
        try {
          t.handle = await fs.createFile(ws, name);
          t.name = name;
          t.path = name;
        } catch (e) {
          this.env.notify(`Could not create ${name}: ${e.message || e}`);
          return;
        }
      } else {
        this.download();
        return;
      }
    }
    try {
      await fs.writeFileText(t.handle, t.text);
      t.savedText = t.text;
      this.renderTabs();
      this.updateStatus();
      this.flashStatus("Saved \u2713");
    } catch (e) {
      this.env.notify(`Save failed: ${e.message || e}`);
    }
  }

  download() {
    const t = this.tab();
    if (!t) return;
    const blob = new Blob([this.input.value], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = t.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  preview() {
    const t = this.tab();
    if (!t || langOf(t.name) !== "html") return;
    const blob = new Blob([this.input.value], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    this.env.openIframe(`Preview — ${t.name}`, url, "play");
  }

  flashStatus(text) {
    const prev = this.statusPath.textContent;
    this.statusPath.textContent = text;
    setTimeout(() => {
      if (this.statusPath.textContent === text) {
        this.statusPath.textContent = prev;
      }
    }, 1400);
  }

  // ---- sidebar: files tree --------------------------------------------

  async renderTree() {
    const ws = this.env.getWorkspace();
    this.treeEl.textContent = "";
    if (!ws) {
      const open = document.createElement("button");
      open.className = "btn-accent ed-open-folder";
      open.textContent = fs.supported ? "Open Folder\u2026" : "Local files unavailable";
      open.disabled = !fs.supported;
      open.addEventListener("click", () => this.openFolder());
      const hint = document.createElement("p");
      hint.className = "ed-tree-hint";
      hint.textContent = fs.supported
        ? "Pick a local folder to browse and edit its files."
        : "This browser has no File System Access API — use Chrome or Edge for local file editing.";
      this.treeEl.append(open, hint);
      return;
    }
    const rootRow = document.createElement("div");
    rootRow.className = "ed-tree-root";
    rootRow.innerHTML = `<span class="tree-caret">&#9662;</span> <span class="tree-folder"></span> `;
    rootRow.querySelector(".tree-folder").appendChild(glyphIcon("folder", "xs"));
    const nameSpan = document.createElement("b");
    nameSpan.textContent = ws.name;
    rootRow.appendChild(nameSpan);
    const refresh = document.createElement("button");
    refresh.className = "ed-tree-refresh";
    refresh.title = "Refresh";
    refresh.innerHTML = "&#8635;";
    refresh.addEventListener("click", () => this.renderTree());
    rootRow.appendChild(refresh);
    this.treeEl.appendChild(rootRow);
    const kids = document.createElement("div");
    kids.className = "ed-tree-kids";
    this.treeEl.appendChild(kids);
    await this.renderTreeLevel(ws, kids, "", 0);
  }

  async renderTreeLevel(dirHandle, container, prefix, depth) {
    let entries;
    try {
      entries = await fs.listDir(dirHandle);
    } catch (e) {
      container.textContent = `(${e.message || e})`;
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const row = document.createElement("div");
      row.className = "ed-tree-row";
      row.style.paddingLeft = `${8 + depth * 14}px`;
      const path = prefix + entry.name;
      if (entry.kind === "directory") {
        row.innerHTML = `<span class="tree-caret">&#9656;</span> <span class="tree-folder"></span> <span class="tree-name"></span>`;
        row.querySelector(".tree-folder").appendChild(glyphIcon("folder", "xs"));
        row.querySelector(".tree-name").textContent = entry.name;
        const kids = document.createElement("div");
        kids.className = "ed-tree-kids";
        kids.hidden = true;
        let loaded = false;
        row.addEventListener("click", async () => {
          kids.hidden = !kids.hidden;
          row.querySelector(".tree-caret").innerHTML = kids.hidden ? "&#9656;" : "&#9662;";
          if (!loaded && !kids.hidden) {
            loaded = true;
            await this.renderTreeLevel(entry, kids, path + "/", depth + 1);
          }
        });
        container.append(row, kids);
      } else {
        row.innerHTML = `<span class="tree-caret"></span> <span class="tree-file"></span> <span class="tree-name"></span>`;
        row.querySelector(".tree-file").appendChild(
          glyphIcon(fs.kindOf(entry.name) === "image" ? "image" : "file-text", "xs"),
        );
        row.querySelector(".tree-name").textContent = entry.name;
        row.addEventListener("click", () => this.openFileEntry(entry, path, dirHandle));
        container.appendChild(row);
      }
    }
    if (!entries.length) {
      const empty = document.createElement("div");
      empty.className = "ed-tree-row ed-tree-empty";
      empty.style.paddingLeft = `${8 + depth * 14}px`;
      empty.textContent = "(empty)";
      container.appendChild(empty);
    }
  }

  // ---- sidebar: assets pane -------------------------------------------

  async renderAssets() {
    const ws = this.env.getWorkspace();
    this.assetsEl.textContent = "";
    if (!ws) {
      this.assetsEl.innerHTML = `<p class="ed-tree-hint">Open a folder to see its images here.</p>`;
      return;
    }
    const grid = document.createElement("div");
    grid.className = "ed-assets-grid";
    this.assetsEl.appendChild(grid);
    let count = 0;
    const walk = async (dir, prefix, depth) => {
      if (count >= 60 || depth > 4) return;
      let entries;
      try {
        entries = await fs.listDir(dir);
      } catch (_e) {
        return;
      }
      for (const entry of entries) {
        if (count >= 60) return;
        if (entry.kind === "directory") {
          if (entry.name === "node_modules" || entry.name === ".git") continue;
          await walk(entry, prefix + entry.name + "/", depth + 1);
        } else if (fs.kindOf(entry.name) === "image") {
          count++;
          const cell = document.createElement("button");
          cell.className = "ed-asset";
          cell.title = prefix + entry.name;
          const img = document.createElement("img");
          const blob = await fs.readFileBlob(entry);
          img.src = URL.createObjectURL(blob);
          img.addEventListener("load", () => URL.revokeObjectURL(img.src), { once: true });
          const label = document.createElement("span");
          label.textContent = entry.name;
          cell.append(img, label);
          cell.addEventListener("click", async () => {
            this.env.openImage(entry.name, await fs.readFileBlob(entry));
          });
          grid.appendChild(cell);
        }
      }
    };
    await walk(ws, "", 0);
    if (!count) {
      this.assetsEl.innerHTML = `<p class="ed-tree-hint">No images found in this folder.</p>`;
    }
  }
}
