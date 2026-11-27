// Refresh live.m3u for GitHub Pages — run by .github/workflows/refresh.yml
// every 5 minutes. Same upstream protocol as the Worker/Cloudzyro service
// (AES-128-CBC KGQ API, reverse-engineered 2026-11-14), but the playlist
// carries DIRECT stream URLs (line_list[0].url) instead of /play/ links,
// because GitHub Pages cannot do dynamic redirects. Stream URLs are
// time-limited, so the playlist must be refreshed often.

import { writeFileSync } from "node:fs";

const CONFIG_URL =
  "https://pool-sg.oss-ap-southeast-1.aliyuncs.com/kgq/kgqapi-android.json";
const FALLBACK_URL =
  "https://cdn.jsdelivr.net/gh/jkwu5472/first/media.m3u8";
const NOTICE_LOGO =
  "https://cdn.jsdelivr.net/gh/jkwu5472/first/notice.jpg";

const FALLBACK_DOMAINS = [
  "https://api.08zbidl.com",
  "https://api.46d5umpk.com",
  "https://api.5h5hbfhh.com",
  "https://api.8kxv29.com",
  "https://api.bmjb2mk7.com",
  "https://api.cjxxpgkq.com",
  "https://api.il8phx6.com",
  "https://api.lav5041.com",
  "https://api.qchyzkww.com",
  "https://api.rqqakqyn.com",
  "https://api.tezpgdzn.com",
  "https://api.tkfupxqu.com",
  "https://api.txxhuc.com",
  "https://api.zejzeu7p.com",
];

const KEY_STR = "KANGEQIU@8868!~.";
const IV_STR = "0200010900030207";

const te = new TextEncoder();
const td = new TextDecoder();

let _cryptoKey = null;
async function getKey() {
  if (!_cryptoKey) {
    _cryptoKey = await crypto.subtle.importKey(
      "raw",
      te.encode(KEY_STR),
      { name: "AES-CBC" },
      false,
      ["encrypt", "decrypt"],
    );
  }
  return _cryptoKey;
}

function b64encode(bytes) {
  let bin = "";
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin);
}

function b64decode(b64) {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr.buffer;
}

async function aesEncryptB64(plaintext) {
  const key = await getKey();
  const ct = await crypto.subtle.encrypt(
    { name: "AES-CBC", iv: te.encode(IV_STR) },
    key,
    te.encode(plaintext),
  );
  return b64encode(ct);
}

async function aesDecryptB64(b64) {
  const key = await getKey();
  const pt = await crypto.subtle.decrypt(
    { name: "AES-CBC", iv: te.encode(IV_STR) },
    key,
    b64decode(b64),
  );
  return td.decode(pt);
}

async function encQuery(plaintext) {
  const parameter = encodeURIComponent(await aesEncryptB64(plaintext));
  const key = encodeURIComponent(await aesEncryptB64("key"));
  return `parameter=${parameter}&key=${key}`;
}

async function apiCall(host, path, plaintext = "") {
  const url = `${host}${path}?${await encQuery(plaintext)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { accept: "application/json" },
  });
  if (!res.ok) return null;
  const json = await res.json();
  if (json.code !== 200 || typeof json.data !== "string") return null;
  try {
    return JSON.parse(await aesDecryptB64(json.data));
  } catch {
    return null;
  }
}

async function getCandidateDomains() {
  try {
    const res = await fetch(CONFIG_URL);
    if (res.ok) {
      const json = await res.json();
      if (json?.code === 200 && typeof json.data === "string") {
        const list = JSON.parse(await aesDecryptB64(json.data));
        const hosts = (Array.isArray(list) ? list : [])
          .map((h) => h.host)
          .filter((h) => typeof h === "string" && h.startsWith("https://"));
        if (hosts.length) return hosts;
      }
    }
  } catch {
    // fall through
  }
  return FALLBACK_DOMAINS;
}

async function healthCheck(domain) {
  const list = await apiCall(domain, "/gz/initialize/getApiUrlList", "");
  return Array.isArray(list) ? list : null;
}

async function pickHealthyDomain() {
  const candidates = await getCandidateDomains();
  const tried = new Set();
  const queue = [...candidates];
  for (const d of FALLBACK_DOMAINS) if (!queue.includes(d)) queue.push(d);
  for (const domain of queue) {
    if (tried.has(domain)) continue;
    tried.add(domain);
    try {
      const list = await healthCheck(domain);
      if (list) return domain;
    } catch {
      // try next
    }
  }
  return null;
}

async function fetchLiveList(domain) {
  const list = await apiCall(domain, "/gz/live/sports", "");
  return Array.isArray(list) ? list : [];
}

function groupTitle(ballType) {
  if (ballType === 1) return "足球";
  if (ballType === 2) return "篮球";
  if (ballType === 3) return "电竞";
  return "直播";
}

function statusSuffix(m) {
  if (m.m_status === 1) {
    return m.line_name || m.line_list?.[0]?.name || "直播中";
  }
  if (m.m_status === 2) return m.match_status_info || "完场";
  return "未开赛";
}

function matchName(m) {
  const home = m.home?.name || "";
  const away = m.visiting?.name || "";
  return `${home} vs ${away}`.trim();
}

function buildM3U(items) {
  const lines = [
    "#EXTM3U",
    `#EXTINF:-1 tvg-name="注意事项" tvg-logo="${NOTICE_LOGO}" group-title="注意事项",注意事项`,
    FALLBACK_URL,
  ];
  for (const m of items) {
    const name = matchName(m);
    const status = statusSuffix(m);
    const logo = m.home?.logo || "";
    lines.push(
      `#EXTINF:-1 tvg-name="${name}|${status}" tvg-logo="${logo}" group-title="${groupTitle(m.ball_type)}",${name}|${status}`,
    );
    // Direct stream URL for live matches; fallback media otherwise.
    const url =
      m.m_status === 1 && m.line_list?.[0]?.url
        ? m.line_list[0].url
        : FALLBACK_URL;
    lines.push(url);
  }
  return lines.join("\n") + "\n";
}

const domain = await pickHealthyDomain();
if (!domain) {
  console.log("no healthy upstream domain, keeping old live.m3u");
  process.exit(0);
}
const items = await fetchLiveList(domain);
if (!items.length) {
  console.log("empty live list, keeping old live.m3u");
  process.exit(0);
}
writeFileSync("live.m3u", buildM3U(items));
const live = items.filter((m) => m.m_status === 1).length;
console.log(
  `wrote live.m3u: ${items.length} matches, ${live} live, domain ${domain}`,
);
