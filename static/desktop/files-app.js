// files-app.js — the Files (local file explorer) app for the CMG Desktop.
//
// A single-pane list view over the shared workspace directory handle:
// breadcrumb navigation, new file/folder, rename, delete, download, and
// OS-drag-drop import into the current folder. Text files open in the Code
// Editor (via env.openInEditor), images in the viewer. All file access goes
// through fs.js — this file is only UI.
//
// env contract (desktop.js): getWorkspace, requestWorkspace, openInEditor,
// openImage, notify, onWorkspaceChange(cb) → unsubscribe.

import * as fs from "./fs.js";
import { glyphIcon } from "./icons.js";

const ICON_NAME = {
  dir: "folder",
  image: "image",
  audio: "music",
  text: "file-text",
  binary: "package",
};

export class FilesApp {
  constructor(env) {
    this.env = env;
    this.stack = []; // [{handle, name}] from workspace root to cwd
    this.selected = null; // entry handle currently selected
    this.buildDom();
    this.unsubscribe = env.onWorkspaceChange(() => this.reset());
    this.reset();
  }

  destroy() {
    this.unsubscribe?.();
  }

  buildDom() {
    const el = document.createElement("div");
    el.className = "files-app";
    el.innerHTML = `
      <div class="fa-toolbar">
        <button class="fa-btn fa-open" title="Open a local folder">Open Folder</button>
        <span class="fa-sep"></span>
        <button class="fa-btn fa-newfile" title="New file">+ File</button>
        <button class="fa-btn fa-newdir" title="New folder">+ Folder</button>
        <button class="fa-btn fa-rename" title="Rename selected">Rename</button>
        <button class="fa-btn fa-delete" title="Delete selected">Delete</button>
        <button class="fa-btn fa-download" title="Download selected file">Download</button>
        <span class="fa-flex"></span>
        <button class="fa-btn fa-refresh" title="Refresh">&#8635;</button>
      </div>
      <div class="fa-crumbs"></div>
      <div class="fa-list" tabindex="0"></div>
      <div class="fa-status"></div>
    `;
    this.el = el;
    this.crumbsEl = el.querySelector(".fa-crumbs");
    this.listEl = el.querySelector(".fa-list");
    this.statusEl = el.querySelector(".fa-status");

    el.querySelector(".fa-open").addEventListener("click", async () => {
      await this.env.requestWorkspace();
    });
    el.querySelector(".fa-refresh").addEventListener("click", () => this.render());
    el.querySelector(".fa-newfile").addEventListener("click", () => this.newEntry(false));
    el.querySelector(".fa-newdir").addEventListener("click", () => this.newEntry(true));
    el.querySelector(".fa-rename").addEventListener("click", () => this.renameSelected());
    el.querySelector(".fa-delete").addEventListener("click", () => this.deleteSelected());
    el.querySelector(".fa-download").addEventListener("click", () => this.downloadSelected());

    this.listEl.addEventListener("keydown", (e) => {
      if (e.key === "Delete") this.deleteSelected();
      if (e.key === "F2") this.renameSelected();
      if (e.key === "Enter" && this.selected) this.openEntry(this.selected);
    });

    // OS drag-drop import into the current folder.
    el.addEventListener("dragover", (e) => {
      if (!this.cwd()) return;
      e.preventDefault();
      el.classList.add("fa-droppable");
    });
    el.addEventListener("dragleave", () => el.classList.remove("fa-droppable"));
    el.addEventListener("drop", async (e) => {
      e.preventDefault();
      el.classList.remove("fa-droppable");
      const dir = this.cwd();
      if (!dir || !e.dataTransfer?.items?.length) return;
      // Read the entries BEFORE the first await — DataTransferItemList is
      // emptied once the drop event handler yields. A dragged folder shows up
      // in .files as an unreadable pseudo-File, so filter by entry kind and
      // skip directories rather than creating a 0-byte file named after them.
      const picked = [];
      let skippedDirs = 0;
      for (const item of e.dataTransfer.items) {
        if (item.kind !== "file") continue;
        const entry = item.webkitGetAsEntry?.();
        if (entry && !entry.isFile) {
          skippedDirs++;
          continue;
        }
        const file = item.getAsFile();
        if (file) picked.push(file);
      }
      let n = 0;
      for (const file of picked) {
        try {
          const handle = await fs.createFile(dir, file.name);
          await fs.writeFileBlob(handle, file);
          n++;
        } catch (err) {
          // Don't leave the empty handle createFile just made behind.
          await fs.removeEntry(dir, file.name, false).catch(() => {});
          this.env.notify(`Import failed for ${file.name}: ${err.message || err}`);
        }
      }
      if (n) this.env.notify(`Imported ${n} file${n === 1 ? "" : "s"}.`);
      if (skippedDirs) {
        this.env.notify(
          `Skipped ${skippedDirs} folder${skippedDirs === 1 ? "" : "s"} — drop files, not folders.`,
        );
      }
      this.render();
    });
  }

  cwd() {
    return this.stack.at(-1)?.handle ?? null;
  }

  reset() {
    const ws = this.env.getWorkspace();
    this.stack = ws ? [{ handle: ws, name: ws.name }] : [];
    this.selected = null;
    this.render();
  }

  async render() {
    this.crumbsEl.textContent = "";
    this.listEl.textContent = "";
    this.selected = null;
    const dir = this.cwd();
    if (!dir) {
      const empty = document.createElement("div");
      empty.className = "fa-empty";
      empty.innerHTML = fs.supported
        ? `<div class="fa-empty-glyph"></div>
           <p>No folder open.</p>
           <p class="fa-hint">Open a local folder to browse and edit its files.<br>
           Nothing is uploaded — files stay on this machine.</p>`
        : `<div class="fa-empty-glyph">!</div>
           <p>This browser has no File System Access API.</p>
           <p class="fa-hint">Use Chrome or Edge to browse local files.</p>`;
      const glyph = empty.querySelector(".fa-empty-glyph");
      if (fs.supported && glyph) glyph.appendChild(glyphIcon("folder", "lg"));
      if (fs.supported) {
        const btn = document.createElement("button");
        btn.className = "btn-accent";
        btn.textContent = "Open Folder…";
        btn.addEventListener("click", () => this.env.requestWorkspace());
        empty.appendChild(btn);
      }
      this.listEl.appendChild(empty);
      this.statusEl.textContent = "";
      return;
    }

    this.stack.forEach((seg, i) => {
      const crumb = document.createElement("button");
      crumb.className = "fa-crumb";
      crumb.textContent = seg.name;
      crumb.addEventListener("click", () => {
        this.stack = this.stack.slice(0, i + 1);
        this.render();
      });
      this.crumbsEl.appendChild(crumb);
      if (i < this.stack.length - 1) {
        const sep = document.createElement("span");
        sep.className = "fa-crumb-sep";
        sep.textContent = "/";
        this.crumbsEl.appendChild(sep);
      }
    });

    let entries;
    try {
      entries = await fs.listDir(dir);
    } catch (e) {
      this.statusEl.textContent = `Cannot read folder: ${e.message || e}`;
      return;
    }
    let dirs = 0, files = 0;
    for (const entry of entries) {
      const row = document.createElement("div");
      row.className = "fa-row";
      const isDir = entry.kind === "directory";
      isDir ? dirs++ : files++;
      const kind = isDir ? "dir" : fs.kindOf(entry.name);
      row.innerHTML = `<span class="fa-row-icon"></span>
        <span class="fa-row-name"></span><span class="fa-row-meta"></span>`;
      row.querySelector(".fa-row-icon").appendChild(glyphIcon(ICON_NAME[kind], "sm"));
      row.querySelector(".fa-row-name").textContent = entry.name;
      if (!isDir) {
        entry.getFile().then((f) => {
          row.querySelector(".fa-row-meta").textContent = fs.fmtSize(f.size);
        }).catch(() => {});
      }
      row.addEventListener("click", () => {
        for (const r of this.listEl.querySelectorAll(".fa-row")) {
          r.classList.remove("sel");
        }
        row.classList.add("sel");
        this.selected = entry;
        this.listEl.focus({ preventScroll: true });
      });
      row.addEventListener("dblclick", () => this.openEntry(entry));
      this.listEl.appendChild(row);
    }
    if (!entries.length) {
      const hint = document.createElement("div");
      hint.className = "fa-empty fa-hint";
      hint.textContent = "Empty folder — drop files here to import them.";
      this.listEl.appendChild(hint);
    }
    this.statusEl.textContent = `${dirs} folder${dirs === 1 ? "" : "s"} · ${files} file${files === 1 ? "" : "s"}`;
  }

  async openEntry(entry) {
    if (entry.kind === "directory") {
      this.stack.push({ handle: entry, name: entry.name });
      this.render();
      return;
    }
    const kind = fs.kindOf(entry.name);
    if (kind === "image") {
      this.env.openImage(entry.name, await fs.readFileBlob(entry));
    } else if (kind === "text") {
      const path = this.stack.slice(1).map((s) => s.name).concat(entry.name).join("/");
      this.env.openInEditor(entry, path, this.cwd());
    } else {
      this.env.notify(`"${entry.name}" has no viewer — use Download.`);
    }
  }

  async newEntry(isDir) {
    const dir = this.cwd();
    if (!dir) return this.env.notify("Open a folder first.");
    const name = prompt(isDir ? "New folder name:" : "New file name:");
    if (!name) return;
    try {
      if (isDir) await fs.createDir(dir, name);
      else await fs.createFile(dir, name);
      this.render();
    } catch (e) {
      this.env.notify(`Could not create ${name}: ${e.message || e}`);
    }
  }

  async renameSelected() {
    const entry = this.selected;
    const dir = this.cwd();
    if (!entry || !dir) return this.env.notify("Select something to rename.");
    const name = prompt("Rename to:", entry.name);
    if (!name || name === entry.name) return;
    const err = await fs.renameEntry(dir, entry, name);
    if (err) this.env.notify(err);
    this.render();
  }

  async deleteSelected() {
    const entry = this.selected;
    const dir = this.cwd();
    if (!entry || !dir) return this.env.notify("Select something to delete.");
    const label = entry.kind === "directory" ? `folder "${entry.name}" and everything in it` : `"${entry.name}"`;
    if (!confirm(`Delete ${label}? This cannot be undone.`)) return;
    try {
      await fs.removeEntry(dir, entry.name, entry.kind === "directory");
      this.render();
    } catch (e) {
      this.env.notify(`Delete failed: ${e.message || e}`);
    }
  }

  async downloadSelected() {
    const entry = this.selected;
    if (!entry || entry.kind !== "file") {
      return this.env.notify("Select a file to download.");
    }
    const blob = await fs.readFileBlob(entry);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = entry.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
}
