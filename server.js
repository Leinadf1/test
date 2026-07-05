const express = require('express');
const fetch = require('node-fetch');
const app = express();
const PORT = process.env.PORT || 3000;

// ---------- CONFIGURAZIONE ----------
const STREAM_CONFIG = {
  manifestUrl: 'https://timlivetu0.cb.ticdn.it/Content/DASH/Live/channel(eurosport4k)/manifest.mpd',
  // Base URL dei segmenti (senza il nome del file)
  segmentBase: 'https://timlivetu0.cb.ticdn.it/Content/DASH/Live/channel(eurosport4k)/',
  // Intervallo di refresh del manifest (in millisecondi) - 20 minuti
  refreshInterval: 20 * 60 * 1000,
  // Nome del canale usato nell'URL del proxy
  channelPath: '/eurosport4k',
};

// Cache del manifest e timestamp
let cachedManifest = null;
let lastFetch = 0;
let manifestPromise = null; // per evitare richieste concorrenti

// ---------- FUNZIONI ----------

// Scarica il manifest originale e aggiunge il BaseURL che punta al proxy
async function fetchManifest() {
  console.log('[proxy] Scarico manifest originale...');
  const response = await fetch(STREAM_CONFIG.manifestUrl);
  if (!response.ok) throw new Error(`Manifest non disponibile: ${response.status}`);
  let manifestText = await response.text();

  // Inserisce il <BaseURL> che dice al player di chiedere i segmenti al proxy
  // La stringa inserita va subito prima del tag <Period>
  const baseUrlTag = `<BaseURL>${STREAM_CONFIG.channelPath}/segments/</BaseURL>`;
  manifestText = manifestText.replace('<Period', baseUrlTag + '<Period');
  
  return manifestText;
}

// Aggiorna il manifest in cache e programma il prossimo refresh
async function updateManifest() {
  try {
    if (!manifestPromise) {
      manifestPromise = fetchManifest().then(manifest => {
        cachedManifest = manifest;
        lastFetch = Date.now();
        console.log('[proxy] Manifest aggiornato con successo.');
        manifestPromise = null;
      }).catch(err => {
        console.error('[proxy] Errore aggiornamento manifest:', err);
        manifestPromise = null;
      });
    }
    await manifestPromise;
  } catch (e) {
    // già loggato
  }
}

// Recupera il manifest dalla cache (se troppo vecchio lo rigenera)
async function getManifest() {
  if (!cachedManifest || (Date.now() - lastFetch > STREAM_CONFIG.refreshInterval)) {
    await updateManifest();
  }
  return cachedManifest;
}

// ---------- ROUTE ----------

// Health check (per tener sveglio il server)
app.get('/health', (req, res) => res.send('OK'));

// Route del manifest
app.get(STREAM_CONFIG.channelPath + '/manifest.mpd', async (req, res) => {
  try {
    const manifest = await getManifest();
    res.type('application/dash+xml').send(manifest);
  } catch (err) {
    console.error('[proxy] Errore servendo il manifest:', err);
    res.status(502).send('Proxy error');
  }
});

// Route per i segmenti (tutti i file sotto il percorso segments/)
app.get(STREAM_CONFIG.channelPath + '/segments/*', async (req, res) => {
  const segmentPath = req.params[0]; // path dopo /segments/
  const url = STREAM_CONFIG.segmentBase + segmentPath + (req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '');
  
  try {
    const response = await fetch(url, {
      headers: {
        // Copia eventuali header utili (es. Range)
        ...(req.headers.range && { Range: req.headers.range })
      }
    });
    
    if (response.ok) {
      // Copia gli header rilevanti
      res.set({
        'Content-Type': response.headers.get('content-type') || 'application/octet-stream',
        'Content-Length': response.headers.get('content-length'),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache'
      });
      response.body.pipe(res);
    } else if (response.status === 403 || response.status === 404) {
      console.warn(`[proxy] Segmento bloccato (${response.status}), rigenero il manifest e ritento...`);
      // Forza refresh del manifest e riprova
      await updateManifest();
      const retryResponse = await fetch(url, {
        headers: { ...(req.headers.range && { Range: req.headers.range }) }
      });
      if (retryResponse.ok) {
        res.set({
          'Content-Type': retryResponse.headers.get('content-type') || 'application/octet-stream',
          'Content-Length': retryResponse.headers.get('content-length'),
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-cache'
        });
        retryResponse.body.pipe(res);
      } else {
        res.status(retryResponse.status).send('Errore dopo refresh');
      }
    } else {
      res.status(response.status).send('Segmento non disponibile');
    }
  } catch (err) {
    console.error('[proxy] Errore recuperando segmento:', err);
    res.status(500).send('Proxy error');
  }
});

// Avvio del server e primo aggiornamento manifest
app.listen(PORT, () => {
  console.log(`Proxy Eurosport 4K attivo sulla porta ${PORT}`);
  updateManifest();
  
  // Refresh automatico periodico
  setInterval(() => {
    console.log('[proxy] Refresh periodico manifest...');
    updateManifest();
  }, STREAM_CONFIG.refreshInterval);
});
