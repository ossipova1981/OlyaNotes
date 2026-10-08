const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const root = path.resolve(__dirname);
const port = 5173;
const dataDir = path.join(root, "data");
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PUT, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Sync-Code");
}

function codeHash(code) {
  return crypto.createHash("sha256").update(String(code || "").trim().toLowerCase()).digest("hex").slice(0, 24);
}

function syncPath(code) {
  return path.join(dataDir, "sync-" + codeHash(code) + ".json");
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 40 * 1024 * 1024) {
        reject(new Error("too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function mergeById(localList, remoteList) {
  const map = new Map();
  (localList || []).concat(remoteList || []).forEach((item) => {
    if (!item || !item.id) return;
    const prev = map.get(item.id);
    if (!prev || (item.updatedAt || 0) >= (prev.updatedAt || 0)) map.set(item.id, item);
  });
  return [...map.values()];
}

function mergeStore(local, remote) {
  const notebooks = mergeById(local.notebooks, remote.notebooks);
  const notesMap = new Map();
  (local.notes || []).concat(remote.notes || []).forEach((note) => {
    if (!note || !note.id) return;
    const prev = notesMap.get(note.id);
    if (!prev || (note.updatedAt || 0) >= (prev.updatedAt || 0)) {
      const images = Object.assign({}, (prev && prev.images) || {}, note.images || {});
      notesMap.set(note.id, Object.assign({}, note, { images }));
    } else if (prev && note.images) {
      prev.images = Object.assign({}, note.images, prev.images || {});
    }
  });
  return {
    notebooks,
    notes: [...notesMap.values()],
    updatedAt: Math.max(local.updatedAt || 0, remote.updatedAt || 0, Date.now()),
  };
}

const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);

  if (urlPath === "/api/sync" || urlPath === "/api/sync/") {
    const code = req.headers["x-sync-code"] || "";
    if (!String(code).trim()) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "Нужен код синхронизации" }));
      return;
    }
    const file = syncPath(code);
    try {
      if (req.method === "GET") {
        if (!fs.existsSync(file)) {
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ notebooks: [], notes: [], updatedAt: 0 }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(fs.readFileSync(file));
        return;
      }
      if (req.method === "PUT") {
        const raw = await readBody(req);
        const incoming = JSON.parse(raw || "{}");
        const existing = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { notebooks: [], notes: [], updatedAt: 0 };
        const merged = mergeStore(existing, {
          notebooks: Array.isArray(incoming.notebooks) ? incoming.notebooks : [],
          notes: Array.isArray(incoming.notes) ? incoming.notes : [],
          updatedAt: Date.now(),
        });
        fs.writeFileSync(file, JSON.stringify(merged));
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(merged));
        return;
      }
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: String(error.message || error) }));
      return;
    }
    res.writeHead(405);
    res.end();
    return;
  }

  if (urlPath === "/api/info") {
    const ips = [];
    const nets = os.networkInterfaces();
    Object.keys(nets).forEach((name) => {
      (nets[name] || []).forEach((net) => {
        const v4 = net.family === "IPv4" || net.family === 4;
        if (v4 && !net.internal) ips.push(net.address);
      });
    });
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ port, ips }));
    return;
  }

  const rel = (urlPath === "/" ? "index.html" : urlPath).replace(/^[/\\]+/, "");
  const file = path.resolve(root, rel);
  if (file !== root && !file.startsWith(root + path.sep)) {
    res.writeHead(403);
    res.end();
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.log("OlyaNotes уже запущено: http://127.0.0.1:" + port + "/");
    process.exit(0);
  }
  console.error(error.message);
  process.exit(1);
});

server.listen(port, "0.0.0.0", () => {
  console.log("");
  console.log("Веб и компьютер:  http://127.0.0.1:" + port + "/");
  const nets = os.networkInterfaces();
  Object.keys(nets).forEach((name) => {
    (nets[name] || []).forEach((net) => {
      const v4 = net.family === "IPv4" || net.family === 4;
      if (v4 && !net.internal) {
        console.log("Телефон и планшет в той же Wi-Fi:");
        console.log("  http://" + net.address + ":" + port + "/");
        console.log("В синхронизации укажите адрес:");
        console.log("  http://" + net.address + ":" + port);
      }
    });
  });
  console.log("");
  console.log("Синхронизация работает, пока это окно открыто.");
});
