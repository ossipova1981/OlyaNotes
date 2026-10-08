const KEY = "olyanotes-v1";
const SYNC_KEY = "olyanotes-sync-v1";

const root = document.getElementById("root");
let query = "";
let mobilePane = "list";
let mode = "write";
let focusTitle = false;
let syncStatus = "";
let syncBusy = false;
let openStylusAfterRender = false;
let syncSettings = { enabled: false, mode: "cloud", url: "", code: "olya-home", blobId: "" };

function uid() {
  return crypto.randomUUID();
}

function preferredTheme() {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function seed() {
  const personal = { id: uid(), name: "Личное", createdAt: Date.now() };
  const ideas = { id: uid(), name: "Идеи", createdAt: Date.now() };
  const now = Date.now();
  const welcome = {
    id: uid(),
    notebookId: personal.id,
    title: "Добро пожаловать",
    body: "Это ваши заметки.\n\n## Что уже есть\n\n- Блокноты, теги и избранное\n- Скриншоты и таблицы\n- Заметки стилусом и шаблоны планов\n- Синхронизация: Wi‑Fi дома или облако без компьютера\n\n## Быстрые клавиши\n\n- `Ctrl+N` — новая заметка\n- `Ctrl+K` — поиск\n\nНапишите мысль, откройте «Шаблон» или нажмите «Стилус».",
    tags: ["старт"],
    pinned: true,
    trashed: false,
    createdAt: now,
    updatedAt: now,
  };
  const list = {
    id: uid(),
    notebookId: ideas.id,
    title: "Что улучшить дальше",
    body: "- [x] Скриншоты и стилус\n- [x] Синхронизация по Wi‑Fi\n- [x] Шаблоны планов\n- [x] Облако без компьютера\n- [ ] Напоминания",
    tags: ["план"],
    pinned: false,
    trashed: false,
    createdAt: now - 1000,
    updatedAt: now - 1000,
  };
  return {
    notebooks: [personal, ideas],
    notes: [welcome, list],
    theme: preferredTheme(),
    view: { kind: "all" },
    selectedNoteId: welcome.id,
  };
}

function isNote(note) {
  return note && typeof note.id === "string" && typeof note.title === "string" && typeof note.body === "string" && Array.isArray(note.tags);
}

function load() {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) || "");
    const notebooks = Array.isArray(parsed.notebooks) ? parsed.notebooks.filter((item) => item && item.id && item.name) : [];
    const notes = Array.isArray(parsed.notes) ? parsed.notes.filter(isNote) : [];
    if (!notebooks.length) return seed();
    return {
      notebooks,
      notes,
      theme: parsed.theme === "dark" ? "dark" : "light",
      view: parsed.view && parsed.view.kind ? parsed.view : { kind: "all" },
      selectedNoteId: typeof parsed.selectedNoteId === "string" ? parsed.selectedNoteId : null,
    };
  } catch {
    return seed();
  }
}

let state = load();

function loadSyncSettings() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SYNC_KEY) || "{}");
    return {
      enabled: !!parsed.enabled,
      mode: parsed.mode === "wifi" ? "wifi" : "cloud",
      url: typeof parsed.url === "string" ? parsed.url : "",
      code: typeof parsed.code === "string" ? parsed.code : "olya-home",
      blobId: typeof parsed.blobId === "string" ? parsed.blobId : "",
    };
  } catch {
    return { enabled: false, mode: "cloud", url: "", code: "olya-home", blobId: "" };
  }
}

syncSettings = loadSyncSettings();

function saveSyncSettings() {
  localStorage.setItem(SYNC_KEY, JSON.stringify(syncSettings));
}

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
    if (syncSettings.enabled) scheduleSyncPush();
  } catch {
    window.alert("Места в браузере не хватило. Уберите лишний скриншот и попробуйте ещё раз.");
  }
}

function syncBaseUrl() {
  const typed = (syncSettings.url || "").trim().replace(/\/$/, "");
  if (typed) return typed;
  if (location.protocol.startsWith("http") && location.hostname !== "olyanotes.local") {
    return location.origin;
  }
  return "";
}

function mergeLists(a, b) {
  const map = new Map();
  [].concat(a || [], b || []).forEach((item) => {
    if (!item || !item.id) return;
    const prev = map.get(item.id);
    if (!prev || (item.updatedAt || 0) >= (prev.updatedAt || 0)) map.set(item.id, item);
  });
  return [...map.values()];
}

function mergeNotes(a, b) {
  const map = new Map();
  [].concat(a || [], b || []).forEach((note) => {
    if (!note || !note.id) return;
    const prev = map.get(note.id);
    if (!prev || (note.updatedAt || 0) >= (prev.updatedAt || 0)) {
      map.set(note.id, Object.assign({}, note, { images: Object.assign({}, (prev && prev.images) || {}, note.images || {}) }));
    } else if (note.images) {
      prev.images = Object.assign({}, note.images, prev.images || {});
    }
  });
  return [...map.values()];
}

function applyRemoteStore(remote) {
  const notebooks = mergeLists(state.notebooks, remote.notebooks);
  const notes = mergeNotes(state.notes, remote.notes);
  const selected = state.selectedNoteId;
  const view = state.view;
  const theme = state.theme;
  state.notebooks = notebooks;
  state.notes = notes.filter(isNote);
  state.selectedNoteId = state.notes.some((note) => note.id === selected)
    ? selected
    : (state.notes.find((note) => !note.trashed) || {}).id || null;
  state.view = view;
  state.theme = theme;
  localStorage.setItem(KEY, JSON.stringify(state));
}

function bytesToBase64(bytes) {
  let binary = "";
  bytes.forEach((b) => {
    binary += String.fromCharCode(b);
  });
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function deriveSyncKey(code) {
  const enc = new TextEncoder();
  const material = await crypto.subtle.importKey("raw", enc.encode(code), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: enc.encode("olyanotes-cloud-v1"), iterations: 120000, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function encryptPayload(payload, code) {
  const key = await deriveSyncKey(code);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(JSON.stringify(payload));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
  return {
    v: 1,
    iv: bytesToBase64(iv),
    data: bytesToBase64(new Uint8Array(cipher)),
    updatedAt: Date.now(),
  };
}

async function decryptPayload(envelope, code) {
  if (!envelope || !envelope.data || !envelope.iv) return { notebooks: [], notes: [] };
  const key = await deriveSyncKey(code);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(envelope.iv) },
    key,
    base64ToBytes(envelope.data),
  );
  return JSON.parse(new TextDecoder().decode(plain));
}

async function cloudGet(blobId) {
  const res = await fetch("https://jsonblob.com/api/jsonBlob/" + encodeURIComponent(blobId));
  if (res.status === 404) return null;
  if (!res.ok) throw new Error("Облако ответило " + res.status);
  return res.json();
}

async function cloudPut(blobId, body) {
  const res = await fetch("https://jsonblob.com/api/jsonBlob/" + encodeURIComponent(blobId), {
    method: "PUT",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error("Не удалось сохранить в облако");
  return res.json();
}

async function cloudCreate(body) {
  const res = await fetch("https://jsonblob.com/api/jsonBlob", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error("Не удалось создать облако");
  const location = res.headers.get("Location") || "";
  const match = location.match(/jsonBlob\/([^/?#]+)/i);
  const fromHeader = res.headers.get("X-jsonblob");
  const blobId = fromHeader || (match && match[1]) || "";
  if (!blobId) throw new Error("Облако не вернуло идентификатор");
  return blobId;
}

let syncTimer = null;
function scheduleSyncPush() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncNow(false).catch(() => {});
  }, 1200);
}

async function syncNow(showErrors) {
  if (syncBusy) return;
  if (!syncSettings.enabled) return;
  const code = (syncSettings.code || "").trim();
  if (!code) {
    if (showErrors) window.alert("Нужен общий секретный код.");
    return;
  }
  syncBusy = true;
  syncStatus = "Синхронизация…";
  try {
    if (syncSettings.mode === "cloud") {
      await syncCloud(code, showErrors);
    } else {
      await syncWifi(code, showErrors);
    }
    syncStatus =
      (syncSettings.mode === "cloud" ? "Облако" : "Wi‑Fi") +
      " · " +
      new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
    render();
  } catch (error) {
    syncStatus = syncSettings.mode === "cloud" ? "Нет связи с облаком" : "Нет связи с компьютером";
    if (showErrors) {
      window.alert((error && error.message) || "Синхронизация не удалась");
    }
  } finally {
    syncBusy = false;
  }
}

async function syncWifi(code, showErrors) {
  const url = syncBaseUrl();
  if (!url) {
    throw new Error(
      "Укажите адрес Asus, например http://192.168.0.15:5173\nИли выберите облачную синхронизацию.",
    );
  }
  const headers = { "Content-Type": "application/json", "X-Sync-Code": code };
  const remoteRes = await fetch(url + "/api/sync", { headers });
  if (!remoteRes.ok) throw new Error("Сервер Asus ответил " + remoteRes.status);
  const remote = await remoteRes.json();
  const notebooks = mergeLists(state.notebooks, remote.notebooks);
  const notes = mergeNotes(state.notes, remote.notes);
  const putRes = await fetch(url + "/api/sync", {
    method: "PUT",
    headers,
    body: JSON.stringify({ notebooks, notes }),
  });
  if (!putRes.ok) throw new Error("Не удалось отправить заметки на Asus");
  const saved = await putRes.json();
  applyRemoteStore(saved);
}

async function syncCloud(code, showErrors) {
  let blobId = (syncSettings.blobId || "").trim();
  let remote = { notebooks: [], notes: [] };
  if (blobId) {
    const envelope = await cloudGet(blobId);
    if (envelope) {
      try {
        remote = await decryptPayload(envelope, code);
      } catch (_) {
        throw new Error("Неверный код или повреждённые данные облака.");
      }
    }
  }
  const merged = {
    notebooks: mergeLists(state.notebooks, remote.notebooks),
    notes: mergeNotes(state.notes, remote.notes),
  };
  const envelope = await encryptPayload(merged, code);
  if (!blobId) {
    blobId = await cloudCreate(envelope);
    syncSettings.blobId = blobId;
    saveSyncSettings();
    if (showErrors) {
      const invite = blobId + "." + code;
      window.prompt(
        "Облако создано. Скопируйте этот ключ и введите его на телефоне и планшете:",
        invite,
      );
    }
  } else {
    await cloudPut(blobId, envelope);
  }
  applyRemoteStore(merged);
}

function openSyncDialog() {
  const choice = window.prompt(
    "Как синхронизировать?\n1 — облако (телефон, планшет и Asus без общей Wi‑Fi)\n2 — только домашний Asus по Wi‑Fi",
    syncSettings.mode === "wifi" ? "2" : "1",
  );
  if (choice === null) return;
  if (String(choice).trim() === "2") {
    const url = window.prompt(
      "Адрес Asus из чёрного окна Запуск.bat\nПример: http://192.168.0.15:5173",
      syncSettings.url || syncBaseUrl() || "",
    );
    if (url === null) return;
    const code = window.prompt("Общий код для всех устройств", syncSettings.code || "olya-home");
    if (code === null) return;
    syncSettings.mode = "wifi";
    syncSettings.url = url.trim().replace(/\/$/, "");
    syncSettings.code = code.trim() || "olya-home";
    syncSettings.enabled = true;
    saveSyncSettings();
    syncNow(true);
    return;
  }

  const existing = syncSettings.blobId ? syncSettings.blobId + "." + syncSettings.code : "";
  const invite = window.prompt(
    "Облачный ключ.\n\n• Новый ключ: придумайте секретное слово, например olya-rose\n• Уже есть ключ с другого устройства: вставьте его целиком (id.слово)",
    existing || syncSettings.code || "olya-home",
  );
  if (invite === null) return;
  const raw = invite.trim();
  if (raw.includes(".")) {
    const parts = raw.split(".");
    const blobId = parts.shift();
    const code = parts.join(".").trim();
    syncSettings.blobId = blobId;
    syncSettings.code = code || "olya-home";
  } else {
    syncSettings.blobId = "";
    syncSettings.code = raw || "olya-home";
  }
  syncSettings.mode = "cloud";
  syncSettings.enabled = true;
  saveSyncSettings();
  syncNow(true);
}

const PLAN_TEMPLATES = [
  {
    id: "week",
    label: "Неделя",
    title: "План на неделю",
    tags: ["план", "неделя"],
    pinned: true,
    body: `## План на неделю

### Понедельник
- [ ] 
### Вторник
- [ ] 
### Среда
- [ ] 
### Четверг
- [ ] 
### Пятница
- [ ] 
### Суббота
- [ ] 
### Воскресенье
- [ ] 

## Главное за неделю
- [ ] 
`,
  },
  {
    id: "day",
    label: "День",
    title: "План на день",
    tags: ["план", "день"],
    pinned: true,
    body: `## Сегодня

### Утро
- [ ] 
### День
- [ ] 
### Вечер
- [ ] 

## Настроение / заметка


`,
  },
  {
    id: "draw",
    label: "Рисовать",
    title: "Хочу нарисовать",
    tags: ["план", "рисунок"],
    pinned: false,
    body: `## Идеи для рисунка
- [ ] 
- [ ] 
- [ ] 

## Материалы
- [ ] карандаш
- [ ] маркеры
- [ ] акварель

## Готово
- [ ] скетч
- [ ] чистовик
- [ ] сохранить в «Рисунки»
`,
  },
  {
    id: "shop",
    label: "Покупки",
    title: "Список покупок",
    tags: ["план", "покупки"],
    pinned: false,
    body: `## Купить
- [ ] 
- [ ] 
- [ ] 

## Для творчества
- [ ] 
`,
  },
  {
    id: "goals",
    label: "Цели",
    title: "Цели месяца",
    tags: ["план", "цели"],
    pinned: true,
    body: `## Цели месяца

### Творчество
- [ ] 
### Учёба / дела
- [ ] 
### Для себя
- [ ] 

## Маленькие шаги на этой неделе
- [ ] 
- [ ] 
`,
  },
];

function checklistProgress(body) {
  const total = (String(body || "").match(/^\s*[-*+]\s+\[[ xX]\]/gm) || []).length;
  if (!total) return null;
  const done = (String(body || "").match(/^\s*[-*+]\s+\[[xX]\]/gm) || []).length;
  return { done, total };
}

function openTemplatePicker() {
  const existing = document.getElementById("template-pad");
  if (existing) existing.remove();
  const pad = document.createElement("div");
  pad.id = "template-pad";
  pad.innerHTML = `<div class="template-card">
      <header><strong>Шаблоны планов</strong><button type="button" data-template-close>Закрыть</button></header>
      <div class="template-grid">
        ${PLAN_TEMPLATES.map((item) => `<button type="button" data-template="${item.id}"><strong>${esc(item.label)}</strong><span>${esc(item.title)}</span></button>`).join("")}
      </div>
    </div>`;
  document.body.appendChild(pad);
  pad.querySelector("[data-template-close]").addEventListener("click", () => pad.remove());
  pad.addEventListener("click", (event) => {
    if (event.target === pad) pad.remove();
  });
  pad.querySelectorAll("[data-template]").forEach((button) => {
    button.addEventListener("click", () => {
      pad.remove();
      createNote({ template: button.dataset.template });
    });
  });
}

function insertDataUrl(noteId, dataUrl, alt, cursor) {
  const fresh = state.notes.find((item) => item.id === noteId);
  if (!fresh || fresh.trashed) return;
  const id = uid().replace(/-/g, "").slice(0, 10);
  const images = Object.assign({}, fresh.images, { [id]: dataUrl });
  const token = `![${alt || "рисунок"}](img:${id})`;
  const at = Math.max(0, Math.min(cursor == null ? fresh.body.length : cursor, fresh.body.length));
  const prefix = fresh.body.slice(0, at);
  const suffix = fresh.body.slice(at);
  const before = prefix && !prefix.endsWith("\n") ? "\n" : "";
  const after = suffix && !suffix.startsWith("\n") ? "\n" : "";
  updateNote(noteId, { body: prefix + before + token + after + suffix, images });
  render();
}

function openStylusPad(noteId) {
  const note = state.notes.find((item) => item.id === noteId);
  if (!note || note.trashed) return;
  const existing = document.getElementById("stylus-pad");
  if (existing) existing.remove();

  const brushes = [
    { id: "pen", label: "Ручка", tip: "Чёткая линия для письма" },
    { id: "fountain", label: "Перо", tip: "Толщина от нажима" },
    { id: "calligraphy", label: "Каллиграфия", tip: "Красивый наклонный штрих" },
    { id: "marker", label: "Маркер", tip: "Полупрозрачный выделитель" },
    { id: "pencil", label: "Карандаш", tip: "Мягкий штрих с зерном" },
    { id: "charcoal", label: "Уголь", tip: "Глубокий рыхлый след" },
    { id: "brush", label: "Кисть", tip: "Мягкая художественная кисть" },
    { id: "watercolor", label: "Акварель", tip: "Прозрачные пятна как вода" },
    { id: "pastel", label: "Пастель", tip: "Нежный бархатный штрих" },
    { id: "neon", label: "Неон", tip: "Светящийся контур" },
    { id: "sparkle", label: "Блёстки", tip: "Игристые искорки" },
    { id: "inkwash", label: "Тушь", tip: "Мягкие восточные мазки" },
    { id: "eraser", label: "Ластик", tip: "Стирает активный слой" },
  ];
  const palettes = {
    ink: ["#1c1917", "#44403c", "#78716c", "#a8a29e", "#1d4ed8", "#b42318", "#ffffff"],
    warm: ["#1c1917", "#7c2d12", "#c2410c", "#e07a3d", "#f59e0b", "#fde68a", "#fff7ed"],
    pastel: ["#334155", "#fb7185", "#f9a8d4", "#c4b5fd", "#93c5fd", "#6ee7b7", "#fef3c7"],
    sunset: ["#0f172a", "#7c3aed", "#db2777", "#f97316", "#fbbf24", "#fda4af", "#fff1f2"],
  };
  const layersMeta = [
    { id: "sketch", label: "Набросок" },
    { id: "ink", label: "Чистовик" },
  ];

  const pad = document.createElement("div");
  pad.id = "stylus-pad";
  pad.innerHTML = `<div class="stylus-card rich">
      <header class="stylus-toolbar">
        <strong>Студия</strong>
        <div class="brush-row" role="toolbar" aria-label="Кисти">
          ${brushes.map((brush, index) => `<button type="button" class="brush${index === 0 ? " active" : ""}" data-brush="${brush.id}" title="${brush.tip}">${brush.label}</button>`).join("")}
        </div>
        <div class="layer-row" role="toolbar" aria-label="Слои">
          ${layersMeta.map((layer, index) => `<button type="button" class="layer-btn${index === 1 ? " active" : ""}" data-layer="${layer.id}">${layer.label}</button>`).join("")}
        </div>
        <div class="grid-row" role="toolbar" aria-label="Сетка">
          <button type="button" class="grid-btn active" data-grid="none">Без сетки</button>
          <button type="button" class="grid-btn" data-grid="square">Клетка</button>
          <button type="button" class="grid-btn" data-grid="dots">Точки</button>
        </div>
        <div class="palette-row" role="toolbar" aria-label="Палитры">
          <button type="button" class="palette-btn active" data-palette="ink">Чернила</button>
          <button type="button" class="palette-btn" data-palette="warm">Тёплая</button>
          <button type="button" class="palette-btn" data-palette="pastel">Пастель</button>
          <button type="button" class="palette-btn" data-palette="sunset">Закат</button>
        </div>
        <label>Толщина <input id="stylus-size" type="range" min="1" max="48" value="6"></label>
        <label>Цвет <input id="stylus-color" type="color" value="#1c1917"></label>
        <div class="swatches" id="stylus-swatches"></div>
        <button type="button" data-stylus-undo>Отменить</button>
        <button type="button" data-stylus-clear>Очистить слой</button>
        <button type="button" data-stylus-export>PNG</button>
        <button type="button" class="primary" data-stylus-save>В заметку</button>
        <button type="button" data-stylus-close>Закрыть</button>
      </header>
      <div class="stylus-stage">
        <canvas id="stylus-bg"></canvas>
        <canvas id="stylus-sketch"></canvas>
        <canvas id="stylus-ink"></canvas>
      </div>
      <p id="stylus-tip">Пишите пальцем или S Pen. Слой: чистовик. Кисть: ручка.</p>
    </div>`;
  document.body.appendChild(pad);

  const bg = document.getElementById("stylus-bg");
  const sketch = document.getElementById("stylus-sketch");
  const ink = document.getElementById("stylus-ink");
  const layers = { sketch, ink };
  let activeLayer = "ink";
  let brush = "pen";
  let grid = "none";
  let last = null;
  let drawing = false;
  let primed = false;
  const history = [];
  const tip = document.getElementById("stylus-tip");
  const colorInput = document.getElementById("stylus-color");
  const sizeInput = document.getElementById("stylus-size");
  const paper = () => getComputedStyle(document.documentElement).getPropertyValue("--paper").trim() || "#fffdf8";
  const activeCanvas = () => layers[activeLayer];
  const activeCtx = () => activeCanvas().getContext("2d");

  const paintSwatches = (name) => {
    const box = document.getElementById("stylus-swatches");
    const colors = palettes[name] || palettes.ink;
    box.innerHTML = colors.map((color) => `<button type="button" class="swatch" data-color="${color}" style="--sw:${color}" title="${color}"></button>`).join("");
    box.querySelectorAll("[data-color]").forEach((button) => {
      button.addEventListener("click", () => {
        colorInput.value = button.dataset.color;
      });
    });
    colorInput.value = colors[0];
  };
  paintSwatches("ink");

  const drawGrid = () => {
    const ctx = bg.getContext("2d");
    const w = bg.width;
    const h = bg.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = paper();
    ctx.fillRect(0, 0, w, h);
    if (grid === "none") return;
    const step = Math.max(18, Math.round(Math.min(w, h) / 28));
    ctx.save();
    ctx.strokeStyle = "rgba(120, 113, 108, 0.28)";
    ctx.fillStyle = "rgba(120, 113, 108, 0.45)";
    if (grid === "square") {
      ctx.lineWidth = 1;
      for (let x = step; x < w; x += step) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
      }
      for (let y = step; y < h; y += step) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }
    } else if (grid === "dots") {
      for (let x = step; x < w; x += step) {
        for (let y = step; y < h; y += step) {
          ctx.beginPath();
          ctx.arc(x, y, 1.4, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    ctx.restore();
  };

  const resize = () => {
    const stage = pad.querySelector(".stylus-stage");
    const rect = stage.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    const w = Math.max(320, Math.floor(rect.width * ratio));
    const h = Math.max(280, Math.floor(rect.height * ratio));
    [bg, sketch, ink].forEach((canvas) => {
      let prev = null;
      if (primed && canvas !== bg) {
        try {
          prev = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
        } catch (_) {}
      }
      canvas.width = w;
      canvas.height = h;
      if (canvas !== bg) {
        const ctx = canvas.getContext("2d");
        ctx.clearRect(0, 0, w, h);
        if (prev) {
          try {
            ctx.putImageData(prev, 0, 0);
          } catch (_) {}
        }
      }
    });
    drawGrid();
    primed = true;
  };
  requestAnimationFrame(resize);
  window.addEventListener("resize", resize);

  const snapshot = () => ({
    sketch: sketch.getContext("2d").getImageData(0, 0, sketch.width, sketch.height),
    ink: ink.getContext("2d").getImageData(0, 0, ink.width, ink.height),
  });
  const restore = (shot) => {
    if (!shot) return;
    sketch.getContext("2d").putImageData(shot.sketch, 0, 0);
    ink.getContext("2d").putImageData(shot.ink, 0, 0);
  };
  const pushHistory = () => {
    history.push(snapshot());
    if (history.length > 35) history.shift();
  };

  const updateTip = () => {
    const brushMeta = brushes.find((item) => item.id === brush);
    const layerMeta = layersMeta.find((item) => item.id === activeLayer);
    tip.textContent = `S Pen или палец. Слой: ${layerMeta.label.toLowerCase()}. Кисть: ${brushMeta.label.toLowerCase()}. ${brushMeta.tip}`;
  };

  const setBrush = (id) => {
    brush = id;
    pad.querySelectorAll("[data-brush]").forEach((button) => button.classList.toggle("active", button.dataset.brush === id));
    if (id === "marker" || id === "watercolor" || id === "pastel") sizeInput.value = String(Math.max(14, Number(sizeInput.value) || 14));
    if (id === "eraser" || id === "charcoal") sizeInput.value = String(Math.max(16, Number(sizeInput.value) || 16));
    if (id === "pen" || id === "fountain" || id === "calligraphy") sizeInput.value = "6";
    if (id === "sparkle") sizeInput.value = "10";
    updateTip();
  };

  const hexToRgb = (hex) => {
    const value = hex.replace("#", "");
    const full = value.length === 3 ? value.split("").map((c) => c + c).join("") : value;
    return {
      r: parseInt(full.slice(0, 2), 16),
      g: parseInt(full.slice(2, 4), 16),
      b: parseInt(full.slice(4, 6), 16),
    };
  };

  const pos = (event) => {
    const rect = ink.getBoundingClientRect();
    const src = event.touches && event.touches[0] ? event.touches[0] : event;
    const pressure = typeof event.pressure === "number" && event.pressure > 0 ? event.pressure : 0.55;
    return {
      x: ((src.clientX - rect.left) / rect.width) * ink.width,
      y: ((src.clientY - rect.top) / rect.height) * ink.height,
      pressure,
    };
  };

  const strokeSegment = (from, to) => {
    const ctx = activeCtx();
    const base = Number(sizeInput.value) || 6;
    const color = colorInput.value;
    const rgb = hexToRgb(color);
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dist = Math.max(1, Math.hypot(dx, dy));
    ctx.save();

    if (brush === "eraser") {
      ctx.globalCompositeOperation = "destination-out";
      ctx.strokeStyle = "rgba(0,0,0,1)";
      ctx.lineWidth = Math.max(8, base * (0.8 + to.pressure));
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
      ctx.restore();
      return;
    }

    ctx.globalCompositeOperation = "source-over";
    if (brush === "pen") {
      ctx.strokeStyle = color;
      ctx.globalAlpha = 1;
      ctx.lineWidth = Math.max(1.2, base * (0.55 + to.pressure * 0.35));
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
    } else if (brush === "fountain") {
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.92;
      ctx.lineWidth = Math.max(1, base * (0.25 + to.pressure * 1.7));
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
    } else if (brush === "calligraphy") {
      const angle = Math.atan2(dy, dx) + Math.PI / 5;
      const width = Math.max(1.5, base * (0.4 + to.pressure * 1.3));
      ctx.translate((from.x + to.x) / 2, (from.y + to.y) / 2);
      ctx.rotate(angle);
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.95;
      ctx.beginPath();
      ctx.ellipse(0, 0, Math.max(dist / 2, 1), width / 2, 0, 0, Math.PI * 2);
      ctx.fill();
    } else if (brush === "marker") {
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.26;
      ctx.lineWidth = Math.max(8, base * 1.8);
      ctx.lineCap = "butt";
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
    } else if (brush === "pencil" || brush === "charcoal") {
      const grain = brush === "charcoal" ? 0.7 : 0.35;
      const alpha = brush === "charcoal" ? 0.28 : 0.18;
      const steps = Math.ceil(dist / 1.6);
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const x = from.x + dx * t + (Math.random() - 0.5) * base * grain;
        const y = from.y + dy * t + (Math.random() - 0.5) * base * grain;
        ctx.globalAlpha = alpha + to.pressure * 0.4;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(x, y, Math.max(0.7, base * (brush === "charcoal" ? 0.28 : 0.16) * (0.5 + Math.random())), 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (brush === "brush" || brush === "inkwash") {
      const steps = Math.ceil(dist / 2);
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const x = from.x + dx * t;
        const y = from.y + dy * t;
        const radius = Math.max(1.8, base * (0.4 + to.pressure) * (brush === "inkwash" ? 1.15 : 0.9) * (0.65 + Math.random() * 0.5));
        const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
        gradient.addColorStop(0, `rgba(${rgb.r},${rgb.g},${rgb.b},${brush === "inkwash" ? 0.55 : 0.7})`);
        gradient.addColorStop(1, `rgba(${rgb.r},${rgb.g},${rgb.b},0)`);
        ctx.globalAlpha = 0.2 + to.pressure * 0.3;
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (brush === "watercolor") {
      const steps = Math.ceil(dist / 2.4);
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const x = from.x + dx * t + (Math.random() - 0.5) * base * 0.4;
        const y = from.y + dy * t + (Math.random() - 0.5) * base * 0.4;
        const radius = Math.max(3, base * (0.8 + to.pressure) * (0.8 + Math.random() * 0.7));
        const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
        gradient.addColorStop(0, `rgba(${rgb.r},${rgb.g},${rgb.b},0.22)`);
        gradient.addColorStop(1, `rgba(${rgb.r},${rgb.g},${rgb.b},0)`);
        ctx.globalAlpha = 1;
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (brush === "pastel") {
      const steps = Math.ceil(dist / 1.8);
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const x = from.x + dx * t + (Math.random() - 0.5) * base * 0.5;
        const y = from.y + dy * t + (Math.random() - 0.5) * base * 0.5;
        ctx.globalAlpha = 0.16 + to.pressure * 0.25;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.ellipse(x, y, Math.max(2, base * 0.45), Math.max(1.2, base * 0.22), Math.random() * Math.PI, 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (brush === "neon") {
      ctx.lineCap = "round";
      ctx.strokeStyle = color;
      ctx.shadowColor = color;
      ctx.shadowBlur = 18 + base;
      ctx.globalAlpha = 0.9;
      ctx.lineWidth = Math.max(1.5, base * (0.35 + to.pressure * 0.5));
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = "#ffffff";
      ctx.globalAlpha = 0.75;
      ctx.lineWidth = Math.max(0.8, base * 0.18);
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
    } else if (brush === "sparkle") {
      const steps = Math.ceil(dist / 3);
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const x = from.x + dx * t + (Math.random() - 0.5) * base;
        const y = from.y + dy * t + (Math.random() - 0.5) * base;
        const size = 1 + Math.random() * base * 0.35;
        ctx.globalAlpha = 0.35 + Math.random() * 0.55;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(x, y - size);
        ctx.lineTo(x + size * 0.35, y);
        ctx.lineTo(x, y + size);
        ctx.lineTo(x - size * 0.35, y);
        ctx.closePath();
        ctx.fill();
        if (Math.random() > 0.7) {
          ctx.fillStyle = "#ffffff";
          ctx.globalAlpha = 0.8;
          ctx.fillRect(x - 0.6, y - 0.6, 1.2, 1.2);
        }
      }
    }
    ctx.restore();
  };

  const compose = (mime, quality) => {
    const out = document.createElement("canvas");
    out.width = bg.width;
    out.height = bg.height;
    const ctx = out.getContext("2d");
    ctx.drawImage(bg, 0, 0);
    ctx.drawImage(sketch, 0, 0);
    ctx.drawImage(ink, 0, 0);
    return out.toDataURL(mime, quality);
  };

  const startDraw = (event) => {
    event.preventDefault();
    ink.setPointerCapture(event.pointerId);
    pushHistory();
    drawing = true;
    last = pos(event);
    strokeSegment(last, last);
  };
  const moveDraw = (event) => {
    if (!drawing) return;
    event.preventDefault();
    const p = pos(event);
    if (last) strokeSegment(last, p);
    last = p;
  };
  const endDraw = (event) => {
    if (!drawing) return;
    event.preventDefault();
    drawing = false;
    last = null;
    try {
      ink.releasePointerCapture(event.pointerId);
    } catch (_) {}
  };

  ink.addEventListener("pointerdown", startDraw);
  ink.addEventListener("pointermove", moveDraw);
  ink.addEventListener("pointerup", endDraw);
  ink.addEventListener("pointercancel", endDraw);

  pad.querySelectorAll("[data-brush]").forEach((button) => button.addEventListener("click", () => setBrush(button.dataset.brush)));
  pad.querySelectorAll("[data-layer]").forEach((button) => {
    button.addEventListener("click", () => {
      activeLayer = button.dataset.layer;
      pad.querySelectorAll("[data-layer]").forEach((item) => item.classList.toggle("active", item.dataset.layer === activeLayer));
      updateTip();
    });
  });
  pad.querySelectorAll("[data-grid]").forEach((button) => {
    button.addEventListener("click", () => {
      grid = button.dataset.grid;
      pad.querySelectorAll("[data-grid]").forEach((item) => item.classList.toggle("active", item.dataset.grid === grid));
      drawGrid();
    });
  });
  pad.querySelectorAll("[data-palette]").forEach((button) => {
    button.addEventListener("click", () => {
      pad.querySelectorAll("[data-palette]").forEach((item) => item.classList.toggle("active", item === button));
      paintSwatches(button.dataset.palette);
    });
  });
  pad.querySelector("[data-stylus-undo]").addEventListener("click", () => restore(history.pop()));
  pad.querySelector("[data-stylus-clear]").addEventListener("click", () => {
    pushHistory();
    const ctx = activeCtx();
    ctx.clearRect(0, 0, activeCanvas().width, activeCanvas().height);
  });
  pad.querySelector("[data-stylus-export]").addEventListener("click", () => {
    const link = document.createElement("a");
    link.href = compose("image/png");
    link.download = "olyanotes-drawing.png";
    link.click();
  });
  pad.querySelector("[data-stylus-close]").addEventListener("click", () => {
    window.removeEventListener("resize", resize);
    pad.remove();
  });
  pad.querySelector("[data-stylus-save]").addEventListener("click", () => {
    const dataUrl = compose("image/jpeg", 0.92);
    window.removeEventListener("resize", resize);
    pad.remove();
    const fresh = state.notes.find((item) => item.id === noteId);
    if (fresh && !fresh.tags.includes("рисунок")) {
      updateNote(noteId, { tags: fresh.tags.concat("рисунок") });
    }
    insertDataUrl(noteId, dataUrl, "рисунок", (fresh && fresh.body.length) || 0);
  });
  updateTip();
}

function compressImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const max = 1280;
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const width = Math.max(1, Math.round(img.width * scale));
      const height = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(img, 0, 0, width, height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL("image/jpeg", 0.76));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("image"));
    };
    img.src = url;
  });
}

function imageToken(alt, id, size) {
  const mark = size === "m" || size === "s" ? `:${size}` : "";
  return `![${alt || "скриншот"}](img:${id}${mark})`;
}

function sizeControls(id, size) {
  const options = [
    ["l", "Оригинал"],
    ["m", "Меньше"],
    ["s", "Ещё меньше"],
  ];
  return `<div class="sizes">${options
    .map(
      ([key, label]) =>
        `<button type="button" data-resize="${key}" data-target="${id}" class="${size === key ? "active" : ""}">${label}</button>`,
    )
    .join("")}</div>`;
}

function figureHtml(id, alt, src, size, removable) {
  const safeSize = size === "m" || size === "s" ? size : "l";
  return `<figure class="shot shot-${safeSize}" data-image-id="${id}" data-alt="${esc(alt)}" data-shot-size="${safeSize}">${sizeControls(id, safeSize)}<div class="shot-frame"><img src="${src}" alt="${esc(alt)}">${
    removable ? `<button type="button" class="remove-shot" data-remove-image="${id}" title="Убрать скриншот">×</button>` : ""
  }</div></figure>`;
}

function writeBlocks(note) {
  const images = note.images || {};
  const parts = [];
  let text = [];
  const flush = () => {
    parts.push({ type: "text", value: text.join("\n") });
    text = [];
  };
  note.body.split("\n").forEach((line) => {
    const image = line.match(/^!\[([^\]]*)\]\(img:([a-f0-9]+)(?::([lms]))?\)$/);
    const src = image && safeImage(images[image[2]]);
    if (image && src) {
      if (text.length) flush();
      else if (!parts.length) parts.push({ type: "text", value: "" });
      parts.push({ type: "image", id: image[2], alt: image[1], src, size: image[3] || "l" });
    } else {
      text.push(line);
    }
  });
  if (text.length || !parts.length) flush();
  if (parts.length && parts[parts.length - 1].type === "image") parts.push({ type: "text", value: "" });
  return parts
    .map((part, index) => {
      if (part.type === "text") {
        const placeholder = index === 0 ? ' placeholder="Начните писать. Скриншот можно вставить через Ctrl+V."' : "";
        return `<textarea class="chunk" id="chunk-${index}"${placeholder} ${note.trashed ? "disabled" : ""}>${esc(part.value)}</textarea>`;
      }
      return figureHtml(part.id, part.alt, part.src, part.size, !note.trashed);
    })
    .join("");
}

function readWritingBody() {
  const nodes = [...document.querySelectorAll(".writing > .chunk, .writing > .shot")];
  return nodes
    .map((node) => {
      if (node.classList.contains("chunk")) return node.value;
      return imageToken(node.dataset.alt || "скриншот", node.dataset.imageId, node.dataset.shotSize);
    })
    .join("\n");
}

function insertImageFile(noteId, file, cursor) {
  const current = state.notes.find((item) => item.id === noteId);
  if (!current || current.trashed) return;
  compressImage(file)
    .then((dataUrl) => insertDataUrl(noteId, dataUrl, "скриншот", cursor))
    .catch(() => window.alert("Не получилось вставить скриншот."));
}

function esc(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function inline(value) {
  return value
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");
}

function safeImage(src) {
  return typeof src === "string" && /^data:image\/(?:jpeg|png|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(src) ? src : "";
}

function renderMarkdown(source, images) {
  const lines = esc(source).split("\n");
  let html = "";
  let list = false;
  const close = () => {
    if (list) html += "</ul>";
    list = false;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const task = line.match(/^[-*+] \[([ xX])\] (.*)$/);
    const bullet = line.match(/^[-*+] (.*)$/);
    const heading = line.match(/^(#{1,3}) (.*)$/);
    const image = line.match(/^!\[([^\]]*)\]\(img:([a-f0-9]+)(?::([lms]))?\)$/);
    const tableRow = /^\|.*\|$/.test(line.trim());
    if (tableRow) {
      close();
      const rows = [];
      while (i < lines.length && /^\|.*\|$/.test(lines[i].trim())) {
        const raw = lines[i].trim().replace(/^\|/, "").replace(/\|$/, "");
        const cells = raw.split("|").map((cell) => cell.trim());
        const rule = cells.every((cell) => /^:?-{3,}:?$/.test(cell));
        if (!rule) rows.push(cells);
        i += 1;
      }
      i -= 1;
      if (rows.length) {
        const head = rows[0].map((cell) => `<th>${inline(cell)}</th>`).join("");
        const body = rows
          .slice(1)
          .map((row) => `<tr>${row.map((cell) => `<td>${inline(cell)}</td>`).join("")}</tr>`)
          .join("");
        html += `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
      }
    } else if (image) {
      close();
      const src = safeImage(images && images[image[2]]);
      if (src) html += figureHtml(image[2], image[1], src, image[3] || "l", true);
    } else if (heading) {
      close();
      html += `<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`;
    } else if (task) {
      if (!list) {
        html += "<ul>";
        list = true;
      }
      const checked = task[1].toLowerCase() === "x" ? " checked" : "";
      html += `<li><label><input type="checkbox" data-task="1"${checked}> ${inline(task[2])}</label></li>`;
    } else if (bullet) {
      if (!list) {
        html += "<ul>";
        list = true;
      }
      html += `<li>${inline(bullet[1])}</li>`;
    } else if (line.startsWith("&gt; ")) {
      close();
      html += `<blockquote>${inline(line.slice(5))}</blockquote>`;
    } else if (!line.trim()) {
      close();
    } else {
      close();
      html += `<p>${inline(line)}</p>`;
    }
  }
  close();
  return html || "<p>Пустая заметка</p>";
}

function toggleTask(body, index) {
  let seen = 0;
  return body.replace(/^(\s*[-*+]\s+\[)([ xX])(\])/gm, (match, open, mark, close) => {
    if (seen++ !== index) return match;
    return open + (mark.toLowerCase() === "x" ? " " : "x") + close;
  });
}

function snippet(body) {
  const line = body
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+\[[ xX]\]\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^!\[[^\]]*\]\(img:[a-f0-9]+(?::[lms])?\)$/gm, "")
    .replace(/[`*_>#]/g, "")
    .split("\n")
    .map((part) => part.trim())
    .find(Boolean);
  if (line) return line;
  if (/!\[[^\]]*\]\(img:[a-f0-9]+(?::[lms])?\)/.test(body)) return "Скриншот";
  return "Пустая заметка";
}

function formatWhen(timestamp) {
  const date = new Date(timestamp);
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  if (day === start) return date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  if (day === start - 86400000) return "вчера";
  return date.toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
}

function wordLabel(words) {
  const mod10 = words % 10;
  const mod100 = words % 100;
  if (mod10 === 1 && mod100 !== 11) return "слово";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "слова";
  return "слов";
}

function noteHasDrawing(note) {
  return !!(note && (note.tags.includes("рисунок") || /!\[[^\]]*\]\(img:[a-f0-9]+/.test(note.body || "")));
}

function matchesView(note, view) {
  if (view.kind === "trash") return note.trashed;
  if (note.trashed) return false;
  if (view.kind === "all") return true;
  if (view.kind === "pinned") return note.pinned;
  if (view.kind === "drawings") return noteHasDrawing(note);
  if (view.kind === "tag") return note.tags.includes(view.name);
  return note.notebookId === view.id;
}

function visibleNotes() {
  const q = query.trim().toLowerCase();
  return state.notes
    .filter((note) => matchesView(note, state.view))
    .filter((note) => {
      if (!q) return true;
      return note.title.toLowerCase().includes(q) || note.body.toLowerCase().includes(q) || note.tags.some((tag) => tag.toLowerCase().includes(q));
    })
    .sort((a, b) => {
      if (state.view.kind !== "trash" && a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return b.updatedAt - a.updatedAt;
    });
}

function viewLabel() {
  if (state.view.kind === "all") return "Все заметки";
  if (state.view.kind === "pinned") return "Избранное";
  if (state.view.kind === "drawings") return "Рисунки";
  if (state.view.kind === "trash") return "Корзина";
  if (state.view.kind === "tag") return "#" + state.view.name;
  const notebook = state.notebooks.find((item) => item.id === state.view.id);
  return notebook ? notebook.name : "Блокнот";
}

function count(pick) {
  return state.notes.filter(pick).length;
}

function selectedNote(notes) {
  return notes.find((note) => note.id === state.selectedNoteId) || null;
}

function updateNote(id, partial) {
  state.notes = state.notes.map((note) => (note.id === id ? Object.assign({}, note, partial, { updatedAt: Date.now() }) : note));
}

function activeNotebookId(note) {
  if (state.view.kind === "notebook") return state.view.id;
  if (note && !note.trashed) return note.notebookId;
  return state.notebooks[0] && state.notebooks[0].id;
}

function createNote(options) {
  const notebookId = activeNotebookId(state.notes.find((note) => note.id === state.selectedNoteId));
  if (!notebookId) return;
  const now = Date.now();
  const withStylus = !!(options && options.stylus);
  const template = options && options.template ? PLAN_TEMPLATES.find((item) => item.id === options.template) : null;
  const note = {
    id: uid(),
    notebookId,
    title: withStylus ? "Рисунок" : template ? template.title : "",
    body: withStylus ? "" : template ? template.body : "",
    tags: withStylus ? ["стилус"] : template ? template.tags.slice() : [],
    pinned: withStylus ? false : !!(template && template.pinned),
    trashed: false,
    createdAt: now,
    updatedAt: now,
  };
  state.notes.unshift(note);
  state.selectedNoteId = note.id;
  if (state.view.kind === "trash" || state.view.kind === "tag" || state.view.kind === "drawings") {
    state.view = { kind: "notebook", id: notebookId };
  }
  focusTitle = !withStylus && !template;
  openStylusAfterRender = withStylus;
  mobilePane = "editor";
  mode = template ? "read" : "write";
  render();
}

function openView(view) {
  const notes = state.notes.filter((note) => matchesView(note, view)).sort((a, b) => b.updatedAt - a.updatedAt);
  state.view = view;
  state.selectedNoteId = notes[0] ? notes[0].id : null;
  mobilePane = "list";
  render();
}

function render() {
  const notes = visibleNotes();
  const note = selectedNote(notes);
  const alive = (item) => !item.trashed;
  const tags = new Map();
  state.notes.forEach((item) => {
    if (item.trashed) return;
    item.tags.forEach((tag) => tags.set(tag, (tags.get(tag) || 0) + 1));
  });
  const tagList = [...tags.entries()].sort((a, b) => a[0].localeCompare(b[0], "ru"));
  const activeId = document.activeElement && document.activeElement.id;
  const selectionStart = document.activeElement && document.activeElement.selectionStart;
  const selectionEnd = document.activeElement && document.activeElement.selectionEnd;
  const scrolls = [...document.querySelectorAll("[data-scroll]")].map((el) => el.scrollTop);

  document.documentElement.dataset.theme = state.theme;
  save();

  const notebookButtons = state.notebooks
    .map((notebook) => {
      const active = state.view.kind === "notebook" && state.view.id === notebook.id;
      return `<div class="notebook${active ? " active" : ""}">
        <button data-view="notebook" data-id="${esc(notebook.id)}"><span>${esc(notebook.name)}</span><em>${count((item) => alive(item) && item.notebookId === notebook.id)}</em></button>
        ${active ? `<span class="notebook-actions"><button data-rename="${esc(notebook.id)}" title="Переименовать">✎</button><button data-delete-notebook="${esc(notebook.id)}" title="Удалить">×</button></span>` : ""}
      </div>`;
    })
    .join("");

  const cards = notes.length
    ? notes
        .map((item) => {
          const progress = checklistProgress(item.body);
          return `<button class="card${item.id === (note && note.id) ? " selected" : ""}" data-note="${esc(item.id)}">
          <span class="card-top"><strong>${esc(item.title.trim() || "Без названия")}</strong>${item.pinned && !item.trashed ? '<i title="В избранном">★</i>' : ""}</span>
          <span class="card-preview">${esc(snippet(item.body))}</span>
          <span class="card-meta"><time>${esc(formatWhen(item.updatedAt))}</time>${progress ? `<em class="progress">${progress.done}/${progress.total}</em>` : ""}${item.tags.slice(0, 2).map((tag) => `<em>#${esc(tag)}</em>`).join("")}</span>
        </button>`;
        })
        .join("")
    : `<p class="empty">Здесь пока пусто.</p>`;

  const words = note && note.body.trim() ? note.body.trim().split(/\s+/).length : 0;
  const noteProgress = note ? checklistProgress(note.body) : null;
  const editor = note
    ? `<header class="editor-bar">
        <button class="back" data-pane="list" aria-label="К списку">←</button>
        <label class="notebook-pick"><span class="sr-only">Блокнот</span>
          <select id="notebook-select" ${note.trashed ? "disabled" : ""}>${state.notebooks.map((notebook) => `<option value="${esc(notebook.id)}"${notebook.id === note.notebookId ? " selected" : ""}>${esc(notebook.name)}</option>`).join("")}</select>
        </label>
        <div class="mode">
          <button data-mode="write" class="${mode === "write" ? "active" : ""}">Писать</button>
          <button data-mode="read" class="${mode === "read" ? "active" : ""}">Читать</button>
        </div>
        ${note.trashed ? `<button data-restore>Вернуть</button><button class="danger" data-delete-forever>Удалить навсегда</button>` : `<button class="pin${note.pinned ? " on" : ""}" data-pin>${note.pinned ? "В избранном" : "В избранное"}</button><button class="danger" data-trash>В корзину</button>`}
      </header>
      <input id="note-title" class="title" value="${esc(note.title)}" placeholder="Без названия" ${note.trashed ? "disabled" : ""}>
      <div class="tag-row">
        ${note.tags.map((tag) => `<button class="chip" data-untag="${esc(tag)}" ${note.trashed ? "disabled" : ""} title="Убрать тег">#${esc(tag)} ×</button>`).join("")}
        ${note.trashed ? "" : `<input id="tag-input" class="tag-input" placeholder="Добавить тег">`}
      </div>
      ${mode === "write" && !note.trashed ? `<div class="tools">
        <button data-wrap="**" data-wrap-end="**" title="Жирный">B</button>
        <button data-wrap="*" data-wrap-end="*" title="Курсив">I</button>
        <button data-wrap="## " data-wrap-end="" title="Заголовок">H</button>
        <button data-wrap="- " data-wrap-end="" title="Список">•</button>
        <button data-wrap="- [ ] " data-wrap-end="" title="Чеклист">☐</button>
        <button data-wrap="\`" data-wrap-end="\`" title="Код">&lt;/&gt;</button>
        <button class="wide" data-table title="Вставить таблицу">Таблица</button>
        <button class="wide" data-stylus title="Писать стилусом">Стилус</button>
        <button class="wide" data-image title="Вставить скриншот">Скрин</button>
        <input id="image-file" class="sr-only" type="file" accept="image/*">
      </div>` : ""}
      ${mode === "write"
        ? `<div class="writing" data-scroll>${writeBlocks(note)}</div>`
        : `<article class="preview" data-scroll>${renderMarkdown(note.body, note.images)}</article>`}
      <footer class="editor-foot"><span>${words} ${wordLabel(words)}</span>${noteProgress ? `<span class="progress">Чеклист ${noteProgress.done}/${noteProgress.total}</span>` : ""}<span>Изменено ${esc(new Date(note.updatedAt).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }))}</span></footer>`
    : `<section class="editor empty-editor"><p>Выберите заметку или создайте новую.</p></section>`;

  root.innerHTML = `<div class="app pane-${mobilePane}">
    <aside class="sidebar">
      <div class="brand"><span class="mark" aria-hidden="true"></span><div><strong>OlyaNotes</strong><p>Заметки рядом</p></div></div>
      <label class="search"><input id="search" aria-label="Поиск" value="${esc(query)}" placeholder="Поиск"><kbd>Ctrl K</kbd></label>
      <nav class="nav">
        <button data-view="all" class="${state.view.kind === "all" ? "active" : ""}"><span>Все заметки</span><em>${count(alive)}</em></button>
        <button data-view="pinned" class="${state.view.kind === "pinned" ? "active" : ""}"><span>Избранное</span><em>${count((item) => alive(item) && item.pinned)}</em></button>
        <button data-view="drawings" class="${state.view.kind === "drawings" ? "active" : ""}"><span>Рисунки</span><em>${count((item) => alive(item) && noteHasDrawing(item))}</em></button>
        <button data-view="trash" class="${state.view.kind === "trash" ? "active" : ""}"><span>Корзина</span><em>${count((item) => item.trashed)}</em></button>
      </nav>
      <div class="section-head"><span>Блокноты</span><button class="icon-btn" data-new-notebook title="Новый блокнот">+</button></div>
      <div class="notebooks" data-scroll>${notebookButtons}</div>
      ${tagList.length ? `<div class="section-head"><span>Теги</span></div><div class="tags" data-scroll>${tagList.map(([name, total]) => `<button data-view="tag" data-name="${esc(name)}" class="${state.view.kind === "tag" && state.view.name === name ? "active" : ""}">#${esc(name)}<em>${total}</em></button>`).join("")}</div>` : ""}
      <div class="sidebar-foot">
        <button data-theme>${state.theme === "dark" ? "Светлая тема" : "Тёмная тема"}</button>
        <button data-sync>${syncSettings.enabled ? (syncSettings.mode === "cloud" ? "Облако" : "Wi‑Fi") : "Синхронизация"}</button>
        <button data-export>Экспорт</button>
        <button data-import>Импорт</button>
        <button data-install>Установить</button>
        ${syncStatus ? `<span class="sync-status">${esc(syncStatus)}</span>` : ""}
      </div>
    </aside>
    <section class="list">
      <header>
        <button class="back" data-pane="nav" aria-label="К разделам">←</button>
        <h1>${esc(viewLabel())}</h1>
        ${state.view.kind === "trash" ? "" : `<button class="new-note" data-new-note>Новая</button><button class="new-note ghost" data-new-template title="Шаблоны планов">Шаблон</button><button class="new-note ghost" data-new-stylus title="Новая заметка стилусом">Стилус</button>`}
      </header>
      <div class="cards" data-scroll>${cards}</div>
    </section>
    ${note ? `<section class="editor">${editor}</section>` : editor}
    <input id="import-file" class="sr-only" type="file" accept="application/json,.json">
  </div>`;

  document.querySelectorAll("[data-scroll]").forEach((el, index) => {
    if (scrolls[index] != null) el.scrollTop = scrolls[index];
  });

  if (focusTitle) {
    focusTitle = false;
    const title = document.getElementById("note-title");
    if (title) title.focus();
  } else if (activeId) {
    const el = document.getElementById(activeId);
    if (el) {
      el.focus();
      if (typeof selectionStart === "number" && el.setSelectionRange) el.setSelectionRange(selectionStart, selectionEnd);
    }
  }

  bind(note);

  if (openStylusAfterRender && note) {
    openStylusAfterRender = false;
    openStylusPad(note.id);
  }
}

function bind(note) {
  const search = document.getElementById("search");
  if (search) {
    search.addEventListener("input", () => {
      query = search.value;
      render();
    });
  }

  root.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", () => {
      const kind = button.dataset.view;
      if (kind === "notebook") openView({ kind, id: button.dataset.id });
      else if (kind === "tag") openView({ kind, name: button.dataset.name });
      else openView({ kind });
    });
  });

  root.querySelectorAll("[data-note]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedNoteId = button.dataset.note;
      mobilePane = "editor";
      render();
    });
  });

  root.querySelectorAll("[data-pane]").forEach((button) => {
    button.addEventListener("click", () => {
      mobilePane = button.dataset.pane;
      render();
    });
  });

  const newNote = root.querySelector("[data-new-note]");
  if (newNote) newNote.addEventListener("click", () => createNote());
  const newTemplate = root.querySelector("[data-new-template]");
  if (newTemplate) newTemplate.addEventListener("click", () => openTemplatePicker());
  const newStylus = root.querySelector("[data-new-stylus]");
  if (newStylus) newStylus.addEventListener("click", () => createNote({ stylus: true }));

  const newNotebook = root.querySelector("[data-new-notebook]");
  if (newNotebook) {
    newNotebook.addEventListener("click", () => {
      const name = window.prompt("Название блокнота");
      if (!name || !name.trim()) return;
      const notebook = { id: uid(), name: name.trim(), createdAt: Date.now() };
      state.notebooks.push(notebook);
      state.view = { kind: "notebook", id: notebook.id };
      state.selectedNoteId = null;
      mobilePane = "list";
      render();
    });
  }

  root.querySelectorAll("[data-rename]").forEach((button) => {
    button.addEventListener("click", () => {
      const notebook = state.notebooks.find((item) => item.id === button.dataset.rename);
      const name = window.prompt("Новое название", notebook ? notebook.name : "");
      if (!name || !name.trim() || !notebook) return;
      notebook.name = name.trim();
      render();
    });
  });

  root.querySelectorAll("[data-delete-notebook]").forEach((button) => {
    button.addEventListener("click", () => {
      const notebook = state.notebooks.find((item) => item.id === button.dataset.deleteNotebook);
      if (!notebook || !window.confirm(`Удалить блокнот «${notebook.name}»? Заметки попадут в корзину.`)) return;
      state.notebooks = state.notebooks.filter((item) => item.id !== notebook.id);
      if (!state.notebooks.length) state.notebooks.push({ id: uid(), name: "Входящие", createdAt: Date.now() });
      state.notes = state.notes.map((item) => (item.notebookId === notebook.id ? Object.assign({}, item, { trashed: true, updatedAt: Date.now() }) : item));
      state.view = { kind: "all" };
      state.selectedNoteId = null;
      render();
    });
  });

  const theme = root.querySelector("[data-theme]");
  if (theme) {
    theme.addEventListener("click", () => {
      state.theme = state.theme === "dark" ? "light" : "dark";
      render();
    });
  }

  const syncButton = root.querySelector("[data-sync]");
  if (syncButton) {
    syncButton.addEventListener("click", () => {
      if (syncSettings.enabled && window.confirm("Синхронизация уже включена.\nОК — синхронизировать сейчас.\nОтмена — изменить настройки.")) {
        syncNow(true);
        return;
      }
      openSyncDialog();
    });
  }

  const exportButton = root.querySelector("[data-export]");
  if (exportButton) {
    exportButton.addEventListener("click", () => {
      const blob = new Blob([JSON.stringify({ notebooks: state.notebooks, notes: state.notes }, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "olyanotes.json";
      link.click();
      URL.revokeObjectURL(url);
    });
  }

  const importButton = root.querySelector("[data-import]");
  const importFile = document.getElementById("import-file");
  if (importButton && importFile) {
    importButton.addEventListener("click", () => importFile.click());
    importFile.addEventListener("change", () => {
      const file = importFile.files && importFile.files[0];
      importFile.value = "";
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const parsed = JSON.parse(String(reader.result || ""));
          const notebooks = Array.isArray(parsed.notebooks) ? parsed.notebooks.filter((item) => item && item.id && item.name) : [];
          const notes = Array.isArray(parsed.notes) ? parsed.notes.filter(isNote) : [];
          if (!notebooks.length) throw new Error("empty");
          if (!window.confirm("Заменить текущие заметки содержимым файла?")) return;
          state.notebooks = notebooks;
          state.notes = notes;
          state.view = { kind: "all" };
          state.selectedNoteId = (notes.find((item) => !item.trashed) || {}).id || null;
          render();
        } catch {
          window.alert("Не получилось прочитать файл. Нужен экспорт OlyaNotes.");
        }
      };
      reader.readAsText(file);
    });
  }

  if (!note) return;

  const title = document.getElementById("note-title");
  if (title) {
    title.addEventListener("input", () => {
      updateNote(note.id, { title: title.value });
      render();
    });
  }

  root.querySelectorAll(".chunk").forEach((body) => {
    body.addEventListener("input", () => {
      updateNote(note.id, { body: readWritingBody() });
      render();
    });
    body.addEventListener("paste", (event) => {
      const data = event.clipboardData;
      const items = data && data.items ? [...data.items] : [];
      const pasted = items.find((item) => item.kind === "file" && item.type.startsWith("image/"));
      const file = pasted ? pasted.getAsFile() : data && data.files && [...data.files].find((item) => item.type.startsWith("image/"));
      if (!file) return;
      event.preventDefault();
      const nodes = [...document.querySelectorAll(".writing > .chunk, .writing > .shot")];
      let cursor = 0;
      for (const node of nodes) {
        if (node === body) {
          cursor += body.selectionStart;
          break;
        }
        cursor += (node.classList.contains("chunk") ? node.value : imageToken(node.dataset.alt, node.dataset.imageId, node.dataset.shotSize)).length + 1;
      }
      insertImageFile(note.id, file, cursor);
    });
  });

  const imageButton = root.querySelector("[data-image]");
  const imageFile = document.getElementById("image-file");
  if (imageButton && imageFile) {
    imageButton.addEventListener("click", () => imageFile.click());
    imageFile.addEventListener("change", () => {
      const file = imageFile.files && imageFile.files[0];
      imageFile.value = "";
      if (file) insertImageFile(note.id, file, note.body.length);
    });
  }

  root.querySelectorAll("[data-resize]").forEach((button) => {
    button.addEventListener("click", () => {
      const id = button.dataset.target;
      const size = button.dataset.resize;
      if (!id || (size !== "l" && size !== "m" && size !== "s")) return;
      const next = note.body.replace(new RegExp(`(!\\[[^\\]]*\\]\\(img:${id})(?::[lms])?(\\))`, "g"), size === "l" ? "$1$2" : `$1:${size}$2`);
      updateNote(note.id, { body: next });
      render();
    });
  });

  root.querySelectorAll("[data-remove-image]").forEach((button) => {
    button.addEventListener("click", () => {
      const id = button.dataset.removeImage;
      const images = Object.assign({}, note.images);
      delete images[id];
      updateNote(note.id, {
        images,
        body: note.body.replace(new RegExp(`\\n?!\\[[^\\]]*\\]\\(img:${id}(?::[lms])?\\)\\n?`, "g"), "\n").replace(/\n{3,}/g, "\n\n"),
      });
      render();
    });
  });

  const notebookSelect = document.getElementById("notebook-select");
  if (notebookSelect) {
    notebookSelect.addEventListener("change", () => {
      updateNote(note.id, { notebookId: notebookSelect.value });
      render();
    });
  }

  root.querySelectorAll("[data-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      mode = button.dataset.mode;
      render();
    });
  });

  const pin = root.querySelector("[data-pin]");
  if (pin) {
    pin.addEventListener("click", () => {
      updateNote(note.id, { pinned: !note.pinned });
      render();
    });
  }

  const trash = root.querySelector("[data-trash]");
  if (trash) {
    trash.addEventListener("click", () => {
      const rest = notesVisibleWithout(note.id);
      updateNote(note.id, { trashed: true });
      state.selectedNoteId = rest ? rest.id : null;
      render();
    });
  }

  const restore = root.querySelector("[data-restore]");
  if (restore) {
    restore.addEventListener("click", () => {
      updateNote(note.id, { trashed: false });
      state.view = { kind: "all" };
      state.selectedNoteId = note.id;
      mobilePane = "editor";
      render();
    });
  }

  const forever = root.querySelector("[data-delete-forever]");
  if (forever) {
    forever.addEventListener("click", () => {
      const rest = visibleNotes().filter((item) => item.id !== note.id)[0];
      state.notes = state.notes.filter((item) => item.id !== note.id);
      state.selectedNoteId = rest ? rest.id : null;
      render();
    });
  }

  root.querySelectorAll("[data-untag]").forEach((button) => {
    button.addEventListener("click", () => {
      updateNote(note.id, { tags: note.tags.filter((tag) => tag !== button.dataset.untag) });
      render();
    });
  });

  const tagInput = document.getElementById("tag-input");
  if (tagInput) {
    tagInput.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      const value = tagInput.value.trim().replace(/^#/, "").toLowerCase();
      if (!value || note.tags.includes(value)) {
        tagInput.value = "";
        return;
      }
      updateNote(note.id, { tags: note.tags.concat(value) });
      render();
    });
  }

  root.querySelectorAll("[data-wrap]").forEach((button) => {
    button.addEventListener("click", () => applyWrap(note, button.dataset.wrap, button.dataset.wrapEnd || ""));
  });

  const tableButton = root.querySelector("[data-table]");
  if (tableButton) tableButton.addEventListener("click", () => insertTable(note));

  const stylusButton = root.querySelector("[data-stylus]");
  if (stylusButton) stylusButton.addEventListener("click", () => openStylusPad(note.id));

  const preview = root.querySelector(".preview");
  if (preview) {
    preview.addEventListener("change", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement) || target.dataset.task !== "1") return;
      const boxes = [...preview.querySelectorAll('input[data-task="1"]')];
      const index = boxes.indexOf(target);
      if (index < 0) return;
      updateNote(note.id, { body: toggleTask(note.body, index) });
      render();
    });
  }
}

function notesVisibleWithout(id) {
  return visibleNotes().filter((item) => item.id !== id)[0] || null;
}

function insertTable(note) {
  if (note.trashed) return;
  const colsRaw = window.prompt("Сколько столбцов? От 2 до 6", "3");
  if (colsRaw === null) return;
  const rowsRaw = window.prompt("Сколько строк, не считая заголовка? От 1 до 12", "3");
  if (rowsRaw === null) return;
  const cols = Math.min(6, Math.max(2, Number(colsRaw) || 3));
  const rows = Math.min(12, Math.max(1, Number(rowsRaw) || 3));
  const header = `| ${Array.from({ length: cols }, (_, index) => `Столбец ${index + 1}`).join(" | ")} |`;
  const rule = `| ${Array.from({ length: cols }, () => "---").join(" | ")} |`;
  const blank = `| ${Array.from({ length: cols }, () => " ").join(" | ")} |`;
  const table = `\n${header}\n${rule}\n${Array.from({ length: rows }, () => blank).join("\n")}\n`;
  const area = document.activeElement && document.activeElement.classList.contains("chunk")
    ? document.activeElement
    : document.querySelector(".chunk");
  if (!area) return;
  const start = area.selectionStart;
  area.value = area.value.slice(0, start) + table + area.value.slice(start);
  updateNote(note.id, { body: readWritingBody() });
  const chunkId = area.id;
  const cursor = start + table.length;
  render();
  const updated = document.getElementById(chunkId);
  if (!updated) return;
  updated.focus();
  updated.setSelectionRange(cursor, cursor);
}

function applyWrap(note, before, after) {
  const area = document.activeElement && document.activeElement.classList.contains("chunk")
    ? document.activeElement
    : document.querySelector(".chunk");
  if (!area) return;
  const start = area.selectionStart;
  const end = area.selectionEnd;
  const selected = area.value.slice(start, end) || "текст";
  const nextValue = area.value.slice(0, start) + before + selected + after + area.value.slice(end);
  area.value = nextValue;
  updateNote(note.id, { body: readWritingBody() });
  const cursor = start + before.length + selected.length + after.length;
  const chunkId = area.id;
  render();
  const updated = document.getElementById(chunkId);
  if (!updated) return;
  updated.focus();
  updated.setSelectionRange(cursor, cursor);
}

document.addEventListener("keydown", (event) => {
  if (!(event.ctrlKey || event.metaKey)) return;
  const key = event.key.toLowerCase();
  if (key === "k") {
    event.preventDefault();
    mobilePane = "nav";
    render();
    const search = document.getElementById("search");
    if (search) {
      search.focus();
      search.select();
    }
  }
  if (key === "n" && state.view.kind !== "trash") {
    event.preventDefault();
    createNote();
  }
});

let installPrompt = null;
window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  installPrompt = event;
});

document.addEventListener("click", (event) => {
  const button = event.target.closest && event.target.closest("[data-install]");
  if (!button) return;
  if (installPrompt) {
    installPrompt.prompt();
    installPrompt = null;
    return;
  }
  const android = /Android/i.test(navigator.userAgent);
  window.alert(
    android
      ? "На Android откройте эту страницу в Chrome и выберите меню → «Установить приложение» или «Добавить на главный экран»."
      : "На компьютере откройте страницу в Chrome и выберите меню → «Установить OlyaNotes». Значок установки также бывает справа в адресной строке.",
  );
});

if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

if (syncSettings.enabled) {
  syncNow(false).catch(() => {});
  setInterval(() => {
    if (syncSettings.enabled && !document.hidden) syncNow(false).catch(() => {});
  }, 20000);
}

render();
