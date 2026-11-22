// SciLog viewer in the browser: the offline copies panel.
//
// A button in the bar ("📴 Offline") opens a list of the logbooks this token reads, each
// with a checkbox: the checked ones are kept in this browser (or in a folder of the user's
// choice) to be read later without a network and without a token; unchecking one removes
// its copy. Before a large copy is made the panel says how large it would be and asks:
// keep it in the browser anyway, choose a folder for it, keep it without images and
// attachments, or not at all. The copies themselves are made by browser.js
// (ScilogBrowser.offline); with a token and a network they are brought up to date by
// themselves when older than a few hours.
"use strict";

(() => {
  const O = window.ScilogBrowser && window.ScilogBrowser.offline;
  if (!O || !O.supported) return;
  const mb = O.mb;
  const when = (iso) => new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

  const css = document.createElement("style");
  css.textContent = `
#offline-dialog { width: min(700px, 96vw); max-height: 92vh; padding: 0; border: 1px solid var(--line); border-radius: 10px;
  background: var(--bg); color: var(--fg); display: flex; flex-direction: column; }
#offline-dialog:not([open]) { display: none; }
#offline-dialog::backdrop { background: rgba(0, 0, 0, .35); }
#offline-dialog .of-body { padding: 10px 16px; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; }
#offline-dialog .of-body > p { margin: 0; }
#offline-dialog .of-muted { color: var(--muted); font-size: .88em; }
#offline-dialog .of-bad { color: #c62828; }
#offline-dialog fieldset { border: 1px solid var(--line); border-radius: 8px; margin: 0; padding: 6px 10px; display: flex; flex-direction: column; gap: 4px; }
#offline-dialog legend { font-size: .85em; color: var(--muted); padding: 0 4px; }
#offline-dialog .of-tools { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
#offline-dialog .of-tools input[type=search] { flex: 1 1 180px; min-width: 0; padding: 4px 8px; border: 1px solid var(--line); border-radius: 6px;
  background: var(--bg); color: var(--fg); font: inherit; }
#offline-dialog ul { list-style: none; margin: 0; padding: 0; border: 1px solid var(--line); border-radius: 8px; max-height: 42vh; overflow-y: auto; }
#offline-dialog li { border-top: 1px solid var(--line); }
#offline-dialog li:first-child { border-top: 0; }
#offline-dialog li label { display: flex; gap: 8px; align-items: baseline; padding: 6px 10px; cursor: pointer; }
#offline-dialog li label:hover { background: var(--panel); }
#offline-dialog li .of-name { font-weight: 600; overflow-wrap: anywhere; }
#offline-dialog li .of-kept { margin-left: auto; text-align: right; white-space: nowrap; font-size: .82em; color: var(--muted); }
#offline-dialog li .of-kept.yes { color: var(--accent); }
#offline-dialog .of-foot { display: flex; gap: 8px; align-items: center; padding: 10px 16px; border-top: 1px solid var(--line); flex-wrap: wrap; }
#offline-dialog .of-status { flex: 1 1 100%; font-size: .88em; color: var(--muted); min-width: 0; }
#offline-dialog .of-status:empty { display: none; }
#offline-dialog .of-foot > button:first-of-type { margin-left: auto; }
#offline-dialog .of-ask { border: 1px solid var(--accent); border-radius: 8px; padding: 10px; display: flex; flex-direction: column; gap: 8px; }
#offline-dialog .of-ask .of-tools button { text-align: left; }
#offline-button { flex: 0 0 auto; white-space: nowrap; }
#offline-button.active { border-color: var(--accent); color: var(--accent); }
@media (max-width: 1500px) { #offline-button .lbl { display: none; } }

`;
  document.head.append(css);

  const button = el("button", { id: "offline-button", title: "Offline copies: logbooks kept in this browser, to read without a network or a token" },
    "📴", el("span", { class: "lbl" }, " Offline"));
  button.addEventListener("click", () => openOffline());
  const badge = document.getElementById("token-badge");
  badge.parentNode.insertBefore(button, badge);

  let busy = false;

  async function openOffline() {
    document.getElementById("offline-dialog")?.remove();
    const dialog = el("dialog", { id: "offline-dialog", "aria-label": "Offline copies" });
    const body = el("div", { class: "of-body" }, el("p", { class: "of-muted" }, el("span", { class: "spinner", "aria-hidden": "true" }), " Reading …"));
    const status = el("div", { class: "of-status", role: "status" });
    const save = el("button", { class: "primary", disabled: "" }, "Keep the checked ones");
    dialog.append(
      el("div", { class: "ed-head" }, el("strong", { text: "Offline copies" }), el("span", { class: "spacer" }),
        el("button", { title: "Close", onclick: () => { if (!busy) dialog.close(); } }, "✕")),
      body,
      el("div", { class: "of-foot" }, status, el("button", { onclick: () => { if (!busy) dialog.close(); } }, "Close"), save));
    dialog.addEventListener("cancel", (e) => { if (busy) e.preventDefault(); });
    dialog.addEventListener("close", () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
    try { await fill(dialog, body, status, save); } catch (e) { body.replaceChildren(el("p", { class: "of-bad", text: `The offline copies could not be read: ${e.message}` })); }
  }

  async function fill(dialog, body, status, save) {
    const st = await O.state();
    const [kept, storage, folder, keepUpdated] = await Promise.all([O.summary(), O.storage(), O.folderState(), O.setting("keepUpdated", true)]);
    const keptBy = Object.fromEntries(kept.map((k) => [k.id, k]));
    let books = [];
    try { books = await O.logbooks(); } catch (e) { /* offline: only the kept ones */ }
    for (const k of kept) if (!books.some((b) => b.id === k.id)) books.push({ id: k.id, name: k.name, pgroup: k.pgroup, location: k.location });
    const canMake = st.token && !st.offline && !st.unreachable;

    const rows = books.map((b) => {
      const box = el("input", { type: "checkbox", ...(keptBy[b.id] ? { checked: "" } : {}), ...(canMake || keptBy[b.id] ? {} : { disabled: "" }) });
      const k = keptBy[b.id];
      const info = k ? `kept ${when(k.saved)} · ${k.posts} posts${k.withFiles ? ` · ${k.files} files` : " · text only"} · ${mb(k.bytes)}${k.where === "folder" ? " · in the folder" : ""}` : "—";
      const li = el("li", {}, el("label", {}, box,
        el("span", {}, el("span", { class: "of-name", text: b.name || b.id }), " ",
          el("span", { class: "of-muted", text: [b.pgroup, b.location].filter(Boolean).join(" · ") })),
        el("span", { class: `of-kept${k ? " yes" : ""}`, text: info })));
      box.addEventListener("change", update);
      return { book: b, box, li };
    });

    const where = { browser: el("input", { type: "radio", name: "of-where", value: "browser" }),
      folder: el("input", { type: "radio", name: "of-where", value: "folder", ...(folder.supported ? {} : { disabled: "" }) }) };
    const defaultWhere = await O.setting("where", "browser");
    (where[defaultWhere === "folder" && folder.name ? "folder" : "browser"]).checked = true;
    const folderLabel = el("span", { text: folder.name ? `In the folder “${folder.name}”` : "In a folder of your choice" });
    const folderTools = el("span", { class: "of-tools" });
    const renderFolder = (f) => {
      folderLabel.textContent = f.name ? `In the folder “${f.name}”` : "In a folder of your choice";
      folderTools.replaceChildren(...[
        f.supported ? el("button", { onclick: async () => {
          try { const nf = await O.chooseFolder(); renderFolder(nf); where.folder.checked = true; O.set("where", "folder"); }
          catch (e) { if (e.name !== "AbortError") status.textContent = `No folder: ${e.message}`; }
        } }, f.name ? "Another folder …" : "Choose …") : el("span", { class: "of-muted", text: "(only Chrome and Edge on a computer can keep files in a folder)" }),
        f.name && f.permission !== "granted" ? el("button", { class: "primary", onclick: async () => {
          try { if (await O.allowFolder()) renderFolder(await O.folderState()); } catch (e) { status.textContent = e.message; }
        } }, "Allow access again") : null].filter(Boolean));
    };
    renderFolder(folder);
    for (const r of Object.values(where)) r.addEventListener("change", () => O.set("where", r.value));

    const withFiles = el("input", { type: "checkbox", checked: "" });
    const updated = el("input", { type: "checkbox", ...(keepUpdated ? { checked: "" } : {}) });
    updated.addEventListener("change", () => O.set("keepUpdated", updated.checked));
    const filter = el("input", { type: "search", placeholder: "Filter by name, pgroup or location", autocomplete: "off" });
    filter.addEventListener("input", () => {
      const q = filter.value.trim().toLowerCase();
      for (const r of rows) r.li.hidden = !!q && ![r.book.name, r.book.pgroup, r.book.location].join(" ").toLowerCase().includes(q);
    });
    const setVisible = (on) => { for (const r of rows) if (!r.li.hidden && !r.box.disabled) r.box.checked = on; update(); };

    const free = storage.quota != null ? storage.quota - (storage.usage || 0) : null;
    body.replaceChildren(...[
      el("p", { text: "Keep logbooks to read them later without a network and without a token: posts, comments and tasks, "
        + "and if you like their images and attachments. Check the ones to keep; uncheck one to remove its copy." }),
      el("p", { class: "of-muted", text: "Anyone using this browser can read the copies, without a token. On a computer others use, keep none, or remove them afterwards." }),
      st.offline || st.unreachable ? el("p", { class: "of-bad", text: st.offline
        ? "Reading offline now (no SciLog token): copies can be removed here, and made or brought up to date with a token and a network."
        : "SciLog cannot be reached now: copies can be removed here, and made or brought up to date once it can." }) : null,
      O.viaSite ? el("fieldset", {}, el("legend", { text: "Where" }),
        el("p", { class: "of-muted" }, "Kept by the offline viewer at ", el("a", { href: O.site, target: "_blank", rel: "noopener", text: O.site }),
          ", in this browser: open it there later — without a network and without logging in. (Or click the 🔖 bookmark anywhere but on a logged-in SciLog.) "
          + "Keeping them opens that page in a window for a moment.")) :
      el("fieldset", {}, el("legend", { text: "Where" }),
        el("label", {}, where.browser, ` In this browser${storage.usage != null ? ` — ${mb(storage.usage)} used, ${free != null ? `${mb(free)} free` : ""}` : ""}${storage.persisted ? " (kept: the browser does not clear it by itself)" : ""}`),
        el("label", {}, where.folder, " ", folderLabel, " ", folderTools)),
      el("fieldset", {}, el("legend", { text: "What" }),
        el("label", {}, withFiles, " With images and attachments (interactive plots included)"),
        O.viaSite ? el("span", { class: "of-muted", text: "To bring them up to date, keep them again here (checked ones are updated)." })
          : el("label", {}, updated, " Bring the copies up to date by themselves when online with a token (every few hours)")),
      el("div", { class: "of-tools" }, filter,
        el("button", { onclick: () => setVisible(true), ...(canMake ? {} : { disabled: "" }) }, "All"),
        el("button", { onclick: () => setVisible(false) }, "None")),
      rows.length ? el("ul", {}, ...rows.map((r) => r.li)) : el("p", { class: "of-muted", text: "No logbooks to keep." })].filter(Boolean));

    function update() {
      const keep = rows.filter((r) => r.box.checked), drop = rows.filter((r) => !r.box.checked && keptBy[r.book.id]);
      const parts = [];
      if (keep.length && canMake) parts.push(`Keep ${keep.length === rows.length && rows.length > 1 ? "all " : ""}${keep.length}`);
      if (drop.length) parts.push(`remove ${drop.length}`);
      save.textContent = parts.length ? parts.join(", ").replace(/^./, (c) => c.toUpperCase()) : "Keep the checked ones";
      save.disabled = busy || !parts.length;
      status.textContent = canMake ? (keep.some((r) => keptBy[r.book.id]) ? "Kept ones that stay checked are brought up to date." : "") : "";
    }
    update();

    save.onclick = async () => {
      const keep = rows.filter((r) => r.box.checked).map((r) => r.book);
      const drop = rows.filter((r) => !r.box.checked && keptBy[r.book.id]).map((r) => r.book);
      if (drop.length && !confirm(`Remove the offline ${drop.length === 1 ? "copy" : "copies"} of ${drop.map((b) => b.name).join(", ")}?`)) return;
      const progress = (text) => { status.textContent = text; };
      if (O.viaSite) {  // the site's window: opened in the click, or the browser blocks it
        try { O.openSite(); } catch (e) { progress(e.message); status.classList.add("of-bad"); return; }
        progress("Opening the offline viewer's window …");
      }
      busy = true; save.disabled = true;
      try {
        for (const b of drop) { progress(`Removing ${b.name} …`); await O.remove(b.id); }
        if (keep.length && canMake) {
          let place = !O.viaSite && where.folder.checked ? "folder" : "browser";
          let plan = await O.plan(keep, withFiles.checked, progress);
          const why = O.tooLarge(plan, place);
          if (why) {
            progress("");
            const room = plan.storage?.quota != null ? plan.storage.quota - (plan.storage.usage || 0) : free;
            const choice = await ask(body, plan, why, place, room);
            if (choice === "cancel") { progress("Nothing kept."); return; }
            if (choice === "text") plan = await O.plan(keep, false, progress);
            if (choice === "folder") {
              const f = await O.folderState();
              if (!f.name || f.permission !== "granted") {
                const nf = f.name ? ((await O.allowFolder()) ? await O.folderState() : f) : await O.chooseFolder();
                renderFolder(nf);
                if (nf.permission !== "granted") { progress("The folder was not allowed: nothing kept."); return; }
              }
              place = "folder";
              O.set("where", "folder");
            }
          }
          if (place === "folder" && (await O.folderState()).permission !== "granted") {
            if (!(await O.allowFolder())) { progress("The folder was not allowed: nothing kept."); return; }
          }
          const done = await O.save(plan, place, progress);
          toast(`Kept offline: ${done.length} ${done.length === 1 ? "logbook" : "logbooks"}`);
        } else toast("Removed");
        busy = false;
        await fill(dialog, body, status, save);
      } catch (e) {
        progress(`Stopped: ${e.message}`);
        status.classList.add("of-bad");
      } finally { busy = false; update(); }
    };
  }

  /** A large copy: say how large, and let the user choose. Resolves "browser", "folder", "text" or "cancel". */
  function ask(body, plan, why, place, free) {
    return new Promise((resolve) => {
      const fits = free == null || plan.estimate < free * 0.9;
      const done = (choice) => { box.remove(); resolve(choice); };
      const box = el("div", { class: "of-ask" },
        el("p", {}, el("strong", { text: `These copies would be large: ${why}.` }),
          ` ${plan.books.length} ${plan.books.length === 1 ? "logbook" : "logbooks"}, ${plan.missing} files to fetch (their size estimated from a few). Is that really intended?`),
        el("div", { class: "of-tools" },
          place !== "folder" ? el("button", { ...(fits ? {} : { disabled: "", title: "The browser has not that much space left" }), onclick: () => done("browser") }, "Yes, keep them in this browser")
            : el("button", { onclick: () => done("folder") }, "Yes, keep them in the folder"),
          O.folderSupported && place !== "folder" ? el("button", { onclick: () => done("folder") }, "Keep them in a folder of my choice …") : null,
          plan.withFiles ? el("button", { onclick: () => done("text") }, "Only the text (no images or attachments)") : null,
          el("button", { onclick: () => done("cancel") }, "Cancel")));
      body.prepend(box);
      box.scrollIntoView({ block: "nearest" });
    });
  }

  // after the page has started: say so when the folder needs allowing again; bring old copies up to date
  window.addEventListener("load", () => setTimeout(async () => {
    try {
      const st = await O.state();
      button.classList.toggle("active", st.offline || st.unreachable);
      const kept = await O.summary();
      if (kept.some((k) => k.where === "folder") && (await O.folderState()).permission !== "granted") {
        toast("The offline copies' folder needs your permission again: 📴 Offline → Allow access again");
      }
      if (!st.offline && !st.unreachable && st.token && kept.length) {
        const done = await O.refreshDue(() => {});
        if (done.length) toast(`Offline ${done.length === 1 ? "copy" : "copies"} brought up to date`);
      }
    } catch (e) { console.warn("offline copies:", e); }
  }, 4000));
})();
