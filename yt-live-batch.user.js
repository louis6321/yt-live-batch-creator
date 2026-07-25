// ==UserScript==
// @name         YouTube Live Batch Creator
// @namespace    local.youtube.live.batch.creator
// @version      1.0.0
// @description  Batch-create YouTube Studio live events and apply common live settings.
// @author       louis.au
// @match        https://studio.youtube.com/*
// @run-at       document-end
// @downloadURL  https://github.com/louis6321/yt-live-batch-creator/raw/refs/heads/main/yt-live-batch.user.js
// @updateURL    https://github.com/louis6321/yt-live-batch-creator/raw/refs/heads/main/yt-live-batch.user.js
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// ==/UserScript==

(function () {
  "use strict";

  const APP_ID = "yt-live-batch-creator";
  const LAUNCHER_ID = `${APP_ID}-launcher`;
  const STORAGE_KEY = "yt-live-batch-settings-v1";
  const DEFAULT_SETTINGS = {
    visibility: "unlisted",
    startTime: "now",
    streamKeyLabelsText: "",
    madeForKids: false,
    disableChat: true,
    assetTitleMode: "mirror-title",
    latency: "normal",
    autoStart: false,
  };

  // Studio already defaults new streams to normal latency, so that option is a no-op
  // the batch can skip entirely.
  const DEFAULT_LATENCY = "normal";
  // textOf() concatenates innerText and textContent, so a leaf label reads as
  // "Low latency Low latency". Anchor on the start and a word boundary, never on $.
  // "Low" stays distinct from "Ultra low" because both patterns are ^-anchored.
  const LATENCY_OPTIONS = [
    { value: "normal", label: "Normal", pattern: /^Normal(?:\s+latency)?\b/i },
    { value: "low", label: "Low", pattern: /^Low(?:\s+latency)?\b/i },
    { value: "ultra-low", label: "Ultra-low", pattern: /^Ultra[\s-]*low(?:\s+latency)?\b/i },
  ];

  // "Auto-stop" deliberately does not match this.
  const AUTO_START_PATTERN = /^(?:Enable\s+)?Auto[\s-]*start\b/i;

  const WAIT = {
    short: 2500,
    normal: 12000,
    step: 30000,
    create: 70000,
    poll: 250,
  };
  const STREAM_KEY_PAGE_SETTLE_MS = 4000;
  const STREAM_KEY_CONFIRM_SETTLE_MS = 4000;
  const STREAM_KEY_SAVE_SETTLE_MS = 5500;
  const LATENCY_SETTLE_MS = 3000;

  const state = {
    running: false,
    stopRequested: false,
    logLines: [],
    createdEvents: [],
  };

  let ui = {};
  let stylesAdded = false;
  let launcherTimer = null;
  let launcherObserver = null;
  let launcherRetryUntil = 0;
  let startTimeEdited = false;

  initWhenReady();

  if (typeof GM_registerMenuCommand === "function") {
    GM_registerMenuCommand("Show Live Batch Creator", () => {
      initWhenReady(true);
      showPanel();
    });
  }

  window.addEventListener("yt-navigate-finish", () => initWhenReady(), true);
  window.addEventListener("popstate", () => initWhenReady(), true);

  function initWhenReady(force) {
    if (!document.documentElement) {
      window.setTimeout(() => initWhenReady(force), 250);
      return;
    }

    if (!stylesAdded) addStyles();

    if (!document.getElementById(APP_ID)) {
      buildPanel();
      hidePanel();
      loadPanelSettings();
      exposeDebugHandle();
      log("Ready. Open the panel with the Batch Create button beside Schedule Stream.");
    }

    startLauncherObserver();
    launcherRetryUntil = Date.now() + 30000;
    ensureLauncherSoon();

    if (force) showPanel();
  }

  function addStyles() {
    const css = `
      #${APP_ID} {
        position: fixed;
        right: 10px;
        bottom: 10px;
        z-index: 2147483647;
        display: flex;
        flex-direction: column;
        width: min(340px, calc(100vw - 20px));
        max-height: min(560px, calc(100vh - 20px));
        color: #f8fafc;
        background: #18181b;
        border: 1px solid #3f3f46;
        border-radius: 6px;
        box-shadow: 0 10px 28px rgba(0, 0, 0, 0.4);
        font: 11px/1.35 Arial, sans-serif;
      }
      #${APP_ID} * { box-sizing: border-box; }
      #${APP_ID}.ylbc-collapsed {
        width: min(250px, calc(100vw - 20px));
        max-height: none;
      }
      #${APP_ID} .ylbc-header {
        display: flex;
        align-items: center;
        gap: 4px;
        padding: 4px 4px 4px 8px;
        background: #27272a;
        border-bottom: 1px solid #3f3f46;
        border-radius: 5px 5px 0 0;
      }
      #${APP_ID}.ylbc-collapsed .ylbc-header {
        border-bottom: none;
        border-radius: 5px;
      }
      #${APP_ID} .ylbc-title,
      #${APP_ID} .ylbc-mini-status {
        flex: 1 1 auto;
        min-width: 0;
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
      }
      #${APP_ID} .ylbc-title {
        font-size: 11px;
        font-weight: 700;
      }
      #${APP_ID} .ylbc-mini-status {
        display: none;
        color: #d4d4d8;
      }
      #${APP_ID}.ylbc-collapsed .ylbc-title { display: none; }
      #${APP_ID}.ylbc-collapsed .ylbc-mini-status { display: block; }
      #${APP_ID} .ylbc-header button {
        flex: 0 0 auto;
        min-height: 20px;
        padding: 2px 6px;
      }
      #${APP_ID} .ylbc-mini-stop { display: none; }
      #${APP_ID}.ylbc-collapsed.ylbc-running .ylbc-mini-stop { display: block; }
      #${APP_ID} .ylbc-body {
        flex: 1 1 auto;
        min-height: 0;
        display: grid;
        gap: 6px;
        padding: 8px;
        overflow: auto;
      }
      #${APP_ID}.ylbc-collapsed .ylbc-body { display: none; }
      #${APP_ID} label {
        display: grid;
        gap: 3px;
        color: #e4e4e7;
      }
      #${APP_ID} input,
      #${APP_ID} select,
      #${APP_ID} textarea {
        width: 100%;
        min-height: 24px;
        color: #f8fafc;
        background: #09090b;
        border: 1px solid #52525b;
        border-radius: 3px;
        padding: 3px 6px;
        font: 11px/1.3 Arial, sans-serif;
      }
      #${APP_ID} textarea {
        min-height: 64px;
        resize: vertical;
      }
      #${APP_ID} .ylbc-label-row {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 6px;
      }
      #${APP_ID} .ylbc-count {
        flex: 0 0 auto;
        color: #a1a1aa;
        font-size: 10px;
        font-variant-numeric: tabular-nums;
      }
      #${APP_ID} .ylbc-count.ylbc-count-mismatch {
        color: #fbbf24;
        font-weight: 700;
      }
      #${APP_ID} .ylbc-lined {
        display: flex;
        align-items: stretch;
        background: #09090b;
        border: 1px solid #52525b;
        border-radius: 3px;
        overflow: hidden;
      }
      #${APP_ID} .ylbc-lined:focus-within { border-color: #14b8a6; }
      #${APP_ID} .ylbc-gutter {
        flex: 0 0 auto;
        min-width: 20px;
        overflow: hidden;
        padding: 3px 4px;
        color: #71717a;
        background: #131316;
        border-right: 1px solid #3f3f46;
        font: 11px/1.3 Arial, sans-serif;
        font-variant-numeric: tabular-nums;
        text-align: right;
        white-space: pre;
        user-select: none;
        -webkit-user-select: none;
      }
      #${APP_ID} .ylbc-lined textarea {
        flex: 1 1 auto;
        min-width: 0;
        border: none;
        border-radius: 0;
      }
      #${APP_ID} .ylbc-lined textarea:focus { outline: none; }
      #${APP_ID} .ylbc-event-grid {
        display: grid;
        gap: 6px;
      }
      #${APP_ID} .ylbc-row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
        gap: 6px;
      }
      #${APP_ID} .ylbc-check {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      #${APP_ID} .ylbc-check input {
        width: auto;
        min-height: 0;
      }
      #${APP_ID} .ylbc-actions {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 4px;
      }
      #${APP_ID} button {
        min-height: 24px;
        color: #f8fafc;
        background: #3f3f46;
        border: 1px solid #52525b;
        border-radius: 3px;
        padding: 3px 6px;
        font: 700 11px/1 Arial, sans-serif;
        cursor: pointer;
      }
      #${APP_ID} button:hover { background: #52525b; }
      #${APP_ID} button:disabled {
        cursor: not-allowed;
        opacity: 0.55;
      }
      #${APP_ID} .ylbc-start { background: #0f766e; border-color: #14b8a6; }
      #${APP_ID} .ylbc-stop { background: #991b1b; border-color: #ef4444; }
      #${APP_ID} .ylbc-status {
        min-height: 20px;
        color: #d4d4d8;
        background: #09090b;
        border: 1px solid #3f3f46;
        border-radius: 3px;
        padding: 4px 6px;
      }
      #${APP_ID} .ylbc-log {
        min-height: 60px;
        max-height: 22vh;
        overflow: auto;
        white-space: pre-wrap;
        word-break: break-word;
        color: #d4d4d8;
        background: #09090b;
        border: 1px solid #3f3f46;
        border-radius: 3px;
        padding: 5px 6px;
        font-size: 10px;
      }
      @media (max-height: 720px) {
        #${APP_ID} textarea { min-height: 50px; }
        #${APP_ID} .ylbc-log { min-height: 44px; max-height: 18vh; }
      }
      @media (max-height: 560px) {
        #${APP_ID} textarea { min-height: 40px; }
        #${APP_ID} .ylbc-log { min-height: 36px; max-height: 15vh; }
      }
      @media (max-width: 380px) {
        #${APP_ID} .ylbc-row { grid-template-columns: minmax(0, 1fr); }
        #${APP_ID} .ylbc-actions { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      }
      #${LAUNCHER_ID} {
        margin-left: 8px;
        min-height: 36px;
        color: #fff;
        background: #0f766e;
        border: 1px solid #14b8a6;
        border-radius: 4px;
        padding: 0 14px;
        font: 700 13px/1 Arial, sans-serif;
        cursor: pointer;
        white-space: nowrap;
      }
      #${LAUNCHER_ID}:hover {
        background: #115e59;
      }
    `;

    if (typeof GM_addStyle === "function") {
      GM_addStyle(css);
      stylesAdded = true;
      return;
    }

    const style = document.createElement("style");
    style.textContent = css;
    document.documentElement.appendChild(style);
    stylesAdded = true;
  }

  function buildPanel() {
    const panel = document.createElement("section");
    panel.id = APP_ID;

    const header = node("div", { className: "ylbc-header" }, [
      node("div", { className: "ylbc-title", text: "Live Batch Creator" }),
      node("div", { className: "ylbc-mini-status", "data-ylbc": "miniStatus", text: "Idle" }),
      node("button", {
        className: "ylbc-stop ylbc-mini-stop",
        type: "button",
        "data-ylbc": "miniStop",
        disabled: true,
        title: "Stop the batch",
        text: "Stop",
      }),
      node("button", {
        type: "button",
        "data-ylbc": "collapse",
        title: "Minimise panel",
        "aria-label": "Minimise panel",
        text: "-",
      }),
      node("button", { type: "button", "data-ylbc": "toggle", title: "Close panel", text: "Close" }),
    ]);

    const titles = node("textarea", {
      "data-ylbc": "titles",
      spellcheck: "false",
      wrap: "off",
      placeholder: "One stream title per line",
    });

    const streamKeyLabels = node("textarea", {
      "data-ylbc": "streamKeyLabels",
      spellcheck: "false",
      wrap: "off",
      placeholder: "One stream key label per line",
    });

    const visibility = node("select", { "data-ylbc": "visibility" }, [
      node("option", { value: "private", text: "Private" }),
      node("option", { value: "unlisted", text: "Unlisted" }),
      node("option", { value: "public", text: "Public" }),
    ]);

    const latency = node(
      "select",
      { "data-ylbc": "latency" },
      LATENCY_OPTIONS.map((option) => node("option", { value: option.value, text: option.label }))
    );

    const startTime = node("input", {
      "data-ylbc": "startTime",
      type: "datetime-local",
    });

    const disableChat = node("input", {
      "data-ylbc": "disableChat",
      type: "checkbox",
    });

    const autoStart = node("input", {
      "data-ylbc": "autoStart",
      type: "checkbox",
    });

    const body = node("div", { className: "ylbc-body" }, [
      node("div", { className: "ylbc-event-grid" }, [
        node("label", {}, [
          labelRow("Titles", "titleCount"),
          linedTextarea(titles, "titlesGutter"),
        ]),
        node("label", {}, [
          labelRow("Stream keys", "streamKeyCount"),
          linedTextarea(streamKeyLabels, "streamKeyLabelsGutter"),
        ]),
      ]),
      node("div", { className: "ylbc-row" }, [
        node("label", {}, ["Visibility", visibility]),
        node("label", {}, ["Latency", latency]),
      ]),
      node("label", {}, ["Start time", startTime]),
      node("label", { className: "ylbc-check" }, [disableChat, "Disable visible live chat features"]),
      node("label", { className: "ylbc-check" }, [autoStart, "Enable auto-start"]),
      node("div", { className: "ylbc-actions" }, [
        node("button", { className: "ylbc-start", type: "button", "data-ylbc": "start", text: "Start" }),
        node("button", { className: "ylbc-stop", type: "button", "data-ylbc": "stop", disabled: true, text: "Stop" }),
        node("button", { type: "button", "data-ylbc": "save", text: "Save" }),
        node("button", { type: "button", "data-ylbc": "clearLog", text: "Clear" }),
      ]),
      node("div", { className: "ylbc-status", "data-ylbc": "status", text: "Idle" }),
      node("div", { className: "ylbc-log", "data-ylbc": "log", role: "log", "aria-live": "polite" }),
    ]);

    panel.appendChild(header);
    panel.appendChild(body);

    document.documentElement.appendChild(panel);

    ui = {
      panel,
      titles: panel.querySelector('[data-ylbc="titles"]'),
      streamKeyLabels: panel.querySelector('[data-ylbc="streamKeyLabels"]'),
      visibility: panel.querySelector('[data-ylbc="visibility"]'),
      latency: panel.querySelector('[data-ylbc="latency"]'),
      startTime: panel.querySelector('[data-ylbc="startTime"]'),
      disableChat: panel.querySelector('[data-ylbc="disableChat"]'),
      autoStart: panel.querySelector('[data-ylbc="autoStart"]'),
      start: panel.querySelector('[data-ylbc="start"]'),
      stop: panel.querySelector('[data-ylbc="stop"]'),
      save: panel.querySelector('[data-ylbc="save"]'),
      clearLog: panel.querySelector('[data-ylbc="clearLog"]'),
      status: panel.querySelector('[data-ylbc="status"]'),
      log: panel.querySelector('[data-ylbc="log"]'),
      toggle: panel.querySelector('[data-ylbc="toggle"]'),
      collapse: panel.querySelector('[data-ylbc="collapse"]'),
      miniStatus: panel.querySelector('[data-ylbc="miniStatus"]'),
      miniStop: panel.querySelector('[data-ylbc="miniStop"]'),
      titlesGutter: panel.querySelector('[data-ylbc="titlesGutter"]'),
      streamKeyLabelsGutter: panel.querySelector('[data-ylbc="streamKeyLabelsGutter"]'),
      titleCount: panel.querySelector('[data-ylbc="titleCount"]'),
      streamKeyCount: panel.querySelector('[data-ylbc="streamKeyCount"]'),
    };

    ui.start.addEventListener("click", startBatchFromPanel);
    ui.stop.addEventListener("click", requestStop);
    ui.miniStop.addEventListener("click", requestStop);
    ui.titles.addEventListener("input", refreshLineNumbers);
    ui.streamKeyLabels.addEventListener("input", refreshLineNumbers);
    ui.collapse.addEventListener("click", () => {
      setPanelCollapsed(!ui.panel.classList.contains("ylbc-collapsed"));
    });
    ui.startTime.addEventListener("input", () => {
      startTimeEdited = true;
    });
    ui.save.addEventListener("click", () => {
      savePanelSettings();
      log("Saved settings.");
    });
    ui.clearLog.addEventListener("click", () => {
      state.logLines = [];
      renderLog();
      setStatus("Idle");
    });
    ui.toggle.addEventListener("click", () => {
      hidePanel();
    });

    refreshLineNumbers();
  }

  function labelRow(text, countKey) {
    return node("span", { className: "ylbc-label-row" }, [
      node("span", { text }),
      node("span", { className: "ylbc-count", "data-ylbc": countKey, text: "0" }),
    ]);
  }

  // Titles and stream keys pair up by line number, so both boxes carry a gutter that
  // scrolls with the text. `wrap="off"` keeps one visual row per logical line.
  function linedTextarea(control, gutterKey) {
    const gutter = node("div", {
      className: "ylbc-gutter",
      "data-ylbc": gutterKey,
      "aria-hidden": "true",
    });

    control.addEventListener("scroll", () => {
      gutter.scrollTop = control.scrollTop;
    });

    gutter.addEventListener("mousedown", (event) => {
      event.preventDefault();
      control.focus();
    });

    return node("div", { className: "ylbc-lined" }, [gutter, control]);
  }

  function refreshLineNumbers() {
    renderGutter(ui.titlesGutter, ui.titles);
    renderGutter(ui.streamKeyLabelsGutter, ui.streamKeyLabels);

    const titleCount = countContentLines(ui.titles.value);
    const keyCount = countContentLines(ui.streamKeyLabels.value);
    const mismatch = titleCount !== keyCount;

    ui.titleCount.textContent = String(titleCount);
    ui.streamKeyCount.textContent = String(keyCount);
    ui.titleCount.classList.toggle("ylbc-count-mismatch", mismatch);
    ui.streamKeyCount.classList.toggle("ylbc-count-mismatch", mismatch);

    const hint = mismatch
      ? `${titleCount} title line(s) but ${keyCount} stream key line(s)`
      : `${titleCount} paired line(s)`;
    ui.titleCount.title = hint;
    ui.streamKeyCount.title = hint;
  }

  function renderGutter(gutter, control) {
    if (!gutter || !control) return;

    const lines = Math.max(1, splitLines(control.value).length);
    const numbers = [];
    for (let line = 1; line <= lines; line += 1) numbers.push(line);

    gutter.textContent = numbers.join("\n");
    gutter.scrollTop = control.scrollTop;
  }

  function countContentLines(value) {
    const lines = splitLines(value);
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    return lines.length;
  }

  function node(tag, attrs, children) {
    const element = document.createElement(tag);

    for (const [name, value] of Object.entries(attrs || {})) {
      if (value === undefined || value === null || value === false) continue;

      if (name === "className") {
        element.className = value;
      } else if (name === "text") {
        element.textContent = value;
      } else if (name === "disabled") {
        element.disabled = Boolean(value);
      } else if (name === "checked") {
        element.checked = Boolean(value);
      } else {
        element.setAttribute(name, value === true ? "" : String(value));
      }
    }

    for (const child of children || []) {
      if (typeof child === "string") {
        element.appendChild(document.createTextNode(child));
      } else if (child) {
        element.appendChild(child);
      }
    }

    return element;
  }

  function showPanel() {
    const panel = document.getElementById(APP_ID);
    if (!panel) return;
    if (!startTimeEdited && ui.startTime) {
      ui.startTime.value = formatDateTimeLocal(new Date());
    }
    panel.style.display = "flex";
    setPanelCollapsed(state.running);
    applyPanelPlacement();
  }

  function hidePanel() {
    const panel = document.getElementById(APP_ID);
    if (!panel) return;
    panel.style.display = "none";
  }

  function setPanelCollapsed(collapsed) {
    const panel = ui.panel;
    if (!panel) return;

    panel.classList.toggle("ylbc-collapsed", Boolean(collapsed));

    if (ui.collapse) {
      ui.collapse.textContent = collapsed ? "+" : "-";
      const label = collapsed ? "Expand panel" : "Minimise panel";
      ui.collapse.title = label;
      ui.collapse.setAttribute("aria-label", label);
    }

    applyPanelPlacement();
  }

  // While a batch runs the panel parks in the opposite bottom corner, because the
  // Studio wizard keeps Next/Done in its own bottom-right corner.
  function setPanelParked(parked) {
    if (!ui.panel) return;
    ui.panel.classList.toggle("ylbc-parked", Boolean(parked));
    applyPanelPlacement();
  }

  function applyPanelPlacement() {
    const panel = ui.panel;
    if (!panel) return;

    const parked = panel.classList.contains("ylbc-parked");
    panel.style.position = "fixed";
    panel.style.top = "auto";
    panel.style.bottom = "10px";
    panel.style.left = parked ? "10px" : "auto";
    panel.style.right = parked ? "auto" : "10px";
    panel.style.zIndex = "2147483647";
  }

  function startLauncherObserver() {
    if (launcherObserver) return;

    if (!document.body) {
      window.setTimeout(startLauncherObserver, 250);
      return;
    }

    launcherObserver = new MutationObserver(() => ensureLauncherSoon(600));
    launcherObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  function ensureLauncherSoon(delay = 150) {
    if (launcherTimer) window.clearTimeout(launcherTimer);
    launcherTimer = window.setTimeout(() => {
      launcherTimer = null;
      ensureLauncher();
    }, delay);
  }

  function ensureLauncher() {
    const scheduleButton = findScheduleStreamButton();
    if (!scheduleButton || !scheduleButton.parentNode) {
      ensureFallbackLauncher();
      if (Date.now() < launcherRetryUntil) {
        ensureLauncherSoon(1200);
        return true;
      }
      return true;
    }

    const insertionTarget = getLightDomInsertionTarget(scheduleButton);
    if (!insertionTarget || !insertionTarget.parentNode) return ensureFallbackLauncher();

    const launcher = getOrCreateLauncher();
    styleLauncherButton(launcher, "inline-before");
    insertionTarget.insertAdjacentElement("beforebegin", launcher);
    return true;
  }

  function findLauncherButton() {
    return deepQueryAll(`#${LAUNCHER_ID}`).find((element) => element.isConnected) || null;
  }

  function findScheduleStreamButton() {
    return findClickableByText([/^Schedule\s*stream$/i, /Schedule\s*stream/i, /^New\s*stream$/i, /^Create\s*stream$/i], {
      selector: creationButtonSelector(),
      enabledOnly: false,
    });
  }

  function ensureFallbackLauncher() {
    const launcher = getOrCreateLauncher();
    styleLauncherButton(launcher, "fixed");

    if (!launcher.isConnected) {
      document.documentElement.appendChild(launcher);
    }

    return true;
  }

  function getOrCreateLauncher() {
    const existing = findLauncherButton();
    if (existing) return existing;

    const launcher = node("button", {
      id: LAUNCHER_ID,
      type: "button",
      text: "Batch Create",
      title: "Open Live Batch Creator",
    });

    launcher.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      initWhenReady(true);
      showPanel();
    });

    return launcher;
  }

  function getLightDomInsertionTarget(element) {
    let target = element;

    while (target) {
      const root = target.getRootNode?.();
      if (typeof ShadowRoot === "undefined" || !(root instanceof ShadowRoot)) break;
      target = root.host;
    }

    return target || element;
  }

  function styleLauncherButton(launcher, placement) {
    Object.assign(launcher.style, {
      marginLeft: "0",
      marginRight: "0",
      minHeight: "36px",
      color: "#fff",
      background: "#0f766e",
      border: "1px solid #14b8a6",
      borderRadius: "4px",
      padding: "0 14px",
      font: "700 13px/1 Arial, sans-serif",
      cursor: "pointer",
      whiteSpace: "nowrap",
    });

    if (placement === "inline-before") {
      Object.assign(launcher.style, {
        position: "",
        top: "",
        right: "",
        zIndex: "",
        boxShadow: "",
        marginLeft: "0",
        marginRight: "8px",
      });
    } else if (placement === "fixed") {
      Object.assign(launcher.style, {
        position: "fixed",
        top: "72px",
        right: "16px",
        zIndex: "2147483647",
        boxShadow: "0 8px 24px rgba(0, 0, 0, 0.25)",
        marginLeft: "0",
        marginRight: "0",
      });
    } else {
      Object.assign(launcher.style, {
        position: "",
        top: "",
        right: "",
        zIndex: "",
        boxShadow: "",
        marginLeft: "8px",
        marginRight: "0",
      });
    }
  }

  function loadPanelSettings() {
    const saved = loadSettings();
    ui.visibility.value = saved.visibility || DEFAULT_SETTINGS.visibility;
    ui.latency.value = findLatencyOption(saved.latency) ? saved.latency : DEFAULT_LATENCY;
    ui.startTime.value = formatDateTimeLocal(new Date());
    startTimeEdited = false;
    ui.streamKeyLabels.value = saved.streamKeyLabelsText || saved.streamKeyLabel || "";
    ui.disableChat.checked = saved.disableChat !== false;
    ui.autoStart.checked = saved.autoStart === true;
    refreshLineNumbers();
  }

  function savePanelSettings() {
    saveSettings(readSettingsFromPanel());
  }

  function readSettingsFromPanel() {
    return {
      visibility: ui.visibility.value,
      startTime: ui.startTime.value ? ui.startTime.value : "now",
      streamKeyLabelsText: ui.streamKeyLabels.value,
      madeForKids: false,
      disableChat: ui.disableChat.checked,
      assetTitleMode: "mirror-title",
      latency: ui.latency.value,
      autoStart: ui.autoStart.checked,
    };
  }

  function readConfigFromPanel() {
    const titleLines = splitLines(ui.titles.value);
    const streamKeyLines = splitLines(ui.streamKeyLabels.value);
    const events = [];

    titleLines.forEach((rawTitle, lineIndex) => {
      const title = rawTitle.trim();
      if (!title) return;

      events.push({
        title,
        streamKeyLabel: (streamKeyLines[lineIndex] || "").trim(),
        sourceLine: lineIndex + 1,
      });
    });

    return {
      titles: events.map((event) => event.title),
      events,
      settings: readSettingsFromPanel(),
    };
  }

  function splitLines(value) {
    return String(value || "").split(/\r?\n/);
  }

  async function startBatchFromPanel() {
    if (state.running) return;

    const config = readConfigFromPanel();
    const validation = validateConfig(config);
    if (validation.length) {
      validation.forEach((line) => log(line, "error"));
      setStatus("Fix validation errors");
      return;
    }

    saveSettings(config.settings);
    state.running = true;
    state.stopRequested = false;
    state.createdEvents = [];
    updateRunButtons();
    setPanelParked(true);
    setPanelCollapsed(true);

    try {
      await runBatch(config);
      if (state.stopRequested) {
        setStatus("Stopped");
        log("Batch stopped.");
      } else {
        setStatus("Complete");
        log(`Batch complete. Created ${state.createdEvents.length} event(s).`);
      }
    } catch (error) {
      setStatus("Paused on error");
      log(errorMessage(error), "error");
    } finally {
      state.running = false;
      updateRunButtons();
      setPanelParked(false);
      setPanelCollapsed(false);
    }
  }

  function validateConfig(config) {
    const errors = [];
    if (!config.events.length) errors.push("Add at least one title.");
    config.events.forEach((event, index) => {
      if (event.title.length > 100) {
        errors.push(`Title ${index + 1} is ${event.title.length} characters. YouTube titles must be 100 characters or fewer.`);
      }
      if (!event.streamKeyLabel) {
        errors.push(`Add a stream key on line ${event.sourceLine} for "${event.title}".`);
      }
    });
    if (!["private", "unlisted", "public"].includes(config.settings.visibility)) {
      errors.push("Visibility must be private, unlisted, or public.");
    }
    if (!findLatencyOption(config.settings.latency)) {
      errors.push(`Latency must be one of ${LATENCY_OPTIONS.map((option) => option.label).join(", ")}.`);
    }
    return errors;
  }

  async function runBatch(config) {
    log(`Starting batch with ${config.events.length} event(s).`);

    for (let index = 0; index < config.events.length; index += 1) {
      checkStop();
      const event = config.events[index];
      const title = event.title;
      setStatus(`Creating ${index + 1}/${config.events.length}`);
      log(`Creating ${index + 1}/${config.events.length}: ${title}`);

      const created = await createEvent(title, config.settings);
      state.createdEvents.push(created);
      log(`Created event: ${created.url || "URL not detected"}`);

      setStatus(`Selecting stream key ${index + 1}/${config.events.length}`);
      await selectStreamKeyAfterCreate(created.url, event.streamKeyLabel);
      created.streamKeySelected = true;
      log(`Selected stream key: ${event.streamKeyLabel}`);

      created.latency = config.settings.latency;
      if (config.settings.latency === DEFAULT_LATENCY) {
        log("Latency left on Studio's Normal default.");
      } else {
        setStatus(`Setting latency ${index + 1}/${config.events.length}`);
        created.latencyApplied = await setStreamLatency(config.settings.latency, created.url);
      }

      // Runs after the latency step, which already settles for LATENCY_SETTLE_MS.
      created.autoStart = config.settings.autoStart;
      if (config.settings.autoStart) {
        setStatus(`Enabling auto-start ${index + 1}/${config.events.length}`);
        created.autoStartApplied = await setAutoStart(created.url);
      } else {
        log("Auto-start left disabled.");
      }

      if (index < config.events.length - 1) {
        setStatus(`Returning to Manage streams ${index + 1}/${config.events.length}`);
        await returnToLivestreamManagePage();
        log("Returned to Manage streams for the next event.");
      }
    }
  }

  async function createEvent(title, settings) {
    await openCreationWizard();
    await fillDetailsStep(title);
    await clickNext("details", "rights management");
    await fillRightsStep(title);
    await clickNext("rights management", "customization");

    if (settings.disableChat) {
      await fillCustomizationStep();
    } else {
      log("Chat disabling is off for this run.");
    }

    await clickNext("customization", "visibility");
    await fillVisibilityStep(settings);
    const url = await submitCreation(settings);

    return {
      title,
      url,
      streamKeySelected: false,
    };
  }

  async function openCreationWizard() {
    if (findTitleControl()) return;

    log("Opening the live event creation flow.");

    if (await tryClickCreateLiveEntryPoint()) {
      return;
    }

    throw new Error("Could not find the live event creation button. Open YouTube Studio Live Control Room or the Live page, then start again.");
  }

  async function tryClickCreateLiveEntryPoint() {
    const directLabels = [/^Schedule stream$/i, /^Create stream$/i, /^New stream$/i];
    const directButton = findScheduleStreamButton() || findEnabledButton(directLabels);
    if (await clickCreationEntryPoint(directButton, "Schedule Stream")) return true;

    const createButton = findClickableByText([/^Create$/i, /^Create$/i], {
      selector: creationButtonSelector(),
      exact: false,
    });

    if (createButton) {
      clickElement(createButton);
      await sleep(700);
      const goLiveButton = await waitFor(() => findEnabledButton([/^Go live$/i]), {
        timeout: WAIT.short,
        label: "Go live menu item",
      }).catch((error) => {
        if (errorMessage(error) === "Stopped by user.") throw error;
        return null;
      });
      if (await clickCreationEntryPoint(goLiveButton, "Go live")) return true;
    }

    return false;
  }

  async function clickCreationEntryPoint(button, label) {
    if (!button) return false;

    clickElement(button);

    try {
      const initial = await waitFor(() => {
        const titleControl = findTitleControl();
        if (titleControl) return { titleControl };

        const createNew = findCreateNewFromPreviousSettingsDialog();
        return createNew ? { createNew } : null;
      }, {
        timeout: WAIT.step,
        label: "the event title field or previous-settings dialog",
      });

      if (initial.titleControl) return true;

      // Studio paints this dialog before its Polymer click handlers are always
      // ready. Let the enabled, scoped button settle before the first click.
      await sleep(600);

      const titleAfterSettle = findTitleControl();
      if (titleAfterSettle) return true;

      let createNew = findCreateNewFromPreviousSettingsDialog();
      if (!createNew) {
        await waitFor(() => findTitleControl(), {
          timeout: WAIT.step,
          label: "the event title field after the previous-settings dialog closed",
        });
        return true;
      }

      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const clickedDialog = findPreviousSettingsDialog();
        clickElement(createNew);
        log(
          `Clicked Create new in the previous-settings dialog${attempt > 1 ? ` (retry ${attempt})` : ""}.`
        );

        const acknowledged = await waitFor(() => {
          const titleControl = findTitleControl();
          if (titleControl) return { titleControl };

          const currentDialog = findPreviousSettingsDialog();
          const currentButton = findCreateNewFromPreviousSettingsDialog();
          const dialogGone = (
            !clickedDialog ||
            !clickedDialog.isConnected ||
            !isVisibleOutsidePanel(clickedDialog) ||
            currentDialog !== clickedDialog
          );
          const buttonUnavailable = !currentButton || isDisabled(currentButton);

          return dialogGone || buttonUnavailable ? { transitionAccepted: true } : null;
        }, {
          timeout: 5000,
          label: "the Create new click to be acknowledged",
        }).catch((error) => {
          if (errorMessage(error) === "Stopped by user.") throw error;
          return null;
        });

        if (acknowledged?.titleControl) return true;
        if (acknowledged?.transitionAccepted) {
          await waitFor(() => findTitleControl(), {
            timeout: WAIT.step,
            label: "the event title field after choosing Create new",
          });
          return true;
        }

        if (attempt < 2) {
          log("The Create new click was not acknowledged; retrying once.", "warn");
          createNew = await waitFor(() => findCreateNewFromPreviousSettingsDialog(), {
            timeout: WAIT.short,
            label: "the enabled Create new button for retry",
          });
        }
      }

      await waitFor(() => findTitleControl(), {
        timeout: WAIT.step,
        label: "the event title field after choosing Create new",
      });
      return true;
    } catch (error) {
      if (errorMessage(error) === "Stopped by user.") throw error;
      log(`Clicked ${label}, but the title field did not appear. Trying another creation entry point.`, "warn");
      return false;
    }
  }

  async function fillDetailsStep(title) {
    const titleControl = await waitFor(() => findTitleControl(), {
      timeout: WAIT.step,
      label: "the title field",
    });

    await setAndVerifyTextControl(titleControl, title, findTitleControl, "stream title");
    log("Set stream title.");

    await setMadeForKidsNo();
  }

  async function setMadeForKidsNo() {
    const option = await waitFor(() => findMadeForKidsNoOption(), {
      timeout: WAIT.step,
      label: "No, it's not made for kids",
    });

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const currentOption = findMadeForKidsNoOption() || option;
      if (isSelected(currentOption)) {
        log("Set made-for-kids to No.");
        return;
      }

      clickElement(currentOption);
      const nearbyRadio = findOptionInputNear(currentOption);
      if (nearbyRadio && nearbyRadio !== currentOption) {
        clickElement(nearbyRadio);
      }

      await sleep(500);
    }

    if (!isSelected(findMadeForKidsNoOption() || option)) {
      throw new Error("Could not select 'No, it's not made for kids'.");
    }

    log("Set made-for-kids to No.");
  }

  async function setAndVerifyTextControl(control, value, refind, label) {
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const target = attempt === 1 ? control : refind();
      if (!target) break;

      setTextControl(target, value);
      await sleep(500);

      const fresh = refind() || target;
      if (controlHasText(fresh, value)) {
        return fresh;
      }
    }

    throw new Error(`Could not set ${label}.`);
  }

  function findMadeForKidsNoOption() {
    const dialog = findCreateStreamDialog();
    const label = findTextElement(/^No,?\s*it.?s not made for kids$/i, dialog || document);
    if (label) {
      return findOptionInputNear(label) || closestClickable(label) || label;
    }

    return findClickableByText([/^No,?\s*it.?s not made for kids$/i, /not made for kids/i], {
      selector: optionSelector(),
      enabledOnly: false,
    });
  }

  function findOptionInputNear(label, root = findCreateStreamDialog() || document) {
    const selector = [
      '[role="radio"]',
      'ytcp-radio-button',
      'tp-yt-paper-radio-button',
      'paper-radio-button',
      'input[type="radio"]',
    ].join(",");

    const labelRect = label.getBoundingClientRect();
    let container = label;
    for (let depth = 0; depth < 6 && container; depth += 1) {
      const radios = deepQueryAll(selector, container)
        .filter(isVisibleOutsidePanel)
        .map((radio) => ({
          radio,
          distance: distanceBetween(labelRect, radio.getBoundingClientRect()),
          centerDelta: verticalCenterDelta(labelRect, radio.getBoundingClientRect()),
        }))
        .filter((item) => item.centerDelta < 70)
        .sort((a, b) => a.centerDelta - b.centerDelta || a.distance - b.distance);
      if (radios.length) return radios[0].radio;
      container = parentElement(container);
    }

    return deepQueryAll(selector, root)
      .filter(isVisibleOutsidePanel)
      .map((radio) => ({
        radio,
        distance: distanceBetween(labelRect, radio.getBoundingClientRect()),
        centerDelta: verticalCenterDelta(labelRect, radio.getBoundingClientRect()),
      }))
      .filter((item) => item.distance < 180)
      .filter((item) => item.centerDelta < 70)
      .sort((a, b) => a.centerDelta - b.centerDelta || a.distance - b.distance)[0]?.radio || null;
  }

  function controlHasText(control, expected) {
    const actual = normalize(readControlValue(control));
    return actual === normalize(expected) || actual.includes(normalize(expected));
  }

  function readControlValue(control) {
    const element = normalizeControl(control);
    if (!element) return "";

    if (element.tagName === "INPUT" || element.tagName === "TEXTAREA") {
      return element.value;
    }

    const nestedValues = visibleControls(nestedTextEditorSelector(), element)
      .filter((nested) => nested !== element)
      .map(readRawControlValue)
      .filter((value) => normalize(value));

    if (nestedValues.length) return nestedValues.join(" ");

    const rendered = [
      element.innerText,
      element.textContent,
    ].filter(Boolean).join(" ");

    if (normalize(rendered)) return rendered;

    if ("value" in element && typeof element.value !== "undefined") {
      return element.value;
    }

    return "";
  }

  function readRawControlValue(element) {
    if (!element) return "";
    if ("value" in element && typeof element.value !== "undefined") return element.value;
    return [
      element.innerText,
      element.textContent,
    ].filter(Boolean).join(" ");
  }

  async function fillRightsStep(title) {
    const assetTitle = await waitFor(() => findFormControlByLabel(/asset title/i), {
      timeout: WAIT.step,
      label: "Rights Management Asset title",
    });

    setTextControl(assetTitle, title);
    log("Set Rights Management asset title.");
  }

  async function fillCustomizationStep() {
    const requiredToggle = {
      pattern: /^Live chat\b/i,
      label: "Live chat",
    };
    const optionalToggles = [
      /^Live chat replay\b/i,
      /^Live chat summary\b/i,
      /^Live chat translation\b/i,
      /^Leaderboard\b/i,
      /^Q&A\b/i,
      /Questions and answers/i,
      /^Polls\b/i,
      /^Live reactions\b/i,
      /^Reactions\b/i,
    ];

    const root = await waitFor(() => {
      const dialog = findCreateStreamDialog();
      if (!dialog) return null;
      return findToggleByLabel(requiredToggle.pattern, dialog) ? dialog : null;
    }, {
      timeout: WAIT.step,
      label: "the Live chat checkbox on the customization step",
    });

    const required = await setSwitchByLabel(requiredToggle.pattern, false, root, {
      required: true,
      label: requiredToggle.label,
    });

    if (!required.found || !required.verified) {
      throw new Error("Live chat was not confirmed disabled. Stopping before event creation.");
    }

    let changed = required.changed ? 1 : 0;
    let found = 1;

    for (const label of optionalToggles) {
      const result = await setSwitchByLabel(label, false, root);
      if (result.found) found += 1;
      if (result.changed) changed += 1;
    }

    log(`Checked ${found} chat toggle(s); changed ${changed}.`);
  }

  async function fillVisibilityStep(settings) {
    await setVisibility(settings.visibility);
    await setStartTime(settings.startTime);
  }

  async function setVisibility(visibility) {
    const label = capitalize(visibility);
    await setRadioByLabel(new RegExp(`^${escapeRegExp(label)}\\b`, "i"), `${label} visibility option`);
    log(`Set visibility to ${visibility}.`);
  }

  async function setRadioByLabel(pattern, label, root = findCreateStreamDialog() || document) {
    await waitFor(() => findRadioByLabel(pattern, root), {
      timeout: WAIT.step,
      label,
    });

    let changed = false;

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const match = findRadioByLabel(pattern, root);
      if (!match) {
        await sleep(500);
        continue;
      }

      if (isSelected(match.control)) return { found: true, changed };

      clickElement(match.control);
      changed = true;
      await sleep(500);

      const fresh = findRadioByLabel(pattern, root) || match;
      if (isSelected(fresh.control)) return { found: true, changed };
    }

    throw new Error(`Could not select ${label}.`);
  }

  function isRadioSelectedByLabel(pattern, root = findCreateStreamDialog() || document) {
    const match = findRadioByLabel(pattern, root);
    return Boolean(match && isSelected(match.control));
  }

  function findRadioByLabel(pattern, root = findCreateStreamDialog() || document) {
    for (const label of findTextElements(pattern, root)) {
      const control = findOptionInputNear(label, root);
      if (control) return { label, control };
    }

    // Scoped to root: single-word option labels like "Low" match far too much of the
    // page to be searched document-wide.
    const clickable = findClickableByText([pattern], {
      selector: optionSelector(),
      root,
      enabledOnly: false,
    });

    return clickable ? { label: clickable, control: clickable } : null;
  }

  async function setStartTime(startTime) {
    const date = resolveStartDate(startTime);
    const controls = await ensureScheduleControlsVisible();

    if (!controls?.date || !controls?.time) {
      const missing = [
        !controls?.date ? "date" : "",
        !controls?.time ? "time" : "",
      ].filter(Boolean).join(" and ");
      throw new Error(`Could not find the scheduled ${missing} control on the Visibility step.`);
    }

    const dateSet = await setDateField(date, controls.date);
    const timeSet = await setTimeField(date, controls.time);

    if (!dateSet || !timeSet) {
      const failed = [
        !dateSet ? "date" : "",
        !timeSet ? "time" : "",
      ].filter(Boolean).join(" and ");
      throw new Error(`Could not confirm the scheduled ${failed}. Stopping before event creation.`);
    }

    log(`Set start time to ${formatReadableDate(date)}.`);
  }

  async function ensureScheduleControlsVisible() {
    let controls = findScheduleDateTimeControls();
    if (controls.date && controls.time) return controls;

    const dialog = findCreateStreamDialog();
    const scheduleOption = findClickableByText([/Schedule for later/i], {
      selector: optionSelector(),
      root: dialog || document,
    });

    if (scheduleOption && isClickable(scheduleOption) && !isSelected(scheduleOption)) {
      clickElement(scheduleOption);
      await sleep(500);
    }

    controls = await waitFor(() => {
      const current = findScheduleDateTimeControls();
      return current.date && current.time ? current : null;
    }, {
      timeout: WAIT.short,
      label: "the Schedule date and time controls",
    }).catch((error) => {
      if (errorMessage(error) === "Stopped by user.") throw error;
      return findScheduleDateTimeControls();
    });

    return controls;
  }

  async function submitCreation(settings) {
    const previousUrl = location.href;
    if (settings?.visibility) {
      const visibilityLabel = capitalize(settings.visibility);
      const visibilityPattern = new RegExp(`^${escapeRegExp(visibilityLabel)}\\b`, "i");
      await waitFor(() => isRadioSelectedByLabel(visibilityPattern), {
        timeout: WAIT.normal,
        label: `${visibilityLabel} visibility to be selected before final submission`,
      });
    }

    const button = await waitFor(
      () => findButtonInCreateStreamDialog([/^Done$/i, /^Create$/i, /^Schedule$/i, /^Schedule stream$/i], {
        enabledOnly: true,
      }),
      {
        timeout: WAIT.step,
        label: "the final create/schedule button",
      }
    );

    const submittedDialog = findCreateStreamDialog();
    clickElement(button);
    log("Submitted event creation.");

    const url = await waitFor(
      () => {
        const detected = detectCurrentEventUrl(previousUrl);
        if (!detected) return null;

        const submittedDialogGone = (
          !submittedDialog ||
          !submittedDialog.isConnected ||
          !isVisibleOutsidePanel(submittedDialog)
        );
        const wizardFinished = detectWizardStep() !== "visibility";
        const streamKeyReady = Boolean(findStreamKeyDropdown());

        return submittedDialogGone && wizardFinished && streamKeyReady ? detected : null;
      },
      {
        timeout: WAIT.create,
        label: "the newly created event page and stream settings",
      }
    );

    return url;
  }

  async function selectStreamKeyAfterCreate(eventUrl, streamKeyLabel) {
    checkStop();
    log("Looking for the post-create stream key selector.");

    let dropdown = await waitFor(() => findStreamKeyDropdown(), {
      timeout: WAIT.step,
      label: "the Key stream selector after event creation",
    }).catch(() => {
      throw new Error(`Stream key selector not found. Event URL for manual recovery: ${eventUrl || location.href}`);
    });

    log(`Waiting ${STREAM_KEY_PAGE_SETTLE_MS / 1000} seconds for the stream settings page to finish loading.`);
    await sleep(STREAM_KEY_PAGE_SETTLE_MS);
    dropdown = await waitFor(() => findStreamKeyDropdown(), {
      timeout: WAIT.normal,
      label: "the Key stream selector after the page settled",
    }).catch(() => {
      throw new Error(`Stream key selector disappeared while the page was loading. Event URL for manual recovery: ${eventUrl || location.href}`);
    });

    if (streamKeyTriggerHasLabel(dropdown, streamKeyLabel)) {
      log(`Stream key "${streamKeyLabel}" is already selected.`);
      return;
    }

    log(`Opening stream key selector: ${streamKeyTriggerText(dropdown) || "current key not readable"}.`);
    const opened = await openStreamKeyDropdown(dropdown, streamKeyLabel).catch((error) => {
      throw new Error(
        `${errorMessage(error)} Event URL for manual recovery: ${eventUrl || location.href}`
      );
    });
    dropdown = opened.dropdown || dropdown;

    const option = opened.option || await waitFor(
      () => {
        const currentRoots = uniqueElements([
          ...opened.roots,
          ...findStreamKeyPopupRoots(),
        ]);
        return (
          findStreamKeyOption(streamKeyLabel, currentRoots) ||
          findStreamKeyOption(streamKeyLabel, [document])
        );
      },
      {
      timeout: WAIT.step,
      label: `stream key option "${streamKeyLabel}"`,
      }
    ).catch(() => {
      throw new Error(`Stream key "${streamKeyLabel}" not found. Event URL for manual recovery: ${eventUrl || location.href}`);
    });

    const optionPopup = findStreamKeyPopupRoots()
      .find((root) => root === option || isComposedDescendantOf(option, root)) || null;

    const optionClickedAt = Date.now();
    clickElement(option);
    await sleep(300);

    const confirmation = await waitFor(() => {
      const current = findStreamKeyDropdown();
      if (!current || isDropdownExpanded(current)) return null;

      if (streamKeyTriggerHasLabel(current, streamKeyLabel)) {
        return { current, proof: "caption" };
      }

      const optionClosed = !option.isConnected || !isVisibleOutsidePanel(option);
      const popupClosed = (
        !optionPopup ||
        !optionPopup.isConnected ||
        !isVisibleOutsidePanel(optionPopup)
      );
      const confirmationDelayElapsed =
        Date.now() - optionClickedAt >= STREAM_KEY_CONFIRM_SETTLE_MS;
      return optionClosed && popupClosed && confirmationDelayElapsed
        ? { current, proof: "settled-menu-closed" }
        : null;
    }, {
      timeout: WAIT.normal,
      label: `stream key "${streamKeyLabel}" selection to be accepted`,
    }).catch(() => {
      const current = findStreamKeyDropdown();
      const shown = current ? streamKeyTriggerText(current) : "selector not found";
      throw new Error(
        `Stream key option "${streamKeyLabel}" was clicked but not confirmed (showing: ${shown}). ` +
        `Event URL for manual recovery: ${eventUrl || location.href}`
      );
    });

    if (confirmation.proof === "settled-menu-closed") {
      log(
        `Confirmed stream key "${streamKeyLabel}" after Studio finished updating the selector.`
      );
    }
  }

  // Runs on the same stream settings page as the stream key selector, straight after the
  // key is confirmed. Returns true when a change was actually applied.
  async function setStreamLatency(latency, eventUrl) {
    checkStop();

    const option = findLatencyOption(latency);
    if (!option) throw new Error(`Unknown latency setting "${latency}".`);

    log(`Looking for the Stream latency setting to set ${option.label}.`);

    const section = await waitForStreamSetting(
      () => findStreamLatencySection(),
      "the Stream latency setting",
      eventUrl
    );

    const result = await setRadioByLabel(
      option.pattern,
      `the ${option.label} latency option`,
      section
    ).catch((error) => {
      if (errorMessage(error) === "Stopped by user.") throw error;
      throw new Error(
        `Could not select ${option.label} latency. ` +
        `Event URL for manual recovery: ${eventUrl || location.href}`
      );
    });

    if (!result.changed) {
      log(`Stream latency was already set to ${option.label}.`);
      return false;
    }

    log(`Set stream latency to ${option.label}.`);
    log(`Waiting ${LATENCY_SETTLE_MS / 1000} seconds for Studio to save the latency change.`);
    await sleep(LATENCY_SETTLE_MS);
    return true;
  }

  // Auto-start lives beside latency on the stream settings page, so it runs straight
  // after the latency step and its LATENCY_SETTLE_MS wait.
  async function setAutoStart(eventUrl) {
    checkStop();

    log("Looking for the Auto-start setting.");

    const match = await waitForStreamSetting(
      () => findToggleByLabel(AUTO_START_PATTERN),
      "the Auto-start setting",
      eventUrl
    );

    const initial = switchState(match.control);

    if (initial === true) {
      log("Auto-start was already enabled.");
      return false;
    }

    if (initial === null) {
      throw new Error(
        `Found the Auto-start toggle but could not read its state. ` +
        `Event URL for manual recovery: ${eventUrl || location.href}`
      );
    }

    clickElement(match.control);
    await sleep(500);

    // Studio flips the toggle on optimistically and then asks to confirm, so the
    // toggle state alone is not proof. The prompt has to be accepted.
    await confirmAutoStartDialog();

    const enabled = await waitFor(() => {
      // A prompt still on screen means the click never landed, whatever the toggle says.
      if (findAutoStartConfirmDialog()) return false;
      const current = findToggleByLabel(AUTO_START_PATTERN);
      return current && switchState(current.control) === true;
    }, {
      timeout: WAIT.normal,
      label: "auto-start to be confirmed enabled",
    }).catch((error) => {
      if (errorMessage(error) === "Stopped by user.") throw error;
      return false;
    });

    if (!enabled) {
      throw new Error(
        `Auto-start was not confirmed enabled. ` +
        `Event URL for manual recovery: ${eventUrl || location.href}`
      );
    }

    log("Enabled auto-start.");
    return true;
  }

  // "Enabling auto-start will automatically start the stream ... Are you sure you want
  // to enable auto-start for this stream?" with Cancel and Enable.
  async function confirmAutoStartDialog() {
    const dialog = await waitFor(() => findAutoStartConfirmDialog(), {
      timeout: WAIT.short,
      label: "the Enable Auto-start prompt",
    }).catch((error) => {
      if (errorMessage(error) === "Stopped by user.") throw error;
      return null;
    });

    if (!dialog) {
      log("No Enable Auto-start prompt appeared.");
      return false;
    }

    const confirm = await waitFor(
      () => findClickableByText([/^Enable$/i], {
        selector: buttonSelector(),
        root: dialog,
        enabledOnly: true,
      }),
      {
        timeout: WAIT.short,
        label: "the Enable button on the auto-start prompt",
      }
    );

    clickElement(confirm);
    log("Confirmed the Enable Auto-start prompt.");

    await waitFor(() => !findAutoStartConfirmDialog(), {
      timeout: WAIT.normal,
      label: "the Enable Auto-start prompt to close",
    });

    return true;
  }

  // Anchor on the prompt's own wording. The "Enable Auto-start" row label in
  // Additional settings would otherwise match and resolve to the wrong container.
  function findAutoStartConfirmDialog() {
    const dialog =
      findDialogByText(/Are you sure you want to enable auto[\s-]*start/i) ||
      findDialogByText(/Enabling auto[\s-]*start will/i);
    return dialog && isVisibleOutsidePanel(dialog) ? dialog : null;
  }

  // Studio renders the stream settings lazily, and some layouts tuck them behind a
  // collapsed "Additional settings" section.
  async function waitForStreamSetting(find, description, eventUrl) {
    // Wait out a slow render before touching the expander, so we never collapse a
    // section that was already open.
    const found = await waitFor(find, {
      timeout: WAIT.short,
      label: description,
    }).catch((error) => {
      if (errorMessage(error) === "Stopped by user.") throw error;
      return null;
    });

    if (found) return found;

    await expandAdditionalSettings(description);

    return waitFor(find, {
      timeout: WAIT.normal,
      label: description,
    }).catch((error) => {
      if (errorMessage(error) === "Stopped by user.") throw error;
      throw new Error(
        `Could not find ${description}. ` +
        `Event URL for manual recovery: ${eventUrl || location.href}`
      );
    });
  }

  function findLatencyOption(latency) {
    return LATENCY_OPTIONS.find((option) => option.value === latency) || null;
  }

  // Scope the option labels to the latency block; bare words like "Low" and "Normal"
  // are far too common elsewhere on the stream settings page.
  function findStreamLatencySection() {
    const headings = uniqueElements([
      ...findTextElements(/^Stream latency\b/i),
      ...findTextElements(/Stream latency/i),
    ]).slice(0, 3);

    const viewportArea = window.innerWidth * window.innerHeight;

    for (const heading of headings) {
      let container = heading;

      for (let depth = 0; depth < 8 && container; depth += 1) {
        if (countLatencyOptionLabels(container) >= 2) return container;
        // Past this size it is a page region, not the latency block.
        if (rectArea(container.getBoundingClientRect()) > viewportArea * 0.8) break;
        container = parentElement(container);
      }
    }

    return null;
  }

  function countLatencyOptionLabels(root) {
    const matched = new Set();

    for (const element of deepQueryAll("*", root)) {
      if (!isVisibleOutsidePanel(element)) continue;

      const text = textOf(element);
      if (!text) continue;

      for (const option of LATENCY_OPTIONS) {
        if (matchesPattern(text, option.pattern)) matched.add(option.value);
      }

      if (matched.size >= 2) return matched.size;
    }

    return matched.size;
  }

  async function expandAdditionalSettings(description) {
    const expander = findClickableByText([/^Additional settings\b/i, /Additional settings/i], {
      selector: buttonSelector(),
      enabledOnly: false,
    });

    if (!expander || isDropdownExpanded(expander)) return false;

    clickElement(expander);
    log(`Expanded Additional settings to reach ${description}.`);
    await sleep(WAIT.short);
    return true;
  }

  async function returnToLivestreamManagePage() {
    checkStop();
    if (isLivestreamManagePageReady()) return;

    // Give Studio a moment to persist the stream-key choice before leaving.
    log(`Waiting ${STREAM_KEY_SAVE_SETTLE_MS / 1000} seconds for Studio to save the stream key.`);
    await sleep(STREAM_KEY_SAVE_SETTLE_MS);
    log("Returning to Manage streams before creating the next event.");

    const backControl = await waitFor(() => findLivestreamManageBackControl(), {
      timeout: WAIT.normal,
      label: "the livestream back button",
    });
    clickElement(backControl);

    await waitFor(() => isLivestreamManagePageReady(), {
      timeout: WAIT.step,
      label: "the livestream Manage streams page",
    });
  }

  function isLivestreamManagePageReady() {
    if (parseStudioLivestreamEventUrl(location.href)) return false;

    const scheduleButton = findScheduleStreamButton();
    if (!scheduleButton) return false;

    const manageHeading = findTextElement(/^Manage (?:live )?streams\b/i);
    const manageRoute = /\/livestreaming\/manage(?:\/|$)/i.test(location.pathname);
    return Boolean(manageHeading || manageRoute);
  }

  function findLivestreamManageBackControl() {
    const selector = [
      'a[href*="/livestreaming/manage"]',
      "button",
      '[role="button"]',
      "ytcp-icon-button",
      "tp-yt-paper-icon-button",
      "paper-icon-button",
      '[aria-label]',
      '[title]',
    ].join(",");

    return uniqueElements(
      deepQueryAll(selector)
        .filter(isVisibleOutsidePanel)
        .map((element) => closestClickable(element))
        .filter(Boolean)
        .filter(isVisibleOutsidePanel)
        .filter((element) => !isDisabled(element))
    )
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const href = element.href || element.getAttribute?.("href") || "";
        const label = textOf(element);
        const manageLink = /\/livestreaming\/manage(?:[/?#]|$)/i.test(href);
        const labelledBack = /(?:^|\b)(?:back|return)(?:\b|$)/i.test(label);
        const topLeftArrow = (
          rect.left >= 0 &&
          rect.left <= 80 &&
          rect.top >= 45 &&
          rect.top <= 140 &&
          rect.width >= 20 &&
          rect.width <= 72 &&
          rect.height >= 20 &&
          rect.height <= 72
        );
        return {
          element,
          rect,
          manageLink,
          labelledBack,
          topLeftArrow,
        };
      })
      .filter((item) => item.manageLink || item.labelledBack || item.topLeftArrow)
      .sort((a, b) =>
        Number(b.manageLink) - Number(a.manageLink) ||
        Number(b.labelledBack) - Number(a.labelledBack) ||
        Number(b.topLeftArrow) - Number(a.topLeftArrow) ||
        a.rect.top - b.rect.top ||
        a.rect.left - b.rect.left
      )[0]?.element || null;
  }

  async function clickNext(stepName, expectedStep) {
    const next = await waitFor(() => findNextButton(), {
      timeout: WAIT.step,
      label: `Next button after ${stepName}`,
    });
    clickElement(next);
    await waitForWizardStep(expectedStep, stepName);
  }

  async function waitForWizardStep(expectedStep, previousStep) {
    const stepOrder = ["details", "rights management", "customization", "visibility"];
    const expectedIndex = stepOrder.indexOf(expectedStep);
    const end = Date.now() + WAIT.step;
    let laterStep = "";
    let laterStepSince = 0;

    while (Date.now() < end) {
      checkStop();
      const currentStep = detectWizardStep();

      if (currentStep === expectedStep) {
        return;
      }

      const currentIndex = stepOrder.indexOf(currentStep);
      if (expectedIndex >= 0 && currentIndex > expectedIndex) {
        if (currentStep !== laterStep) {
          laterStep = currentStep;
          laterStepSince = Date.now();
        } else if (Date.now() - laterStepSince >= 500) {
          throw new Error(
            `The create-stream wizard moved from ${previousStep} to ${currentStep}, skipping ${expectedStep}.`
          );
        }
      } else {
        laterStep = "";
        laterStepSince = 0;
      }

      await sleep(WAIT.poll);
    }

    const currentStep = detectWizardStep();
    const location = currentStep ? ` It is currently on ${currentStep}.` : "";
    throw new Error(`Timed out waiting for the ${expectedStep} step after ${previousStep}.${location}`);
  }

  function detectWizardStep() {
    const dialog = findCreateStreamDialog();
    if (!dialog) return "";

    const visibilityPatterns = [/^Private\b/i, /^Unlisted\b/i, /^Public\b/i];
    const visibleVisibilityOptions = visibilityPatterns.filter((pattern) =>
      findTextElements(pattern, dialog).some((label) => findOptionInputNear(label, dialog))
    );
    if (visibleVisibilityOptions.length >= 2) return "visibility";

    if (findToggleByLabel(/^Live chat\b/i, dialog)) return "customization";

    for (const label of findTextElements(/asset title/i, dialog)) {
      if (findEditableControlNearLabel(label, dialog)) return "rights management";
    }

    if (findTitleControlInCreateStreamDialog()) return "details";
    return "";
  }

  async function tryClickAnyButton(patterns, timeout) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      checkStop();
      const button = findEnabledButton(patterns);
      if (button) {
        clickElement(button);
        return true;
      }
      await sleep(WAIT.poll);
    }
    return false;
  }

  function findEnabledButton(patterns) {
    return findClickableByText(patterns, {
      selector: buttonSelector(),
      enabledOnly: true,
    });
  }

  function findNextButton() {
    return findButtonInCreateStreamDialog([/^(?:Next)(?:\s+Next)*$/i], {
      enabledOnly: true,
    });
  }

  function findButtonInCreateStreamDialog(patterns, options = {}) {
    const dialog = findCreateStreamDialog();
    if (!dialog) {
      return findClickableByText(patterns, {
        selector: buttonSelector(),
        enabledOnly: options.enabledOnly,
      });
    }

    const candidates = uniqueElements(
      deepQueryAll(buttonSelector(), dialog)
        .filter(isVisibleOutsidePanel)
        .map((element) => closestClickable(element))
        .filter(Boolean)
        .filter(isVisibleOutsidePanel)
    );

    for (const candidate of candidates) {
      if (options.enabledOnly && isDisabled(candidate)) continue;
      if (elementMatchesPatterns(candidate, patterns, options.exact)) {
        return candidate;
      }
    }

    const textElement = findTextElement((text) => patterns.some((pattern) => matchesPattern(text, pattern, options.exact)), dialog);
    if (!textElement) return null;

    const clickable = closestClickable(textElement);
    if (!clickable || (options.enabledOnly && isDisabled(clickable))) return null;
    return clickable;
  }

  function findCreateNewFromPreviousSettingsDialog() {
    const dialog = findPreviousSettingsDialog();
    if (!dialog) return null;

    const direct = findClickableByText([/^(?:Create\s*new)(?:\s+Create\s*new)*$/i], {
      selector: buttonSelector(),
      root: dialog,
      enabledOnly: false,
    });
    return direct && !isDisabled(direct) ? direct : null;
  }

  function findPreviousSettingsDialog() {
    return findDialogByText(/Schedule with previous settings/i);
  }

  function findCreateStreamDialog() {
    return findDialogByText(/^Create stream$/i) || findDialogByText(/Create stream/i);
  }

  function findDialogByText(pattern) {
    const label = findTextElement(pattern);
    if (!label) return null;

    let container = label;
    let best = null;

    for (let depth = 0; depth < 12 && container; depth += 1) {
      const rect = container.getBoundingClientRect();
      const role = container.getAttribute?.("role");

      if (role === "dialog") return container;

      if (
        rect.width >= 260 &&
        rect.height >= 150 &&
        rect.width <= Math.max(900, window.innerWidth * 0.9) &&
        rect.height <= Math.max(700, window.innerHeight * 0.9)
      ) {
        best = container;
      }

      container = parentElement(container);
    }

    return best;
  }

  function findTitleControl() {
    return (
      findTitleControlInCreateStreamDialog() ||
      findFormControlByLabel(/^Title\b/i) ||
      findFormControlByLabel(/stream title/i) ||
      findFormControlByLabel(/add a title/i) ||
      findLikelyTitleControl()
    );
  }

  function findTitleControlInCreateStreamDialog() {
    const dialog = findCreateStreamDialog();
    if (!dialog) return null;

    const label = findTextElement(/^Title\b/i, dialog);
    if (!label) return null;

    return findEditableControlNearLabel(label, dialog);
  }

  function findEditableControlNearLabel(label, root) {
    const labelRect = label.getBoundingClientRect();
    const controls = uniqueElements(
      visibleControls(controlSelector(), root)
        .map(normalizeControl)
        .filter(Boolean)
        .filter(isEditableControl)
        .filter((control) => !isReadOnlyControl(control))
    )
      .map((control) => ({
        control,
        rect: control.getBoundingClientRect(),
      }))
      .filter((item) => item.rect.width >= 160 && item.rect.height >= 18)
      .filter((item) => item.rect.top >= labelRect.top - 8)
      .map((item) => ({
        ...item,
        vertical: Math.max(0, item.rect.top - labelRect.bottom),
        overlap: horizontalOverlap(labelRect, item.rect),
      }))
      .filter((item) => item.vertical < 120)
      .sort((a, b) => {
        const overlapScore = Number(b.overlap > 0) - Number(a.overlap > 0);
        return overlapScore || a.vertical - b.vertical || a.rect.left - b.rect.left;
      });

    return controls[0]?.control || null;
  }

  function findLikelyTitleControl() {
    const dialog = findCreateStreamDialog();
    const root = dialog || document;
    if (!hasVisibleText(/Details/i) && !hasVisibleText(/Title/i)) return null;

    const controls = visibleControls(controlSelector(), root)
      .map(normalizeControl)
      .filter(Boolean)
      .filter(isEditableControl)
      .filter((control) => !isReadOnlyControl(control))
      .map((control) => ({
        control,
        rect: control.getBoundingClientRect(),
      }))
      .filter((item) => item.rect.width >= 160 && item.rect.height >= 18)
      .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);

    return controls[0]?.control || null;
  }

  function findScheduleDateTimeControls() {
    const dialog = findCreateStreamDialog();
    if (!dialog) return { date: null, time: null };

    const heading = findScheduleHeading(dialog);
    if (!heading) return { date: null, time: null };

    const headingRect = heading.getBoundingClientRect();
    const dialogRect = dialog.getBoundingClientRect();
    const rowTop = headingRect.bottom - 4;
    const rowBottom = Math.min(headingRect.bottom + 170, dialogRect.bottom - 70);
    const inScheduleRow = (element) => {
      const rect = element.getBoundingClientRect();
      return (
        rect.top >= rowTop &&
        rect.top < rowBottom &&
        rect.left >= headingRect.left - 30 &&
        rect.right <= dialogRect.right - 20
      );
    };

    const timeCandidates = uniqueElements(
      visibleControls(controlSelector(), dialog)
        .map(normalizeControl)
        .filter(Boolean)
    )
      .filter((control) => isEditableControl(control) && !isReadOnlyControl(control))
      .filter(inScheduleRow)
      .filter((control) => parseTimeMinutes(scheduleFieldText(control)) !== null)
      .map((control) => ({
        control,
        rect: control.getBoundingClientRect(),
        semantic: /time/i.test(controlAccessibleText(control)) ? 1 : 0,
      }))
      .sort((a, b) => b.semantic - a.semantic || a.rect.top - b.rect.top || a.rect.left - b.rect.left);

    let time = timeCandidates[0]?.control || null;

    if (!time) {
      const timeTriggerSelector = [
        "button",
        '[role="button"]',
        '[role="combobox"]',
        '[aria-haspopup]',
        "ytcp-dropdown-trigger",
        "ytcp-text-dropdown-trigger",
      ].join(",");

      time = deepQueryAll(timeTriggerSelector, dialog)
        .filter(isVisibleOutsidePanel)
        .filter((element) => !isDisabled(element))
        .filter(inScheduleRow)
        .filter((element) => parseTimeMinutes(scheduleFieldText(element)) !== null)
        .map((element) => findClickableAncestor(element, dialog))
        .filter(Boolean)
        .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)[0] || null;
    }

    const timeRect = time?.getBoundingClientRect();

    const dateCandidates = deepQueryAll("*", dialog)
      .filter(isVisibleOutsidePanel)
      .filter((element) => !["SCRIPT", "STYLE", "TEMPLATE"].includes(element.tagName))
      .filter(inScheduleRow)
      .filter((element) => looksLikeFullDateText(scheduleFieldText(element)))
      .map((element) => ({
        element,
        control: findClickableAncestor(element, dialog),
        textLength: scheduleFieldText(element).length,
        area: rectArea(element.getBoundingClientRect()),
      }))
      .filter((item) => item.control && isClickable(item.control))
      .filter((item) => {
        if (!timeRect) return true;
        const rect = item.control.getBoundingClientRect();
        return rect.left < timeRect.left && verticalCenterDelta(rect, timeRect) < 60;
      })
      .sort((a, b) => a.textLength - b.textLength || a.area - b.area);

    let date = dateCandidates[0]?.control || null;

    if (!date) {
      const semanticDateSelector = [
        'input[type="date"]',
        '[aria-label*="date" i]',
        '[id*="date" i]',
        '[name*="date" i]',
        '[aria-haspopup="dialog"]',
        '[aria-haspopup="listbox"]',
        "ytcp-date-picker",
        "ytcp-datetime-picker",
        "ytcp-dropdown-trigger",
        "ytcp-text-dropdown-trigger",
      ].join(",");

      date = deepQueryAll(semanticDateSelector, dialog)
        .filter(isVisibleOutsidePanel)
        .filter((element) => !isDisabled(element))
        .filter(inScheduleRow)
        .map((element) => findClickableAncestor(element, dialog) || element)
        .filter((element) => !timeRect || element.getBoundingClientRect().left < timeRect.left)
        .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)[0] || null;
    }

    return { date, time };
  }

  function findScheduleHeading(dialog) {
    return deepQueryAll("*", dialog)
      .filter(isVisibleOutsidePanel)
      .filter((element) => !["SCRIPT", "STYLE", "TEMPLATE"].includes(element.tagName))
      .filter((element) => elementMatchesPatterns(element, [/^Schedule$/i]))
      .filter((element) => !findClickableAncestor(element, dialog))
      .map((element) => ({
        element,
        area: rectArea(element.getBoundingClientRect()),
      }))
      .sort((a, b) => a.area - b.area)[0]?.element || null;
  }

  function findClickableAncestor(element, boundary) {
    let current = element;
    for (let depth = 0; depth < 8 && current; depth += 1) {
      if (isClickable(current)) return current;
      if (current === boundary) break;
      current = parentElement(current);
    }
    return null;
  }

  function scheduleFieldText(element) {
    if (!element) return "";
    return normalize([
      readRawControlValue(element),
      element.getAttribute?.("aria-valuetext"),
      element.getAttribute?.("aria-label"),
      element.getAttribute?.("placeholder"),
      element.getAttribute?.("data-date"),
      element.getAttribute?.("data-value"),
      ...elementTextVariants(element),
    ].filter(Boolean).join(" "));
  }

  function looksLikeFullDateText(value) {
    const text = normalize(value);
    if (!text) return false;
    return (
      /\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},?\s+\d{4}\b/i.test(text) ||
      /\b\d{1,2}\s+(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{4}\b/i.test(text) ||
      /\b\d{4}-\d{1,2}-\d{1,2}\b/.test(text) ||
      /\b\d{1,2}[/. -]\d{1,2}[/. -]\d{4}\b/.test(text)
    );
  }

  function parseTimeMinutes(value) {
    const match = String(value || "").match(/\b([01]?\d|2[0-3]):([0-5]\d)\s*(AM|PM)?\b/i);
    if (!match) return null;

    let hour = Number(match[1]);
    const minute = Number(match[2]);
    const period = match[3]?.toUpperCase();

    if (period) {
      if (hour > 12) return null;
      if (hour === 12) hour = 0;
      if (period === "PM") hour += 12;
    }

    return hour * 60 + minute;
  }

  function dateTextMatches(value, date) {
    const actual = normalizeDateText(value);
    if (!actual) return false;
    return dateTextVariants(date).some((candidate) => {
      const expected = normalizeDateText(candidate);
      const pattern = new RegExp(`(^|\\D)${escapeRegExp(expected)}(?=\\D|$)`, "i");
      return pattern.test(actual);
    });
  }

  function dateTextVariants(date) {
    const formats = [
      formatNativeDate(date),
      new Intl.DateTimeFormat(undefined, { year: "numeric", month: "numeric", day: "numeric" }).format(date),
      new Intl.DateTimeFormat(undefined, { year: "numeric", month: "2-digit", day: "2-digit" }).format(date),
      new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric" }).format(date),
      new Intl.DateTimeFormat("en-US", { year: "numeric", month: "long", day: "numeric" }).format(date),
      new Intl.DateTimeFormat("en-US", { year: "numeric", month: "2-digit", day: "2-digit" }).format(date),
      new Intl.DateTimeFormat("en-AU", { year: "numeric", month: "short", day: "numeric" }).format(date),
      new Intl.DateTimeFormat("en-AU", { year: "numeric", month: "long", day: "numeric" }).format(date),
      new Intl.DateTimeFormat("en-GB", { year: "numeric", month: "numeric", day: "numeric" }).format(date),
      new Intl.DateTimeFormat("en-GB", { year: "numeric", month: "2-digit", day: "2-digit" }).format(date),
    ];
    return [...new Set(formats.map(normalize).filter(Boolean))];
  }

  function normalizeDateText(value) {
    return normalize(value)
      .toLowerCase()
      .replace(/\./g, "")
      .replace(/\s*,\s*/g, ",")
      .replace(/\s+/g, " ");
  }

  async function setDateField(date, initialControl = findScheduleDateTimeControls().date) {
    if (!initialControl) return false;
    if (dateTextMatches(scheduleFieldText(initialControl), date)) return true;

    const editable = normalizeControl(initialControl);
    if (
      editable &&
      isEditableControl(editable) &&
      !editable.hasAttribute?.("aria-haspopup")
    ) {
      const values = [formatNativeDate(date), formatDateText(date)];
      for (const value of values) {
        try {
          setTextControl(editable, value);
          await sleep(500);
        } catch (_) {
          continue;
        }

        const fresh = findScheduleDateTimeControls().date || editable;
        if (dateTextMatches(scheduleFieldText(fresh), date)) return true;
      }
    }

    if (!isClickable(initialControl)) return false;
    const existingPickerRoots = new Set(findOpenPickerRoots(initialControl));
    clickElement(initialControl);
    await sleep(500);

    const option = await findDateOptionInOpenPicker(
      date,
      initialControl,
      existingPickerRoots
    );

    if (!option) {
      log(`Calendar opened, but ${formatReadableDateOnly(date)} was not found in the visible month sections.`, "warn");
      return false;
    }
    log(`Selecting calendar date ${formatReadableDateOnly(date)}.`);
    clickElement(option);
    await sleep(300);

    return Boolean(await waitFor(() => {
      const fresh = findScheduleDateTimeControls().date || initialControl;
      return dateTextMatches(scheduleFieldText(fresh), date) ? fresh : null;
    }, {
      timeout: WAIT.short,
      label: `the scheduled date ${formatDateText(date)} to be shown`,
    }).catch((error) => {
      if (errorMessage(error) === "Stopped by user.") throw error;
      return null;
    }));
  }

  function findDatePickerOption(date, trigger, existingRoots = new Set()) {
    const roots = findDatePickerSearchRoots(trigger, existingRoots);
    if (!roots.length) return null;

    const candidates = uniqueElements(
      roots.flatMap((root) =>
        deepQueryAll(`${buttonSelector()},${optionSelector()},[role="gridcell"],.calendar-day,[data-date],[data-value],[tabindex]`, root)
      )
        .filter(isVisibleOutsidePanel)
        .filter((element) => !isDisabled(element))
        .filter((element) => dateTextMatches(scheduleFieldText(element), date))
        .map((element) => findCalendarDayActivationTarget(element))
        .filter(Boolean)
    )
      .filter((element) => element !== trigger && !trigger.contains?.(element))
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.width <= 140 && rect.height <= 140;
      })
      .map((element) => ({
        element,
        role: element.getAttribute?.("role") || "",
        area: rectArea(element.getBoundingClientRect()),
      }))
      .sort((a, b) => {
        const aPriority = /gridcell|option/.test(a.role) ? 0 : 1;
        const bPriority = /gridcell|option/.test(b.role) ? 0 : 1;
        return aPriority - bPriority || a.area - b.area;
      });

    return candidates[0]?.element || findCalendarDayOption(date, roots, trigger);
  }

  function findDatePickerSearchRoots(trigger, existingRoots = new Set()) {
    const creationDialog = findCreateStreamDialog();
    const rawRoots = findOpenPickerRoots(trigger)
      .filter((root) => !existingRoots.has(root));
    const expanded = [...findVisibleCalendarSurfaceRoots(trigger)];

    for (const root of rawRoots) {
      const rawRect = root.getBoundingClientRect();
      let current = root;

      for (let depth = 0; depth < 8 && current; depth += 1) {
        if (current === creationDialog || current === document.body || current === document.documentElement) {
          break;
        }

        if (current instanceof Element && isVisibleOutsidePanel(current)) {
          const rect = current.getBoundingClientRect();
          const compactEnough = (
            rect.width > 0 &&
            rect.height > 0 &&
            rect.width <= Math.max(rawRect.width * 3, 520) &&
            rect.height <= Math.max(rawRect.height * 3, 720)
          );
          if (!compactEnough) break;
          expanded.push(current);
        }

        current = parentElement(current);
      }
    }

    return uniqueElements(expanded)
      .map((root) => ({
        root,
        area: rectArea(root.getBoundingClientRect()),
      }))
      .sort((a, b) => b.area - a.area)
      .map((item) => item.root);
  }

  function findVisibleCalendarSurfaceRoots(trigger) {
    const creationDialog = findCreateStreamDialog();
    const headers = deepQueryAll("*")
      .filter(isVisibleOutsidePanel)
      .filter((element) => !["SCRIPT", "STYLE", "TEMPLATE"].includes(element.tagName))
      .filter((element) =>
        elementTextVariants(element).some((value) => looksLikeCalendarMonthYear(value))
      );
    const roots = [];

    for (const header of headers) {
      let current = header;

      for (let depth = 0; depth < 8 && current; depth += 1) {
        if (current === creationDialog || current === document.body || current === document.documentElement) {
          break;
        }

        if (current instanceof Element && isVisibleOutsidePanel(current)) {
          const rect = current.getBoundingClientRect();
          const compactEnough = (
            rect.width > 0 &&
            rect.height > 0 &&
            rect.width <= 520 &&
            rect.height <= 720
          );
          if (!compactEnough) break;
          roots.push(current);
        }

        current = parentElement(current);
      }
    }

    const triggerRect = trigger.getBoundingClientRect();
    return uniqueElements(roots)
      .map((root) => ({
        root,
        distance: distanceBetween(triggerRect, root.getBoundingClientRect()),
        area: rectArea(root.getBoundingClientRect()),
      }))
      .sort((a, b) => a.distance - b.distance || b.area - a.area)
      .map((item) => item.root);
  }

  function findCalendarDayOption(date, roots, trigger) {
    const desiredDay = String(date.getDate());
    const matches = [];

    for (const root of roots) {
      const monthHeaders = deepQueryAll("*", root)
        .filter(isVisibleOutsidePanel)
        .filter((element) =>
          elementTextVariants(element).some((value) => calendarMonthYearTextMatches(value, date))
        )
        .map((element) => ({
          element,
          rect: element.getBoundingClientRect(),
          area: rectArea(element.getBoundingClientRect()),
        }))
        .filter((item) => item.rect.width > 0 && item.rect.height > 0)
        .sort((a, b) => a.area - b.area || a.rect.top - b.rect.top);

      const allMonthHeaderRects = deepQueryAll("*", root)
        .filter(isVisibleOutsidePanel)
        .filter((element) =>
          elementTextVariants(element).some((value) => looksLikeCalendarMonthYear(value))
        )
        .map((element) => element.getBoundingClientRect())
        .filter((rect) => rect.width > 0 && rect.height > 0);

      const dayCandidates = uniqueElements(
        deepQueryAll("*", root)
          .filter(isVisibleOutsidePanel)
          .filter((element) => !["SCRIPT", "STYLE", "TEMPLATE"].includes(element.tagName))
          .filter((element) =>
            elementTextVariants(element).some((value) => normalize(value) === desiredDay)
          )
          .map((element) => findCalendarDayActivationTarget(element, root, desiredDay))
          .filter(Boolean)
      )
        .filter((element) => element !== trigger && !trigger.contains?.(element));

      for (const header of monthHeaders) {
        const nextMonthTop = allMonthHeaderRects
          .filter((rect) => rect.top > header.rect.bottom + 2)
          .map((rect) => rect.top)
          .sort((a, b) => a - b)[0];
        const sectionTop = header.rect.top - 4;
        const sectionBottom = Math.min(
          nextMonthTop || header.rect.top + 320,
          header.rect.top + 320
        );

        for (const element of dayCandidates) {
          const rect = element.getBoundingClientRect();
          if (rect.top < sectionTop || rect.bottom > sectionBottom + 2) continue;

          const role = element.getAttribute?.("role") || "";
          matches.push({
            element,
            role,
            activationPriority: calendarDayActivationPriority(element),
            top: rect.top,
            left: rect.left,
            area: rectArea(rect),
          });
        }
      }
    }

    return uniqueElements(
      matches
        .sort((a, b) => {
          if (a.activationPriority !== b.activationPriority) {
            return a.activationPriority - b.activationPriority;
          }
          const aPriority = /gridcell|option/.test(a.role) ? 0 : 1;
          const bPriority = /gridcell|option/.test(b.role) ? 0 : 1;
          return aPriority - bPriority || a.top - b.top || a.left - b.left || a.area - b.area;
        })
        .map((item) => item.element)
    )[0] || null;
  }

  function findCalendarDayActivationTarget(element, boundary, desiredDay = "") {
    const nestedSelector = [
      "button",
      '[role="button"]',
      '[role="gridcell"]',
      '[tabindex]:not([tabindex="-1"])',
      ".calendar-day",
      "[data-date]",
      "[data-value]",
    ].join(",");
    const nested = deepQueryAll(nestedSelector, element)
      .filter(isVisibleOutsidePanel)
      .filter((candidate) => !isCalendarDayUnavailable(candidate, element))
      .filter((candidate) =>
        !desiredDay ||
        elementTextVariants(candidate).some((value) => normalize(value) === desiredDay)
      )
      .map((candidate) => ({
        candidate,
        priority: calendarDayActivationPriority(candidate),
        area: rectArea(candidate.getBoundingClientRect()),
      }))
      .sort((a, b) => a.priority - b.priority || a.area - b.area)[0]?.candidate;
    if (nested) return nested;

    let current = element;
    let best = element;

    for (let depth = 0; depth < 10 && current; depth += 1) {
      if (isCalendarDayUnavailable(current, boundary)) return null;
      if (isClickable(current)) return current;

      const rect = current.getBoundingClientRect();
      const role = current.getAttribute?.("role") || "";
      const tabIndex = current.getAttribute?.("tabindex");
      const identity = normalize([
        current.tagName,
        current.id,
        typeof current.className === "string" ? current.className : "",
      ].join(" ")).toLowerCase();
      const compact = rect.width > 0 && rect.height > 0 && rect.width <= 96 && rect.height <= 96;
      const dayLike = (
        role === "gridcell" ||
        (tabIndex !== null && tabIndex !== "-1") ||
        /\b(?:calendar|date)[-_ ]?(?:day|cell)\b|\bday[-_ ]?(?:button|cell)\b/.test(identity)
      );
      if (compact && dayLike) best = current;

      if (current === boundary) break;
      current = parentElement(current);
    }

    return best;
  }

  function calendarDayActivationPriority(element) {
    const role = element.getAttribute?.("role") || "";
    const tabIndex = element.getAttribute?.("tabindex");
    const identity = normalize([
      element.tagName,
      element.id,
      typeof element.className === "string" ? element.className : "",
    ].join(" ")).toLowerCase();

    if (
      role === "gridcell" ||
      (tabIndex !== null && tabIndex !== "-1") ||
      /\b(?:calendar|date)[-_ ]?(?:day|cell)\b|\bday[-_ ]?(?:button|cell)\b/.test(identity)
    ) {
      return 0;
    }
    return isClickable(element) ? 1 : 2;
  }

  function isCalendarDayUnavailable(element, boundary) {
    let current = element;

    for (let depth = 0; depth < 10 && current; depth += 1) {
      const className = typeof current.className === "string" ? current.className : "";
      if (
        isDisabled(current) ||
        /(?:^|\s)(?:disabled|invisible|outside-month|not-in-month)(?:\s|$)/i.test(className)
      ) {
        return true;
      }
      if (current === boundary) break;
      current = parentElement(current);
    }

    return false;
  }

  function calendarMonthYearTextMatches(value, date) {
    const actual = normalizeCalendarMonthYear(value);
    if (!actual) return false;

    return calendarMonthYearVariants(date)
      .map(normalizeCalendarMonthYear)
      .some((expected) => actual === expected);
  }

  function calendarMonthYearVariants(date) {
    const locales = [undefined, "en-US", "en-AU", "en-GB"];
    const formats = locales.flatMap((locale) => [
      new Intl.DateTimeFormat(locale, { year: "numeric", month: "short" }).format(date),
      new Intl.DateTimeFormat(locale, { year: "numeric", month: "long" }).format(date),
    ]);
    return [...new Set(formats.map(normalize).filter(Boolean))];
  }

  function normalizeCalendarMonthYear(value) {
    return normalize(value)
      .replace(/([A-Za-z])(\d)/g, "$1 $2")
      .replace(/(\d)([A-Za-z])/g, "$1 $2")
      .toLowerCase()
      .replace(/\./g, "");
  }

  function looksLikeCalendarMonthYear(value) {
    const text = normalizeCalendarMonthYear(value);
    return /^(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{4}$/i.test(text);
  }

  async function findDateOptionInOpenPicker(date, trigger, existingRoots) {
    const pickerOpened = await waitFor(
      () => (
        findOpenPickerRoots(trigger).some((root) => !existingRoots.has(root)) ||
        findVisibleCalendarSurfaceRoots(trigger).length > 0
      ),
      {
        timeout: WAIT.short,
        label: "the calendar picker",
      }
    ).catch((error) => {
      if (errorMessage(error) === "Stopped by user.") throw error;
      return false;
    });
    if (!pickerOpened) return null;

    let option = findDatePickerOption(date, trigger, existingRoots);
    if (option) return option;

    const displayedDate = parseDisplayedDate(scheduleFieldText(trigger)) || new Date();
    const monthDelta =
      (date.getFullYear() - displayedDate.getFullYear()) * 12 +
      date.getMonth() -
      displayedDate.getMonth();

    if (Math.abs(monthDelta) > 60) return null;

    const direction = monthDelta >= 0 ? "next" : "previous";
    for (let month = 0; month < Math.abs(monthDelta); month += 1) {
      checkStop();
      const navigation = findDatePickerNavigationButton(direction, trigger, existingRoots);
      if (!navigation) return null;
      clickElement(navigation);
      await sleep(350);
    }

    option = await waitFor(
      () => findDatePickerOption(date, trigger, existingRoots),
      {
        timeout: WAIT.short,
        label: `the calendar date ${formatDateText(date)}`,
      }
    ).catch((error) => {
      if (errorMessage(error) === "Stopped by user.") throw error;
      return null;
    });

    return option;
  }

  function findDatePickerNavigationButton(direction, trigger, existingRoots) {
    const pattern = direction === "previous" ? /Previous month/i : /Next month/i;
    const roots = findDatePickerSearchRoots(trigger, existingRoots);

    return uniqueElements(
      roots.flatMap((root) => deepQueryAll(buttonSelector(), root))
        .filter(isVisibleOutsidePanel)
        .filter((element) => !isDisabled(element))
        .map((element) => findClickableAncestor(element))
        .filter(Boolean)
    )
      .filter((element) => elementMatchesPatterns(element, [pattern]))
      .sort((a, b) => rectArea(a.getBoundingClientRect()) - rectArea(b.getBoundingClientRect()))[0] || null;
  }

  function parseDisplayedDate(value) {
    const text = normalize(value);
    const monthNames = {
      jan: 0,
      january: 0,
      feb: 1,
      february: 1,
      mar: 2,
      march: 2,
      apr: 3,
      april: 3,
      may: 4,
      jun: 5,
      june: 5,
      jul: 6,
      july: 6,
      aug: 7,
      august: 7,
      sep: 8,
      september: 8,
      oct: 9,
      october: 9,
      nov: 10,
      november: 10,
      dec: 11,
      december: 11,
    };

    let match = text.match(/\b([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})\b/);
    if (match && Object.prototype.hasOwnProperty.call(monthNames, match[1].toLowerCase())) {
      return new Date(Number(match[3]), monthNames[match[1].toLowerCase()], Number(match[2]));
    }

    match = text.match(/\b(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})\b/);
    if (match && Object.prototype.hasOwnProperty.call(monthNames, match[2].toLowerCase())) {
      return new Date(Number(match[3]), monthNames[match[2].toLowerCase()], Number(match[1]));
    }

    match = text.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
    if (match) {
      return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    }

    return null;
  }

  function findOpenPickerRoots(trigger) {
    const creationDialog = findCreateStreamDialog();
    const selector = [
      '[role="dialog"]',
      '[role="listbox"]',
      '[role="grid"]',
      '[role="menu"]',
      "tp-yt-paper-dialog",
      "paper-dialog",
      "ytcp-date-picker",
      "ytcp-datepicker",
      "ytcp-calendar-date-picker",
      "ytd-calendar-date-picker",
      "ytcp-time-picker",
      "tp-yt-paper-listbox",
      "paper-listbox",
    ].join(",");

    return deepQueryAll(selector)
      .filter(isVisibleOutsidePanel)
      .filter((root) => root !== creationDialog)
      .filter((root) => root !== trigger && !trigger.contains?.(root))
      .map((root) => ({
        root,
        distance: distanceBetween(trigger.getBoundingClientRect(), root.getBoundingClientRect()),
        area: rectArea(root.getBoundingClientRect()),
      }))
      .filter((item) => item.area > 0)
      .sort((a, b) => a.distance - b.distance || a.area - b.area)
      .map((item) => item.root);
  }

  async function setTimeField(date, initialControl = findScheduleDateTimeControls().time) {
    if (!initialControl) return false;

    const desiredMinutes = date.getHours() * 60 + date.getMinutes();
    if (parseTimeMinutes(scheduleFieldText(initialControl)) === desiredMinutes) return true;

    const values = [
      formatTimeForControl(date, initialControl),
      formatTimeText(date),
      formatNativeTime(date),
    ].filter((value, index, all) => value && all.indexOf(value) === index);

    for (const value of values) {
      const control = findScheduleDateTimeControls().time || initialControl;
      try {
        setTextControl(control, value);
        await sleep(600);
      } catch (_) {
        break;
      }

      const fresh = findScheduleDateTimeControls().time || control;
      if (parseTimeMinutes(scheduleFieldText(fresh)) === desiredMinutes) return true;
    }

    const trigger = findScheduleDateTimeControls().time || initialControl;
    if (!isClickable(trigger)) return false;

    const existingPickerRoots = new Set(findOpenPickerRoots(trigger));
    clickElement(trigger);
    await sleep(400);
    const option = await waitFor(() => findTimePickerOption(desiredMinutes, trigger, existingPickerRoots), {
      timeout: WAIT.short,
      label: `the time option ${formatTimeText(date)}`,
    }).catch((error) => {
      if (errorMessage(error) === "Stopped by user.") throw error;
      return null;
    });

    if (!option) return false;
    clickElement(option);
    await sleep(500);

    const fresh = findScheduleDateTimeControls().time || trigger;
    return parseTimeMinutes(scheduleFieldText(fresh)) === desiredMinutes;
  }

  function formatTimeForControl(date, control) {
    const current = scheduleFieldText(control);
    const match = current.match(/\b(\d{1,2}):([0-5]\d)(\s*)(AM|PM)\b/i);
    if (!match) return formatNativeTime(date);

    const hour = date.getHours();
    const hour12 = hour % 12 || 12;
    const minute = String(date.getMinutes()).padStart(2, "0");
    const upperPeriod = hour < 12 ? "AM" : "PM";
    const period = match[4] === match[4].toLowerCase() ? upperPeriod.toLowerCase() : upperPeriod;
    const formattedHour = match[1].length === 2 ? String(hour12).padStart(2, "0") : String(hour12);
    return `${formattedHour}:${minute}${match[3]}${period}`;
  }

  function findTimePickerOption(desiredMinutes, trigger, existingRoots = new Set()) {
    const roots = findOpenPickerRoots(trigger)
      .filter((root) => !existingRoots.has(root));
    if (!roots.length) return null;

    return uniqueElements(
      roots.flatMap((root) => deepQueryAll(`${buttonSelector()},${optionSelector()}`, root))
        .filter(isVisibleOutsidePanel)
        .filter((element) => !isDisabled(element))
        .map((element) => findClickableAncestor(element))
        .filter(Boolean)
    )
      .filter((element) => element !== trigger && !trigger.contains?.(element))
      .filter((element) => parseTimeMinutes(scheduleFieldText(element)) === desiredMinutes)
      .sort((a, b) => rectArea(a.getBoundingClientRect()) - rectArea(b.getBoundingClientRect()))[0] || null;
  }

  function findFormControlByLabel(pattern, root = document) {
    const controls = visibleControls(controlSelector(), root);

    for (const control of controls) {
      const accessible = controlAccessibleText(control);
      if (matchesPattern(accessible, pattern)) return normalizeControl(control);
    }

    const label = findTextElement(pattern, root);
    if (!label) return null;

    let container = label;
    for (let depth = 0; depth < 7 && container; depth += 1) {
      const nested = visibleControls(controlSelector(), container).map(normalizeControl);
      const usable = nested.find((control) => control && !isReadOnlyControl(control));
      if (usable) return usable;
      container = parentElement(container);
    }

    return null;
  }

  function normalizeControl(control) {
    if (!control) return null;
    if (isNativeTextControl(control) || isDirectEditableControl(control)) return control;

    const nested = findNestedTextEditor(control) || visibleControls(controlSelector(), control).find(isEditableControl);
    return nested || control;
  }

  function visibleControls(selector, root) {
    return deepQueryAll(selector, root).filter((element) => isVisibleOutsidePanel(element));
  }

  async function setSwitchByLabel(pattern, desired, root = document, options = {}) {
    let changed = false;
    let sawControl = false;

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const match = findToggleByLabel(pattern, root);
      if (!match) {
        if (options.required) throw new Error(`Could not find ${options.label || "required toggle"}.`);
        return { found: false, changed: false, verified: false };
      }

      sawControl = true;
      const current = switchState(match.control);
      if (current === desired) return { found: true, changed, verified: true };

      if (current === null) {
        if (options.required) throw new Error(`Found ${options.label || "required toggle"} but could not read its state.`);
        log(`Found "${textOf(match.label)}" but could not read toggle state. Left it unchanged.`, "warn");
        return { found: true, changed, verified: false };
      }

      clickElement(match.control);
      changed = true;
      await sleep(500);
    }

    const fresh = findToggleByLabel(pattern, root);
    const verified = fresh ? switchState(fresh.control) === desired : false;
    if (options.required && !verified) {
      throw new Error(`${options.label || "Required toggle"} was not confirmed ${desired ? "enabled" : "disabled"}.`);
    }

    return { found: sawControl, changed, verified };
  }

  function findToggleByLabel(pattern, root = document) {
    for (const label of findTextElements(pattern, root)) {
      const control = findToggleNear(label, root);
      if (control) return { label, control };
    }

    return null;
  }

  function toggleSelector() {
    return [
      'input[type="checkbox"]',
      '[role="checkbox"]',
      '[role="switch"]',
      '[aria-checked]',
      '#checkbox',
      '.checkbox',
      'ytcp-checkbox',
      'ytcp-checkbox-lit',
      'tp-yt-paper-checkbox',
      'paper-checkbox',
      'ytcp-toggle-button',
      'tp-yt-paper-toggle-button',
      'paper-toggle-button',
    ].join(",");
  }

  function findToggleNear(label, root = document) {
    const selector = toggleSelector();
    let container = label;
    for (let depth = 0; depth < 7 && container; depth += 1) {
      const toggles = rankControlsNearLabel(label, deepQueryAll(selector, container));
      if (toggles.length) return toggles[0].control;
      container = parentElement(container);
    }

    return rankControlsNearLabel(label, deepQueryAll(selector, root))[0]?.control || null;
  }

  function rankControlsNearLabel(label, controls) {
    const labelRect = label.getBoundingClientRect();
    return uniqueElements(controls)
      .filter(isVisibleOutsidePanel)
      .map((control) => ({
        control,
        rect: control.getBoundingClientRect(),
      }))
      .map((item) => ({
        ...item,
        distance: distanceBetween(labelRect, item.rect),
        centerDelta: verticalCenterDelta(labelRect, item.rect),
      }))
      .filter((item) => item.distance < 280)
      .filter((item) => item.centerDelta < 70)
      .sort((a, b) => a.centerDelta - b.centerDelta || a.distance - b.distance);
  }

  function switchState(toggle) {
    if ("checked" in toggle && typeof toggle.checked === "boolean") return toggle.checked;
    if (typeof toggle.getAttribute === "function") {
      const aria = toggle.getAttribute("aria-checked");
      if (aria === "true") return true;
      if (aria === "false") return false;
      if (toggle.hasAttribute("checked")) return true;
    }
    if (typeof toggle.checked === "boolean") return toggle.checked;
    if (toggle.classList && toggle.classList.contains("checked")) return true;
    if (toggle.querySelector?.('[checked], [aria-checked="true"]')) return true;
    if (isToggleControl(toggle)) return false;
    return null;
  }

  function isToggleControl(element) {
    if (!element || !element.tagName) return false;
    const tag = element.tagName.toLowerCase();
    const role = element.getAttribute?.("role");
    const type = element.getAttribute?.("type");
    return (
      role === "checkbox" ||
      role === "switch" ||
      type === "checkbox" ||
      tag.includes("checkbox") ||
      tag.includes("toggle") ||
      element.id === "checkbox" ||
      element.classList?.contains("checkbox")
    );
  }

  function findStreamKeyDropdown(root = document) {
    const selector = [
      '[role="combobox"]',
      '[aria-haspopup="listbox"]',
      '[aria-haspopup="menu"]',
      '[aria-expanded]',
      "ytcp-dropdown-trigger",
      "ytcp-text-dropdown-trigger",
      "tp-yt-paper-dropdown-menu",
      "paper-dropdown-menu",
      "tp-yt-paper-menu-button",
      "paper-menu-button",
      "button",
      '[role="button"]',
    ].join(",");

    const semanticCandidates = deepQueryAll(selector, root)
      .filter(isVisibleOutsidePanel)
      .filter((element) => !isDisabled(element));

    const textCandidates = deepQueryAll("*", root)
      .filter(isVisibleOutsidePanel)
      .filter((element) => !["SCRIPT", "STYLE", "TEMPLATE"].includes(element.tagName))
      .filter((element) =>
        elementTextVariants(element).some((value) => /^Key\s*:/i.test(value))
      );

    return uniqueElements([...semanticCandidates, ...textCandidates])
      .map((element) => findStreamKeyDropdownAncestor(element, root))
      .filter(Boolean)
      .filter(isVisibleOutsidePanel)
      .filter((element) => !isDisabled(element))
      .filter((element) => /^Key\s*:/i.test(streamKeyTriggerText(element)))
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const text = streamKeyTriggerText(element);
        return {
          element,
          rect,
          semantics: hasStreamKeyDropdownSemantics(element) ? 1 : 0,
          defaultKey: /stream key/i.test(text) ? 1 : 0,
        };
      })
      .sort((a, b) =>
        b.semantics - a.semantics ||
        b.defaultKey - a.defaultKey ||
        a.rect.top - b.rect.top ||
        b.rect.right - a.rect.right
      )[0]?.element || null;
  }

  function findStreamKeyDropdownAncestor(element, boundary = document) {
    let current = element;
    for (let depth = 0; depth < 12 && current; depth += 1) {
      const hasKeyCaption = elementTextVariants(current)
        .some((value) => /^Key\s*:/i.test(value));
      if (
        hasKeyCaption &&
        (hasStreamKeyDropdownSemantics(current) || isClickable(current))
      ) {
        return current;
      }
      if (current === boundary) break;
      current = parentElement(current);
    }
    return null;
  }

  function hasStreamKeyDropdownSemantics(element) {
    if (!element?.tagName) return false;
    const tag = element.tagName.toLowerCase();
    const role = element.getAttribute?.("role");
    const popup = element.getAttribute?.("aria-haspopup");
    return (
      role === "combobox" ||
      popup === "listbox" ||
      popup === "menu" ||
      element.hasAttribute?.("aria-expanded") ||
      tag.includes("dropdown") ||
      tag.includes("menu-button")
    );
  }

  function streamKeyTriggerText(trigger) {
    if (!trigger) return "";
    const values = streamKeyTriggerTextValues(trigger)
      .map(normalize)
      .filter((value) => /^Key\s*:/i.test(value))
      .sort((a, b) => {
        const aHasValue = /\S/.test(a.replace(/^Key\s*:\s*/i, ""));
        const bHasValue = /\S/.test(b.replace(/^Key\s*:\s*/i, ""));
        return Number(bHasValue) - Number(aHasValue) || b.length - a.length;
      });
    return values[0] || "";
  }

  function streamKeyTriggerHasLabel(trigger, label) {
    if (!trigger) return false;
    const values = streamKeyTriggerTextValues(trigger);

    return values.some((value) => {
      const normalized = normalize(value);
      if (!/^Key\s*:/i.test(normalized)) return false;
      const withoutPrefix = normalized
        .replace(/^Key\s*:\s*/i, "")
        .replace(/\s+Key\s*:\s*/gi, " ");
      if (matchesStreamKeyOptionText(withoutPrefix, label)) return true;

      const withoutUiTokens = withoutPrefix
        .replace(/\b(?:expand_more|arrow_drop_down|keyboard_arrow_down)\b/gi, " ")
        .replace(/[▼▾⌄]+/g, " ");
      return matchesStreamKeyOptionText(withoutUiTokens, label);
    });
  }

  function streamKeyTriggerTextValues(trigger) {
    const scope = findStreamKeyTriggerShell(trigger);
    const scopeRect = scope.getBoundingClientRect();
    const descendants = deepQueryAll("*", scope)
      .filter((element) => element === scope || isVisibleOutsidePanel(element))
      .filter((element) => element === scope || !isWithinStreamKeyPopupBranch(element, scope))
      .filter((element) => {
        if (element === scope) return true;
        const rect = element.getBoundingClientRect();
        return (
          horizontalOverlap(scopeRect, rect) > 0 &&
          verticalCenterDelta(scopeRect, rect) <= Math.max(scopeRect.height, 48)
        );
      });

    return uniqueElements([scope, trigger, ...descendants])
      .flatMap((element) => [
        ...elementTextVariants(element),
        ...ariaLabelledByTextVariants(element),
      ]);
  }

  function findStreamKeyTriggerShell(trigger) {
    const triggerRect = trigger.getBoundingClientRect();
    let current = trigger;
    let best = trigger;

    for (let depth = 0; depth < 8 && current; depth += 1) {
      const rect = current.getBoundingClientRect();
      const compact = (
        rect.width > 0 &&
        rect.height > 0 &&
        rect.width <= Math.min(window.innerWidth * 0.75, 720) &&
        rect.height <= Math.max(triggerRect.height * 3, 120)
      );
      if (!compact) break;
      if (current === trigger || hasStreamKeyDropdownSemantics(current)) best = current;
      current = parentElement(current);
    }

    return best;
  }

  function isWithinStreamKeyPopupBranch(element, trigger) {
    let current = element;
    for (let depth = 0; depth < 12 && current && current !== trigger; depth += 1) {
      const tag = current.tagName?.toLowerCase() || "";
      const role = current.getAttribute?.("role");
      if (
        role === "listbox" ||
        role === "menu" ||
        tag.includes("iron-dropdown") ||
        tag.includes("paper-listbox") ||
        tag.includes("dropdown-menu") ||
        tag.includes("text-menu") ||
        tag.includes("menu-popup") ||
        tag.includes("paper-dialog")
      ) {
        return true;
      }
      current = parentElement(current);
    }
    return false;
  }

  async function openStreamKeyDropdown(initialDropdown, streamKeyLabel) {
    let dropdown = initialDropdown;

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      checkStop();
      dropdown = findStreamKeyDropdown() || dropdown;

      if (streamKeyTriggerHasLabel(dropdown, streamKeyLabel)) {
        return { dropdown, roots: [], option: null };
      }

      const existingRoots = new Set(findStreamKeyPopupRoots());
      const existingOptions = new Set(findStreamKeyOptionCandidates(streamKeyLabel, [document]));

      if (isDropdownExpanded(dropdown)) {
        const roots = findStreamKeyPopupRoots();
        return {
          dropdown,
          roots,
          option: findStreamKeyOption(streamKeyLabel, roots),
        };
      }

      clickElement(dropdown);

      const opened = await waitFor(() => {
        const currentDropdown = findStreamKeyDropdown() || dropdown;
        const allRoots = findStreamKeyPopupRoots();
        const newRoots = allRoots.filter((root) => !existingRoots.has(root));
        const optionInRoots = findStreamKeyOption(
          streamKeyLabel,
          newRoots.length ? newRoots : allRoots
        );
        const newGlobalOption = findStreamKeyOptionCandidates(streamKeyLabel, [document])
          .find((option) => !existingOptions.has(option));

        if (
          isDropdownExpanded(currentDropdown) ||
          newRoots.length ||
          optionInRoots ||
          newGlobalOption
        ) {
          return {
            dropdown: currentDropdown,
            roots: newRoots.length ? newRoots : allRoots,
            option: optionInRoots || newGlobalOption || null,
          };
        }

        return null;
      }, {
        timeout: WAIT.short,
        label: "the stream key menu to open",
      }).catch((error) => {
        if (errorMessage(error) === "Stopped by user.") throw error;
        return null;
      });

      if (opened) return opened;

      if (attempt < 3) {
        log(`The Key selector did not open; retrying (${attempt + 1}/3).`, "warn");
        await sleep(300);
      }
    }

    throw new Error("Could not open the stream key selector.");
  }

  function isDropdownExpanded(dropdown) {
    let current = dropdown;
    for (let depth = 0; depth < 6 && current; depth += 1) {
      if (current.getAttribute?.("aria-expanded") === "true") return true;
      current = parentElement(current);
    }

    return deepQueryAll('[aria-expanded="true"]', dropdown).length > 0;
  }

  function findStreamKeyPopupRoots() {
    const selector = [
      '[role="listbox"]',
      '[role="menu"]',
      "tp-yt-iron-dropdown",
      "iron-dropdown",
      "tp-yt-paper-listbox",
      "paper-listbox",
      "ytcp-dropdown-menu",
      "ytcp-text-menu",
      "ytd-menu-popup-renderer",
      "tp-yt-paper-dialog",
      "paper-dialog",
    ].join(",");

    return deepQueryAll(selector)
      .filter(isVisibleOutsidePanel)
      .map((root) => ({
        root,
        rect: root.getBoundingClientRect(),
      }))
      .filter((item) => item.rect.width > 0 && item.rect.height > 0)
      .sort((a, b) => rectArea(a.rect) - rectArea(b.rect))
      .map((item) => item.root);
  }

  function findStreamKeyOption(label, roots = []) {
    const searchRoots = roots.length ? roots : [document];
    return findStreamKeyOptionCandidates(label, searchRoots)[0] || null;
  }

  function findStreamKeyOptionCandidates(label, roots = [document]) {
    const matches = [];

    for (const root of roots) {
      for (const element of deepQueryAll("*", root)) {
        if (!isVisibleOutsidePanel(element)) continue;
        if (["SCRIPT", "STYLE", "TEMPLATE"].includes(element.tagName)) continue;
        if (!elementTextVariants(element).some((value) => matchesStreamKeyOptionText(value, label))) {
          continue;
        }

        const option = findStreamKeyOptionAncestor(element, root);
        if (option && !isDisabled(option) && isVisibleOutsidePanel(option)) {
          matches.push(option);
        }
      }
    }

    return uniqueElements(matches)
      .map((element) => ({
        element,
        textLength: elementTextVariants(element)
          .map((value) => normalize(value).length)
          .sort((a, b) => a - b)[0] || Number.MAX_SAFE_INTEGER,
        area: rectArea(element.getBoundingClientRect()),
      }))
      .sort((a, b) => a.textLength - b.textLength || a.area - b.area)
      .map((item) => item.element);
  }

  function findStreamKeyOptionAncestor(element, boundary) {
    let current = element;
    for (let depth = 0; depth < 10 && current; depth += 1) {
      if (isStreamKeyOptionElement(current)) return current;
      if (current === boundary) break;
      current = parentElement(current);
    }
    return null;
  }

  function isStreamKeyOptionElement(element) {
    if (!element?.tagName) return false;
    const tag = element.tagName.toLowerCase();
    const role = element.getAttribute?.("role");
    const tabIndex = element.getAttribute?.("tabindex");
    return (
      role === "option" ||
      role === "menuitem" ||
      role === "menuitemradio" ||
      tag === "button" ||
      tag === "ytcp-ve" ||
      tag.includes("item") ||
      (tabIndex !== null && tabIndex !== "-1")
    );
  }

  function matchesStreamKeyOptionText(value, label) {
    const actual = normalize(value);
    const expected = normalize(label);
    if (!actual || !expected) return false;
    const unit = `${escapeRegExp(expected)}(?:\\s*\\([^)]*\\))?`;
    const pattern = new RegExp(
      `^(?:${unit})(?:\\s+(?:${unit}))*$`,
      "i"
    );
    return pattern.test(actual);
  }

  function findClickableByText(patterns, options = {}) {
    const selector = options.selector || `${buttonSelector()},${optionSelector()}`;
    const root = options.root || document;
    const candidates = deepQueryAll(selector, root)
      .filter(isVisibleOutsidePanel)
      .filter((element) => !options.enabledOnly || !isDisabled(element));

    for (const candidate of candidates) {
      if (elementMatchesPatterns(candidate, patterns, options.exact)) {
        const clickable = closestClickable(candidate);
        if (!clickable || (options.enabledOnly && isDisabled(clickable))) continue;
        if (!isVisibleOutsidePanel(clickable)) continue;
        if (isExcludedElement(clickable, options)) continue;
        return clickable;
      }
    }

    const textElement = findTextElement(
      (text) => patterns.some((pattern) => matchesPattern(text, pattern, options.exact)),
      root
    );
    if (!textElement) return null;

    const clickable = closestClickable(textElement);
    if (!clickable || (options.enabledOnly && isDisabled(clickable))) return null;
    if (!isVisibleOutsidePanel(clickable)) return null;
    if (isExcludedElement(clickable, options)) return null;
    return clickable;
  }

  function isExcludedElement(element, options = {}) {
    const excluded = options.exclude || [];
    if (excluded.some((item) =>
      item && (
        item === element ||
        isComposedDescendantOf(element, item) ||
        isComposedDescendantOf(item, element)
      )
    )) {
      return true;
    }

    const excludedRoots = options.excludeRoots || [];
    return excludedRoots.some((root) => root && isComposedDescendantOf(element, root));
  }

  function isComposedDescendantOf(element, ancestor) {
    let current = element;
    for (let depth = 0; depth < 30 && current; depth += 1) {
      if (current === ancestor) return true;
      current = parentElement(current);
    }
    return false;
  }

  function findTextElement(pattern, root = document) {
    return findTextElements(pattern, root)[0] || null;
  }

  function findTextElements(pattern, root = document) {
    const elements = deepQueryAll("*", root)
      .filter(isVisibleOutsidePanel)
      .filter((element) => !["SCRIPT", "STYLE", "TEMPLATE"].includes(element.tagName))
      .filter((element) => {
        const text = textOf(element);
        if (!text) return false;
        return typeof pattern === "function" ? pattern(text) : matchesPattern(text, pattern);
      });

    return elements
      .map((element) => ({
        element,
        textLength: textOf(element).length,
        area: rectArea(element.getBoundingClientRect()),
      }))
      .sort((a, b) => a.textLength - b.textLength || a.area - b.area)
      .map((item) => item.element);
  }

  function hasVisibleText(pattern) {
    return Boolean(findTextElement(pattern));
  }

  function buttonSelector() {
    return [
      "button",
      '[role="button"]',
      "ytcp-button",
      "tp-yt-paper-button",
      "paper-button",
      "yt-button-shape",
      '[aria-label]',
    ].join(",");
  }

  function creationButtonSelector() {
    return [
      "button",
      '[role="button"]',
      "ytcp-button",
      "tp-yt-paper-button",
      "paper-button",
      "yt-button-shape",
    ].join(",");
  }

  function optionSelector() {
    return [
      '[role="radio"]',
      '[role="checkbox"]',
      '[role="option"]',
      '[role="menuitem"]',
      '[role="menuitemradio"]',
      "tp-yt-paper-radio-button",
      "ytcp-radio-button",
      "paper-radio-button",
      "tp-yt-paper-checkbox",
      "ytcp-checkbox",
      "ytcp-checkbox-lit",
      "paper-checkbox",
      "tp-yt-paper-item",
      "paper-item",
      "ytcp-ve",
      "button",
      '[role="button"]',
    ].join(",");
  }

  function controlSelector() {
    return [
      'input:not([type="hidden"])',
      "textarea",
      '[contenteditable]:not([contenteditable="false"])',
      '[role="textbox"]',
      "ytcp-social-suggestions-textbox",
      "ytcp-mention-textbox",
      "ytcp-form-input-container",
      "div#textbox",
    ].join(",");
  }

  function isEditableControl(element) {
    if (!element) return false;
    return isNativeTextControl(element) || isDirectEditableControl(element) || isCustomTextControl(element);
  }

  function isNativeTextControl(element) {
    if (!element) return false;
    return element.tagName === "INPUT" || element.tagName === "TEXTAREA";
  }

  function isDirectEditableControl(element) {
    if (!element) return false;
    return (
      element.isContentEditable ||
      element.getAttribute("role") === "textbox" ||
      (element.getAttribute("contenteditable") && element.getAttribute("contenteditable") !== "false") ||
      element.id === "textbox" ||
      ("value" in element && typeof element.value !== "undefined")
    );
  }

  function isCustomTextControl(element) {
    if (!element) return false;
    const tag = element.tagName;
    const lowerTag = tag.toLowerCase();
    return lowerTag.includes("textbox") || lowerTag.includes("form-input");
  }

  function isReadOnlyControl(element) {
    return Boolean(element.readOnly || element.getAttribute("aria-readonly") === "true" || element.getAttribute("contenteditable") === "false");
  }

  function controlAccessibleText(control) {
    const parts = [
      control.getAttribute("aria-label"),
      control.getAttribute("placeholder"),
      control.getAttribute("name"),
      control.getAttribute("id"),
      control.getAttribute("label"),
      control.getAttribute("title"),
    ];

    const labelledBy = control.getAttribute("aria-labelledby");
    if (labelledBy) {
      const controlRoot = control.getRootNode?.();
      for (const id of labelledBy.split(/\s+/)) {
        const label = controlRoot?.getElementById?.(id) || document.getElementById(id);
        if (label) parts.push(textOf(label));
      }
    }

    return normalize(parts.filter(Boolean).join(" "));
  }

  function setTextControl(control, value) {
    const element = normalizeControl(control);
    if (!element) throw new Error("Text control was not found.");

    element.scrollIntoView({ block: "center", inline: "nearest" });
    element.focus();

    if (isNativeTextControl(element)) {
      setNativeValue(element, value);
      element.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      element.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      element.blur();
      return;
    }

    if ("value" in element && typeof element.value !== "undefined") {
      element.value = value;
      element.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: value }));
      element.dispatchEvent(new Event("change", { bubbles: true, composed: true }));

      const nested = findNestedTextEditor(element);
      if (nested) {
        setTextControl(nested, value);
      }

      element.blur?.();
      return;
    }

    const nestedEditor = findNestedTextEditor(element);
    if (nestedEditor) {
      setTextControl(nestedEditor, value);
      element.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: value }));
      element.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      element.blur?.();
      return;
    }

    if (isDirectEditableControl(element)) {
      clickElement(element);
      element.focus();
      selectElementContents(element);
      document.execCommand("selectAll", false, null);
      document.execCommand("delete", false, null);
      document.execCommand("insertText", false, value);
      if (normalize(element.textContent) !== normalize(value)) {
        element.innerText = value;
        element.textContent = value;
      }
      element.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: value }));
      element.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      element.blur();
      return;
    }

    throw new Error(`Unsupported text control: ${element.tagName}`);
  }

  function nestedTextEditorSelector() {
    return [
      'input:not([type="hidden"])',
      "textarea",
      '[contenteditable]:not([contenteditable="false"])',
      '[role="textbox"]',
      "div#textbox",
    ].join(",");
  }

  function findNestedTextEditor(element) {
    if (!element) return null;

    return visibleControls(nestedTextEditorSelector(), element)
      .filter((control) => control !== element)
      .find((control) => isEditableControl(control) && !isReadOnlyControl(control)) || null;
  }

  function setNativeValue(element, value) {
    const prototype = element.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
    if (descriptor && descriptor.set) {
      descriptor.set.call(element, value);
    } else {
      element.value = value;
    }
  }

  function selectElementContents(element) {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function clickElement(element) {
    const target = closestClickable(element) || element;
    target.scrollIntoView({ block: "center", inline: "nearest" });
    target.focus?.();

    const point = centerPoint(target);
    const hitElement = point ? topmostElementOutsidePanel(point) : null;
    const activationTarget = (hitElement && (closestClickable(hitElement) || hitElement)) || target;

    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
      dispatchSyntheticMouseEvent(activationTarget, type, point);
    }

    if (typeof activationTarget.click === "function") {
      activationTarget.click();
    } else {
      dispatchSyntheticMouseEvent(activationTarget, "click", point);
    }
  }

  // Our own panel sits above Studio at the maximum z-index, so a naive hit test can
  // resolve to the panel and swallow a click meant for a button underneath it.
  function topmostElementOutsidePanel(point) {
    const stack = typeof document.elementsFromPoint === "function"
      ? document.elementsFromPoint(point.clientX, point.clientY)
      : [document.elementFromPoint(point.clientX, point.clientY)];

    for (const element of stack) {
      if (!(element instanceof Element)) continue;
      if (element.closest(`#${APP_ID}`) || element.closest(`#${LAUNCHER_ID}`)) continue;
      return element;
    }

    return null;
  }

  function centerPoint(element) {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;

    return {
      clientX: Math.min(Math.max(rect.left + rect.width / 2, 1), window.innerWidth - 1),
      clientY: Math.min(Math.max(rect.top + rect.height / 2, 1), window.innerHeight - 1),
    };
  }

  function dispatchSyntheticMouseEvent(target, type, point) {
    const init = {
      bubbles: true,
      cancelable: true,
      composed: true,
      button: 0,
      buttons: type === "pointerup" || type === "mouseup" || type === "click" ? 0 : 1,
      clientX: point?.clientX || 0,
      clientY: point?.clientY || 0,
      screenX: point?.clientX || 0,
      screenY: point?.clientY || 0,
    };

    try {
      if (type.startsWith("pointer") && typeof PointerEvent === "function") {
        target.dispatchEvent(new PointerEvent(type, {
          ...init,
          pointerId: 1,
          pointerType: "mouse",
          isPrimary: true,
        }));
        return;
      }

      target.dispatchEvent(new MouseEvent(type, init));
    } catch (_) {
      target.dispatchEvent(new Event(type, init));
    }
  }

  function closestClickable(element) {
    let current = element;
    for (let depth = 0; depth < 8 && current; depth += 1) {
      if (isClickable(current)) return current;
      current = parentElement(current);
    }
    return element;
  }

  function isClickable(element) {
    if (!element || !element.tagName) return false;
    const tag = element.tagName.toLowerCase();
    return (
      tag === "button" ||
      tag === "a" ||
      tag.includes("button") ||
      tag.includes("checkbox") ||
      tag.includes("radio") ||
      tag.includes("item") ||
      element.getAttribute("role") === "button" ||
      element.getAttribute("role") === "checkbox" ||
      element.getAttribute("role") === "radio" ||
      element.getAttribute("role") === "option" ||
      element.getAttribute("role") === "menuitem" ||
      element.getAttribute("role") === "menuitemradio" ||
      element.getAttribute("role") === "gridcell" ||
      element.hasAttribute("aria-haspopup")
    );
  }

  function isSelected(element) {
    let current = element;
    for (let depth = 0; depth < 5 && current; depth += 1) {
      const aria = current.getAttribute?.("aria-checked") || current.getAttribute?.("aria-selected");
      if (aria === "true") return true;
      if (aria === "false") return false;
      if ("checked" in current && typeof current.checked === "boolean") return current.checked;
      if (current.classList?.contains("checked") || current.classList?.contains("selected")) return true;
      current = parentElement(current);
    }
    return false;
  }

  function isDisabled(element) {
    return Boolean(
      element.disabled ||
      element.getAttribute?.("aria-disabled") === "true" ||
      element.hasAttribute?.("disabled")
    );
  }

  function isVisibleOutsidePanel(element) {
    if (!(element instanceof Element)) return false;
    if (element.closest(`#${APP_ID}`)) return false;
    if (element.closest(`#${LAUNCHER_ID}`)) return false;

    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
      return false;
    }

    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    return true;
  }

  function deepQueryAll(selector, root = document) {
    const results = [];
    const roots = [root || document];
    const seenRoots = new Set();

    while (roots.length) {
      const currentRoot = roots.shift();
      if (!currentRoot || seenRoots.has(currentRoot)) continue;
      seenRoots.add(currentRoot);

      try {
        if (currentRoot.matches?.(selector)) results.push(currentRoot);
        results.push(...currentRoot.querySelectorAll(selector));
        if (currentRoot.shadowRoot) roots.push(currentRoot.shadowRoot);
        for (const element of currentRoot.querySelectorAll("*")) {
          if (element.shadowRoot) roots.push(element.shadowRoot);
        }
      } catch (_) {
        // Some transient Studio roots can disappear during route changes.
      }
    }

    return uniqueElements(results);
  }

  function uniqueElements(elements) {
    const seen = new Set();
    return elements.filter((element) => {
      if (seen.has(element)) return false;
      seen.add(element);
      return true;
    });
  }

  async function waitFor(predicate, options = {}) {
    const timeout = options.timeout || WAIT.normal;
    const label = options.label || "condition";
    const end = Date.now() + timeout;
    let lastError = null;

    while (Date.now() < end) {
      checkStop();
      try {
        const value = await predicate();
        if (value) return value;
      } catch (error) {
        lastError = error;
      }
      await sleep(WAIT.poll);
    }

    if (lastError) throw lastError;
    throw new Error(`Timed out waiting for ${label}.`);
  }

  function detectCurrentEventUrl(previousUrl) {
    return detectEventUrlTransition(previousUrl, location.href);
  }

  function detectEventUrlTransition(previousUrl, currentUrl) {
    const previous = parseStudioLivestreamEventUrl(previousUrl);
    const current = parseStudioLivestreamEventUrl(currentUrl);
    if (!current) return null;
    if (previous && current.id === previous.id) return null;
    if (normalizeUrlWithoutQuery(currentUrl) === normalizeUrlWithoutQuery(previousUrl)) return null;
    return current.url;
  }

  function parseStudioLivestreamEventUrl(value) {
    try {
      const url = new URL(value, location.href);
      if (url.hostname.toLocaleLowerCase() !== "studio.youtube.com") return null;

      const match = url.pathname.match(/^\/video\/([^/?#]+)\/livestreaming\/?$/i);
      if (!match) return null;

      return {
        id: decodeURIComponent(match[1]),
        url: `${url.origin}/video/${match[1]}/livestreaming`,
      };
    } catch (_) {
      return null;
    }
  }

  function normalizeUrlWithoutQuery(value) {
    try {
      const url = new URL(value, location.href);
      return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
    } catch (_) {
      return normalize(value);
    }
  }

  function resolveStartDate(startTime) {
    if (startTime && startTime !== "now") {
      const parsed = new Date(startTime);
      if (!Number.isNaN(parsed.getTime())) return parsed;
    }

    const nearNow = new Date(Date.now() + 2 * 60 * 1000);
    nearNow.setSeconds(0, 0);
    const minutes = nearNow.getMinutes();
    const rounded = Math.ceil(minutes / 5) * 5;
    if (rounded >= 60) {
      nearNow.setHours(nearNow.getHours() + 1, 0, 0, 0);
    } else {
      nearNow.setMinutes(rounded);
    }
    return nearNow;
  }

  function formatNativeDate(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  function formatNativeTime(date) {
    const h = String(date.getHours()).padStart(2, "0");
    const m = String(date.getMinutes()).padStart(2, "0");
    return `${h}:${m}`;
  }

  function formatDateTimeLocal(date) {
    return `${formatNativeDate(date)}T${formatNativeTime(date)}`;
  }

  function formatDateText(date) {
    return new Intl.DateTimeFormat(undefined, {
      year: "numeric",
      month: "numeric",
      day: "numeric",
    }).format(date);
  }

  function formatTimeText(date) {
    return new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
  }

  function formatReadableDate(date) {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(date);
  }

  function formatReadableDateOnly(date) {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
    }).format(date);
  }

  function loadSettings() {
    const raw = storageGet(STORAGE_KEY, null);
    if (!raw) return { ...DEFAULT_SETTINGS };
    try {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    } catch (_) {
      return { ...DEFAULT_SETTINGS };
    }
  }

  function saveSettings(settings) {
    storageSet(STORAGE_KEY, JSON.stringify({ ...DEFAULT_SETTINGS, ...settings }));
  }

  function storageGet(key, fallback) {
    try {
      if (typeof GM_getValue === "function") return GM_getValue(key, fallback);
    } catch (_) {
      // Fall through to localStorage.
    }

    try {
      return window.localStorage.getItem(key) || fallback;
    } catch (_) {
      return fallback;
    }
  }

  function storageSet(key, value) {
    try {
      if (typeof GM_setValue === "function") {
        GM_setValue(key, value);
        return;
      }
    } catch (_) {
      // Fall through to localStorage.
    }

    try {
      window.localStorage.setItem(key, value);
    } catch (_) {
      // Ignore storage failures. The current run can still proceed.
    }
  }

  function updateRunButtons() {
    ui.start.disabled = state.running;
    ui.stop.disabled = !state.running;
    ui.miniStop.disabled = !state.running;
    ui.panel.classList.toggle("ylbc-running", state.running);
  }

  function requestStop() {
    if (!state.running) return;
    state.stopRequested = true;
    setStatus("Stopping after current action");
    log("Stop requested. The script will stop at the next safe checkpoint.", "warn");
  }

  function checkStop() {
    if (state.stopRequested) throw new Error("Stopped by user.");
  }

  function setStatus(status) {
    ui.status.textContent = status;
    ui.miniStatus.textContent = status;
    ui.miniStatus.title = status;
  }

  function log(message, level = "info") {
    const stamp = new Date().toLocaleTimeString();
    const prefix = level === "error" ? "ERROR" : level === "warn" ? "WARN" : "INFO";
    state.logLines.push(`[${stamp}] ${prefix}: ${message}`);
    renderLog();
  }

  function renderLog() {
    ui.log.textContent = state.logLines.slice(-250).join("\n");
    ui.log.scrollTop = ui.log.scrollHeight;
  }

  function exposeDebugHandle() {
    window.YTLiveBatchCreator = {
      state,
      start: startBatchFromPanel,
      stop: requestStop,
      showPanel,
      hidePanel,
      ensureLauncher,
      findScheduleStreamButton,
      clickCreationEntryPoint,
      findTitleControl,
      findFormControlByLabel,
      findScheduleDateTimeControls,
      setDateField,
      findDatePickerOption,
      findButtonInCreateStreamDialog,
      parseTimeMinutes,
      formatTimeForControl,
      findStreamKeyDropdown,
      findStreamKeyOption,
      streamKeyTriggerHasLabel,
      selectStreamKeyAfterCreate,
      setStreamLatency,
      findStreamLatencySection,
      setAutoStart,
      findAutoStartConfirmDialog,
      returnToLivestreamManagePage,
      isLivestreamManagePageReady,
      findLivestreamManageBackControl,
      detectCurrentEventUrl,
      detectEventUrlTransition,
      parseStudioLivestreamEventUrl,
      deepQueryAll,
    };
  }

  function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function textOf(element) {
    return normalize(
      [
        element.innerText,
        element.textContent,
        element.getAttribute?.("aria-label"),
        element.getAttribute?.("title"),
      ]
        .filter(Boolean)
        .join(" ")
    );
  }

  function elementTextVariants(element) {
    if (!element) return [];
    const values = [
      element.innerText,
      element.textContent,
      element.getAttribute?.("aria-label"),
      element.getAttribute?.("aria-valuetext"),
      element.getAttribute?.("title"),
    ]
      .map(normalize)
      .filter(Boolean);
    return [...new Set(values)];
  }

  function ariaLabelledByTextVariants(element) {
    const ids = normalize(element?.getAttribute?.("aria-labelledby")).split(/\s+/).filter(Boolean);
    if (!ids.length) return [];

    const root = element.getRootNode?.();
    const pieces = ids.map((id) => {
      const referenced = root?.getElementById?.(id) || document.getElementById(id);
      return normalize(referenced?.innerText || referenced?.textContent);
    }).filter(Boolean);
    return [...new Set([...pieces, normalize(pieces.join(" "))].filter(Boolean))];
  }

  function elementMatchesPatterns(element, patterns, exact) {
    return elementTextVariants(element)
      .some((value) => patterns.some((pattern) => matchesPattern(value, pattern, exact)));
  }

  function normalize(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function matchesPattern(text, pattern, exact) {
    const normalized = normalize(text);
    if (!normalized) return false;
    if (pattern instanceof RegExp) return pattern.test(normalized);
    if (typeof pattern === "function") return pattern(normalized);

    const target = normalize(pattern);
    return exact ? normalized === target : normalized.toLowerCase().includes(target.toLowerCase());
  }

  function parentElement(element) {
    if (!element) return null;
    if (element.parentElement) return element.parentElement;
    const root = element.getRootNode?.();
    return root?.host || null;
  }

  function distanceBetween(a, b) {
    const ax = a.left + a.width / 2;
    const ay = a.top + a.height / 2;
    const bx = b.left + b.width / 2;
    const by = b.top + b.height / 2;
    return Math.hypot(ax - bx, ay - by);
  }

  function horizontalOverlap(a, b) {
    return Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
  }

  function verticalCenterDelta(a, b) {
    return Math.abs((a.top + a.height / 2) - (b.top + b.height / 2));
  }

  function rectArea(rect) {
    return rect.width * rect.height;
  }

  function capitalize(value) {
    return value.charAt(0).toUpperCase() + value.slice(1);
  }

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function errorMessage(error) {
    if (!error) return "Unknown error.";
    if (error instanceof Error) return error.message;
    return String(error);
  }
})();
