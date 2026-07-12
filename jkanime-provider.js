/// <reference path="./online-streaming-provider.d.ts" />
//
// Provider de JKAnime para Seanime — basado en la lógica REAL confirmada del
// script ani-es (https://github.com/Zhuchii/ani-es), portada del bash/wget/grep
// original al sandbox fetch()/LoadDoc() de Seanime (Goja, sin eval, sin cookies
// de navegador reales).
//
// PENDIENTE DE PROBAR EN PLAYGROUND (primera versión, como con AnimeAV1 al
// principio — es normal que necesite 1-2 rondas de ajuste con logs reales):
// 1. El paso de CSRF+cookies para contar episodios puede no funcionar si el
//    fetch() del sandbox no expone/permite manejar Set-Cookie. Hay un fallback
//    sin cookies (leer el texto "Episodios: N" visible en la página).
// 2. Los regex de "video: { url: ..., type: ... }" están basados en el patrón
//    exacto que usa ani-es (grep + sed), pero no se probaron contra el JS real
//    de jkplayer/jk.php todavía.
// 3. El campo "remote" de Mediafire se decodifica con un base64 manual (por si
//    atob() no existe en el sandbox de Seanime).

const BASE = "https://jkanime.net";
const EXCEPTIONS_URL = "https://zhuchii.github.io/ani-es/excepciones.json";

const HTTP_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
};

async function fetchHtml(url, extraHeaders) {
  const headers = Object.assign({}, HTTP_HEADERS, extraHeaders || {});
  const res = await fetch(url, { headers: headers });
  if (!res || res.status >= 400) {
    throw `HTTP_ERROR status=${res ? res.status : "sin respuesta"} al pedir ${url}`;
  }
  return await res.text();
}

// ============================================================
// BASE64 MANUAL (por si atob() no existe en el sandbox de Seanime)
// ============================================================
function base64Decode(str) {
  try {
    if (typeof atob === "function") return atob(str);
  } catch (_e) {
    // seguimos con el decoder manual
  }
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const clean = (str || "").replace(/[^A-Za-z0-9+/]/g, "");
  let output = "";
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < clean.length; i++) {
    const val = chars.indexOf(clean[i]);
    if (val === -1) continue;
    buffer = (buffer << 6) | val;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output += String.fromCharCode((buffer >> bits) & 0xff);
    }
  }
  return output;
}

// ============================================================
// PARSER MANUAL DE LITERALES JS (sin eval — reusado de la base de AnimeAV1)
// ============================================================
function extractBalancedSection(text, startIndex, openChar, closeChar) {
  let depth = 0;
  let quote = "";
  let escaped = false;

  for (let i = startIndex; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (c === "\\") { escaped = true; continue; }
      if (c === quote) { quote = ""; continue; }
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    if (c === openChar) depth++;
    if (c === closeChar) {
      depth--;
      if (depth === 0) return text.slice(startIndex, i + 1);
    }
  }
  return null;
}

function parseJsLiteral(input) {
  let i = 0;
  const skipWs = () => { while (i < input.length && /\s/.test(input[i])) i++; };

  const parseValue = () => {
    skipWs();
    const c = input[i];
    if (c === "{") return parseObject();
    if (c === "[") return parseArray();
    if (c === '"' || c === "'" || c === "`") return parseString();
    if (c === "-" || (c >= "0" && c <= "9")) return parseNumber();
    return parseWord();
  };

  const parseObject = () => {
    const obj = {};
    i++;
    skipWs();
    if (input[i] === "}") { i++; return obj; }
    while (true) {
      skipWs();
      const key = parseKey();
      skipWs();
      if (input[i] !== ":") throw "PARSE: se esperaba ':' en posicion " + i;
      i++;
      obj[key] = parseValue();
      skipWs();
      if (input[i] === ",") { i++; skipWs(); if (input[i] === "}") { i++; break; } continue; }
      if (input[i] === "}") { i++; break; }
      throw "PARSE: token inesperado en objeto, posicion " + i;
    }
    return obj;
  };

  const parseKey = () => {
    skipWs();
    const c = input[i];
    if (c === '"' || c === "'" || c === "`") return parseString();
    const start = i;
    while (i < input.length && /[A-Za-z0-9_$]/.test(input[i])) i++;
    if (i === start) throw "PARSE: clave vacia en posicion " + i;
    return input.slice(start, i);
  };

  const parseArray = () => {
    const arr = [];
    i++;
    skipWs();
    if (input[i] === "]") { i++; return arr; }
    while (true) {
      arr.push(parseValue());
      skipWs();
      if (input[i] === ",") { i++; skipWs(); if (input[i] === "]") { i++; break; } continue; }
      if (input[i] === "]") { i++; break; }
      throw "PARSE: token inesperado en array, posicion " + i;
    }
    return arr;
  };

  const parseString = () => {
    const quote = input[i];
    i++;
    let result = "";
    while (i < input.length && input[i] !== quote) {
      if (input[i] === "\\") {
        i++;
        const esc = input[i];
        if (esc === "n") result += "\n";
        else if (esc === "t") result += "\t";
        else if (esc === "r") result += "\r";
        else result += esc;
        i++;
      } else {
        result += input[i];
        i++;
      }
    }
    i++;
    return result;
  };

  const parseNumber = () => {
    const start = i;
    if (input[i] === "-") i++;
    while (i < input.length && /[0-9.eE+\-]/.test(input[i])) i++;
    return Number(input.slice(start, i));
  };

  const parseWord = () => {
    const start = i;
    while (i < input.length && /[A-Za-z0-9_$]/.test(input[i])) i++;
    const word = input.slice(start, i);
    if (word === "true") return true;
    if (word === "false") return false;
    if (word === "null") return null;
    if (word === "undefined") return null;
    if (word === "") throw "PARSE: valor inesperado en posicion " + i;
    return word;
  };

  return parseValue();
}

function safeEval(objectLiteral) {
  try {
    return parseJsLiteral(objectLiteral);
  } catch (_e) {
    return null;
  }
}

// ============================================================
// PROVIDER PRINCIPAL — JKANIME
// ============================================================

class Provider {
  constructor() {
    this.api = BASE;
  }

  getSettings() {
    return {
      episodeServers: ["JKAnime"],
      supportsDub: false,
    };
  }

  // ---------------------------------------------------------------------
  // SEARCH
  // ---------------------------------------------------------------------
  async search(opts) {
    const searchText = (opts && opts.query) || "";
    if (!searchText) return [];

    // ani-es reemplaza espacios por "_" en la query de búsqueda
    const query = searchText.trim().replace(/\s+/g, "_");
    const url = `${this.api}/buscar/${encodeURIComponent(query)}/`;

    const html = await fetchHtml(url);
    const results = [];

    try {
      const $ = LoadDoc(html);
      let selection = null;
      try { selection = $("h5 a"); } catch (_e) { selection = null; }

      if (selection) {
        selection.each((_i, el) => {
          let href = "";
          let title = "";
          try { href = el.attr("href"); } catch (_e) { /* ignorar */ }
          try { title = el.text(); } catch (_e) { /* ignorar */ }
          title = (title || "").replace(/&quot;/g, '"').trim();

          if (href && title) {
            results.push({ title, url: href });
          }
        });
      }
    } catch (_e) {
      // sin resultados de búsqueda disponibles
    }

    return results.map((r) => ({
      id: this.slugFromUrl(r.url),
      title: r.title,
      url: r.url.startsWith("http") ? r.url : `${this.api}${r.url}`,
    }));
  }

  slugFromUrl(url) {
    const clean = (url || "").replace(/\/$/, "");
    const match = /jkanime\.net\/([^/]+)$/.exec(clean);
    return match ? match[1] : clean;
  }

  // ---------------------------------------------------------------------
  // FIND EPISODES
  // ---------------------------------------------------------------------
  async findEpisodes(id) {
    let animeUrl = `${this.api}/${id}`;
    animeUrl = await this.applyExceptionIfAny(animeUrl);
    console.log("[EP-1] animeUrl final:", animeUrl);

    const html = await fetchHtml(`${animeUrl}/`);
    console.log("[EP-2] html length:", html ? html.length : 0);

    // Intento 1: réplica del método CSRF+AJAX real de ani-es
    let total = await this.tryEpisodeCountViaAjax(animeUrl, html);
    console.log("[EP-3] total via AJAX:", total);

    // Intento 2 (fallback sin cookies): leer "Episodios: N" visible en la página
    if (!total) {
      total = this.tryEpisodeCountViaHtml(html);
      console.log("[EP-4] total via HTML fallback:", total);
    }

    if (!total || total <= 0) {
      throw "No se pudo determinar el numero de episodios para este anime";
    }

    const isMovie = /Tipo:\s*<\/span>\s*Pelicula|Tipo:\s*Pelicula/i.test(html);
    console.log("[EP-5] esPelicula:", isMovie, "total episodios:", total);

    const episodes = [];
    if (isMovie) {
      episodes.push({
        id: `${id}/pelicula`,
        number: 1,
        title: "Película",
        url: `${animeUrl}/pelicula`,
      });
    } else {
      for (let n = 1; n <= total; n++) {
        episodes.push({
          id: `${id}/${n}`,
          number: n,
          title: `Episodio ${n}`,
          url: `${animeUrl}/${n}`,
        });
      }
    }

    console.log("[EP-6] episodios construidos:", episodes.length);
    return episodes;
  }

  async applyExceptionIfAny(animeUrl) {
    try {
      const res = await fetch(EXCEPTIONS_URL);
      if (!res || res.status >= 400) return animeUrl;
      const text = await res.text();
      const map = JSON.parse(text);
      if (map && map[animeUrl]) {
        return map[animeUrl].replace(/\/$/, "");
      }
    } catch (_e) {
      // sin excepciones disponibles, seguimos con la url original
    }
    return animeUrl;
  }

  async tryEpisodeCountViaAjax(animeUrl, html) {
    try {
      const tokenMatch = /meta name="csrf-token" content="([^"]+)"/.exec(html);
      const ajaxMatch = /url:\s*'(https:\/\/jkanime\.net\/ajax\/episodes\/\d+\/?)/.exec(html);
      console.log("[EP-AJAX-1] token encontrado:", !!tokenMatch, "| ajax url encontrada:", !!ajaxMatch, ajaxMatch ? ajaxMatch[1] : "");
      if (!tokenMatch || !ajaxMatch) return null;

      const token = tokenMatch[1];
      const ajaxUrl = ajaxMatch[1];

      const res = await fetch(ajaxUrl, {
        method: "POST",
        headers: Object.assign({}, HTTP_HEADERS, {
          "X-Requested-With": "XMLHttpRequest",
          "X-CSRF-TOKEN": token,
          "Content-Type": "application/x-www-form-urlencoded",
        }),
        body: `_token=${encodeURIComponent(token)}`,
      });

      console.log("[EP-AJAX-2] status respuesta POST:", res ? res.status : "sin respuesta");
      if (!res || res.status >= 400) return null;
      const text = await res.text();
      console.log("[EP-AJAX-3] respuesta cruda (primeros 300 chars):", text.slice(0, 300));
      const totalMatch = /"total":\s*(\d+)/.exec(text);
      return totalMatch ? parseInt(totalMatch[1], 10) : null;
    } catch (e) {
      console.log("[EP-AJAX-ERROR]", e && e.message ? e.message : String(e));
      return null;
    }
  }

  tryEpisodeCountViaHtml(html) {
    // Variantes posibles del marcado: "Episodios: 500", "Episodios:</span> 500", etc.
    const patterns = [
      /Episodios:\s*<\/span>\s*(\d+)/i,
      /Episodios:\s*(\d+)/i,
      /Episodes:\s*<\/span>\s*(\d+)/i,
      /Episodes:\s*(\d+)/i,
    ];
    for (const pattern of patterns) {
      const match = pattern.exec(html);
      if (match) return parseInt(match[1], 10);
    }
    return null;
  }

  // ---------------------------------------------------------------------
  // FIND EPISODE SERVER
  // ---------------------------------------------------------------------
  async findEpisodeServer(episode, _server) {
    if (!episode || !episode.url) {
      throw "No se recibio una URL de episodio valida (episode.url esta vacio)";
    }

    const html = await fetchHtml(episode.url);

    // Intento 1: jkplayer (nuevo) — <script src="/jkplayer/um....js">
    let videoInfo = await this.tryJkPlayerNuevo(html);

    // Intento 2: jk.php (antiguo) — <iframe src="/jk.php?...">
    if (!videoInfo) {
      videoInfo = await this.tryJkPhpAntiguo(html);
    }

    // Intento 3: Mediafire — var servers = [...]
    if (!videoInfo) {
      videoInfo = await this.tryMediafire(html);
    }

    if (!videoInfo) {
      throw "No se encontro ningun servidor de video para este episodio";
    }

    return {
      server: videoInfo.server || "JKAnime",
      videoSources: [
        {
          url: videoInfo.url,
          quality: "default",
          type: videoInfo.type === "hls" || /\.m3u8/i.test(videoInfo.url) ? "m3u8" : "mp4",
          headers: {
            "Referer": "https://jkanime.net/",
            "Origin": "https://jkanime.net",
            "User-Agent": HTTP_HEADERS["User-Agent"],
          },
        },
      ],
    };
  }

  // Extrae el bloque: video: { url: '...', type: '...' }
  extractVideoBlock(html) {
    const blockMatch = /video:\s*\{([^}]*)\}/.exec(html);
    if (!blockMatch) return null;
    const block = blockMatch[1];
    const urlMatch = /url:\s*'([^']+)'/.exec(block);
    const typeMatch = /type:\s*'([^']+)'/.exec(block);
    if (!urlMatch) return null;
    return { url: urlMatch[1], type: typeMatch ? typeMatch[1] : null };
  }

  async tryJkPlayerNuevo(episodeHtml) {
    try {
      const scriptMatch = /src="(\/jkplayer\/um[^"]*)"/.exec(episodeHtml);
      if (!scriptMatch) return null;

      const scriptUrl = `${this.api}${scriptMatch[1]}`;
      const jsContent = await fetchHtml(scriptUrl, { "Referer": this.api + "/" });
      const info = this.extractVideoBlock(jsContent);
      if (!info) return null;

      return { server: "JKAnime", url: info.url, type: info.type };
    } catch (_e) {
      return null;
    }
  }

  async tryJkPhpAntiguo(episodeHtml) {
    try {
      const iframeMatch = /<iframe[^>]+src="(\/jk\.php[^"]*)"/.exec(episodeHtml);
      if (!iframeMatch) return null;

      const iframeUrl = `${this.api}${iframeMatch[1]}`;
      const jkPhpHtml = await fetchHtml(iframeUrl, { "Referer": this.api + "/" });
      const info = this.extractVideoBlock(jkPhpHtml);
      if (!info) return null;

      return { server: "JKAnime", url: info.url, type: info.type };
    } catch (_e) {
      return null;
    }
  }

  async tryMediafire(episodeHtml) {
    try {
      const serversMatch = /var servers\s*=\s*(\[[\s\S]*?\]);/.exec(episodeHtml);
      if (!serversMatch) return null;

      const servers = safeEval(serversMatch[1]);
      if (!Array.isArray(servers)) return null;

      const mediafireEntry = servers.filter((s) => s && s.server === "Mediafire")[0];
      if (!mediafireEntry || !mediafireEntry.remote) return null;

      const mediafireUrl = base64Decode(mediafireEntry.remote);
      const mediafireHtml = await fetchHtml(mediafireUrl);

      const downloadMatch = /href="(https:\/\/download[^"]+)"/.exec(mediafireHtml);
      if (!downloadMatch) return null;

      return { server: "Mediafire", url: downloadMatch[1], type: "mp4" };
    } catch (_e) {
      return null;
    }
  }
}


