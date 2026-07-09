// ================================================================
// PROVEEDOR DIRECTO PARA ANIMEAV1 (SIN BACKEND)
// ================================================================

class Provider {
    // Devuelve la configuración básica
    getSettings() {
        return {
            episodeServers: ["animeav1"],
            supportsDub: true
        };
    }

    // --------------------------------------------------------------
    // search() - Busca animes por nombre
    // --------------------------------------------------------------
    async search(opts) {
        const query = encodeURIComponent(opts.query);
        const url = `https://animeav1.com/search?q=${query}`;
        
        const res = await fetch(url);
        if (!res.ok) return [];
        
        const html = await res.text();
        // Extraemos los resultados de la página de búsqueda
        // Seleccionamos los enlaces a los animes (suelen estar en un div con clase "result-item" o similar)
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const items = doc.querySelectorAll('a[href*="/anime/"]');
        
        const results = [];
        for (const a of items) {
            const title = a.textContent.trim();
            const href = a.getAttribute('href');
            if (!href || !title) continue;
            // Obtenemos el slug de la URL (ej: /anime/mushoku-tensei)
            const match = href.match(/\/anime\/([^\/]+)/);
            if (match) {
                results.push({
                    id: match[1],
                    title: title,
                    url: `https://animeav1.com${href}`,
                    subOrDub: "both"
                });
            }
        }
        return results.slice(0, 20); // limitamos a 20 resultados
    }

    // --------------------------------------------------------------
    // findEpisodes() - Obtiene lista de episodios de un anime
    // --------------------------------------------------------------
    async findEpisodes(id) {
        const url = `https://animeav1.com/anime/${id}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error("No se pudo cargar la página del anime");
        
        const html = await res.text();
        const doc = new DOMParser().parseFromString(html, 'text/html');
        
        // Buscamos los enlaces a episodios (suelen estar en una lista con clase "episode-list")
        // Ejemplo: <a href="/ver/mushoku-tensei-1">Episodio 1</a>
        const epLinks = doc.querySelectorAll('a[href*="/ver/"]');
        const episodes = [];
        for (const a of epLinks) {
            const href = a.getAttribute('href');
            const text = a.textContent.trim();
            // Extraemos el número de episodio (si existe)
            const numMatch = text.match(/\d+/);
            const number = numMatch ? parseInt(numMatch[0]) : 0;
            if (href && href.startsWith('/ver/')) {
                episodes.push({
                    id: href,                // guardamos la URL relativa
                    number: number,
                    url: `https://animeav1.com${href}`,
                    title: text || `Episodio ${number}`
                });
            }
        }
        // Ordenamos por número
        episodes.sort((a, b) => a.number - b.number);
        return episodes;
    }

    // --------------------------------------------------------------
    // findEpisodeServer() - Obtiene el stream de un episodio
    // --------------------------------------------------------------
    async findEpisodeServer(episode, server) {
        const episodeUrl = episode.url;
        if (!episodeUrl) throw new Error("URL del episodio no disponible");
        
        // Primero obtenemos el HTML del episodio para extraer el iframe del reproductor
        const res = await fetch(episodeUrl);
        if (!res.ok) throw new Error("No se pudo cargar la página del episodio");
        
        const html = await res.text();
        const doc = new DOMParser().parseFromString(html, 'text/html');
        
        // Buscamos el iframe que contiene el reproductor (suele tener id "player" o clase "player")
        let iframeSrc = null;
        const iframe = doc.querySelector('iframe#player, iframe.player, iframe[src*="embed"]');
        if (iframe) {
            iframeSrc = iframe.getAttribute('src');
        }
        if (!iframeSrc) {
            // Fallback: buscar en el contenido un enlace que tenga "embed" o "player"
            const links = doc.querySelectorAll('a[href*="embed"], a[href*="player"]');
            for (const a of links) {
                const href = a.getAttribute('href');
                if (href && (href.includes('embed') || href.includes('player'))) {
                    iframeSrc = href;
                    break;
                }
            }
        }
        
        if (!iframeSrc) {
            throw new Error("No se encontró el reproductor en la página");
        }
        
        // Si el iframe es relativo, completamos la URL
        if (iframeSrc.startsWith('/')) {
            iframeSrc = `https://animeav1.com${iframeSrc}`;
        } else if (!iframeSrc.startsWith('http')) {
            iframeSrc = `https://animeav1.com/${iframeSrc}`;
        }
        
        // Ahora, desde el iframe, extraemos el stream (mp4 o m3u8)
        // Pero Seanime tiene un resolver interno que puede manejar esto si devolvemos la URL del iframe como videoSource?
        // La mejor práctica es intentar extraer el stream directamente desde el iframe.
        // Vamos a usar un enfoque: si el iframe es de una plataforma conocida, podemos redirigir.
        // Como simplificación, devolvemos el iframeSrc como un videoSource de tipo "iframe" (Seanime lo soporta?)
        // En Seanime, los tipos de videoSources pueden ser "mp4", "m3u8", o "iframe".
        // Vamos a intentar extraer el stream real si es posible; si no, devolvemos el iframe.
        
        // Intentamos obtener el stream desde el iframe (fetch a la URL del iframe y buscar video)
        try {
            const iframeRes = await fetch(iframeSrc);
            const iframeHtml = await iframeRes.text();
            const iframeDoc = new DOMParser().parseFromString(iframeHtml, 'text/html');
            // Buscar etiquetas video o source
            const video = iframeDoc.querySelector('video');
            if (video) {
                const src = video.getAttribute('src');
                if (src) {
                    // Puede ser relativo
                    const absoluteSrc = src.startsWith('http') ? src : new URL(src, iframeSrc).href;
                    // Determinar tipo
                    const type = src.endsWith('.m3u8') ? 'm3u8' : 'mp4';
                    return {
                        server: server || "animeav1",
                        headers: {
                            "Referer": "https://animeav1.com/"
                        },
                        videoSources: [{
                            url: absoluteSrc,
                            type: type,
                            quality: "HD",
                            subtitles: []
                        }]
                    };
                }
            }
            // Buscar source dentro de video
            const sources = iframeDoc.querySelectorAll('source');
            if (sources.length > 0) {
                const src = sources[0].getAttribute('src');
                if (src) {
                    const absoluteSrc = src.startsWith('http') ? src : new URL(src, iframeSrc).href;
                    const type = src.endsWith('.m3u8') ? 'm3u8' : 'mp4';
                    return {
                        server: server || "animeav1",
                        headers: {
                            "Referer": "https://animeav1.com/"
                        },
                        videoSources: [{
                            url: absoluteSrc,
                            type: type,
                            quality: "HD",
                            subtitles: []
                        }]
                    };
                }
            }
        } catch (e) {
            // Si falla, usamos el iframe como fallback
        }
        
        // Fallback: devolver el iframe como videoSource de tipo "iframe"
        return {
            server: server || "animeav1",
            headers: {
                "Referer": "https://animeav1.com/"
            },
            videoSources: [{
                url: iframeSrc,
                type: "iframe",
                quality: "HD",
                subtitles: []
            }]
        };
    }
}