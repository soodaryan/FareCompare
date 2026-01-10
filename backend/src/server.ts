import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import { FareService } from './services/fare.service';
import { BusService } from './services/bus.service';
import { MetroService } from './services/metro.service';
import { BrowserService } from './services/browser.service';
import { GeoLocation } from './interfaces/types';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const fareService = new FareService();
const busService = new BusService();
const metroService = new MetroService();

const isVercel = String(process.env.VERCEL || '').toLowerCase() === '1' || String(process.env.VERCEL || '').toLowerCase() === 'true';

if (!isVercel) {
  BrowserService.getInstance().init().catch(err => {
    console.error('Failed to initialize browser:', err);
  });
}

app.post('/api/compare-fares', async (req, res) => {
  try {
    const { pickup, drop } = req.body;

    if (!pickup || !drop || !pickup.lat || !pickup.lng || !drop.lat || !drop.lng) {
      return res.status(400).json({ error: 'Invalid pickup or drop coordinates' });
    }

    const pickupLoc: GeoLocation = { lat: parseFloat(pickup.lat), lng: parseFloat(pickup.lng) };
    const dropLoc: GeoLocation = { lat: parseFloat(drop.lat), lng: parseFloat(drop.lng) };

    const estimates = await fareService.getFareEstimates(pickupLoc, dropLoc);

    res.json({
      success: true,
      count: estimates.length,
      estimates
    });

  } catch (error) {
    console.error('API Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.post('/api/bus-routes', async (req, res) => {
  try {
    const { pickup, drop } = req.body;

    if (!pickup || !drop || !pickup.lat || !pickup.lng || !drop.lat || !drop.lng) {
      return res.status(400).json({ error: 'Invalid pickup or drop coordinates' });
    }

    const pickupLoc: GeoLocation = { lat: parseFloat(pickup.lat), lng: parseFloat(pickup.lng) };
    const dropLoc: GeoLocation = { lat: parseFloat(drop.lat), lng: parseFloat(drop.lng) };

    const routes = busService.findRoutes(pickupLoc, dropLoc);

    res.json({
      success: true,
      count: routes.length,
      routes
    });

  } catch (error) {
    console.error('Bus API Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.get('/api/azuremaps/config', (req, res) => {
  const subscriptionKey =
    process.env.AZURE_MAPS_SUBSCRIPTION_KEY ||
    process.env.AZURE_MAPS_API_KEY ||
    process.env.MICROSOFT_MAPS_API_KEY ||
    '';

  if (!subscriptionKey) {
    return res.status(500).json({ error: 'Azure Maps key missing in environment' });
  }

  res.json({ subscriptionKey });
});

app.get('/api/azuremaps/search', async (req, res) => {
  try {
    const subscriptionKey =
      process.env.AZURE_MAPS_SUBSCRIPTION_KEY ||
      process.env.AZURE_MAPS_API_KEY ||
      process.env.MICROSOFT_MAPS_API_KEY ||
      '';

    if (!subscriptionKey) {
      return res.status(500).json({ error: 'Azure Maps key missing in environment' });
    }

    const query = typeof req.query.query === 'string' ? req.query.query : '';
    if (!query.trim()) {
      return res.json({ results: [] });
    }

    const url = new URL('https://atlas.microsoft.com/search/address/json');
    url.searchParams.set('api-version', '1.0');
    url.searchParams.set('query', query);
    url.searchParams.set('limit', '5');
    url.searchParams.set('countrySet', 'IN');
    url.searchParams.set('subscription-key', subscriptionKey);

    const response = await fetch(url.toString());
    if (!response.ok) {
      const text = await response.text();
      return res.status(502).json({ error: 'Azure Maps search failed', details: text });
    }

    const data = await response.json();
    const results = Array.isArray(data?.results)
      ? data.results.map((r: any) => ({
          id: r?.id ?? `${r?.position?.lat ?? ''},${r?.position?.lon ?? ''}`,
          address: r?.address?.freeformAddress ?? r?.address?.streetName ?? 'Unknown',
          position: r?.position ? { lat: r.position.lat, lng: r.position.lon } : null,
        }))
      : [];

    res.json({ results: results.filter((r: any) => r.position) });
  } catch (error) {
    console.error('Azure Maps search error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.get('/api/azuremaps/reverse', async (req, res) => {
  try {
    const subscriptionKey =
      process.env.AZURE_MAPS_SUBSCRIPTION_KEY ||
      process.env.AZURE_MAPS_API_KEY ||
      process.env.MICROSOFT_MAPS_API_KEY ||
      '';

    if (!subscriptionKey) {
      return res.status(500).json({ error: 'Azure Maps key missing in environment' });
    }

    const lat = typeof req.query.lat === 'string' ? Number(req.query.lat) : NaN;
    const lng = typeof req.query.lng === 'string' ? Number(req.query.lng) : NaN;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ error: 'Invalid lat/lng' });
    }

    const url = new URL('https://atlas.microsoft.com/search/address/reverse/json');
    url.searchParams.set('api-version', '1.0');
    url.searchParams.set('query', `${lat},${lng}`);
    url.searchParams.set('subscription-key', subscriptionKey);

    const response = await fetch(url.toString());
    if (!response.ok) {
      const text = await response.text();
      return res.status(502).json({ error: 'Azure Maps reverse geocode failed', details: text });
    }

    const data = await response.json();
    const address = data?.addresses?.[0]?.address?.freeformAddress ?? `${lat}, ${lng}`;
    res.json({ address, position: { lat, lng } });
  } catch (error) {
    console.error('Azure Maps reverse error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.get('/api/azuremaps/route', async (req, res) => {
  try {
    const subscriptionKey =
      process.env.AZURE_MAPS_SUBSCRIPTION_KEY ||
      process.env.AZURE_MAPS_API_KEY ||
      process.env.MICROSOFT_MAPS_API_KEY ||
      '';

    if (!subscriptionKey) {
      return res.status(500).json({ error: 'Azure Maps key missing in environment' });
    }

    const pickupLat = typeof req.query.pickupLat === 'string' ? Number(req.query.pickupLat) : NaN;
    const pickupLng = typeof req.query.pickupLng === 'string' ? Number(req.query.pickupLng) : NaN;
    const dropLat = typeof req.query.dropLat === 'string' ? Number(req.query.dropLat) : NaN;
    const dropLng = typeof req.query.dropLng === 'string' ? Number(req.query.dropLng) : NaN;

    if (!Number.isFinite(pickupLat) || !Number.isFinite(pickupLng) || !Number.isFinite(dropLat) || !Number.isFinite(dropLng)) {
      return res.status(400).json({ error: 'Invalid coordinates' });
    }

    const url = new URL('https://atlas.microsoft.com/route/directions/json');
    url.searchParams.set('api-version', '1.0');
    url.searchParams.set('query', `${pickupLat},${pickupLng}:${dropLat},${dropLng}`);
    url.searchParams.set('travelMode', 'car');
    url.searchParams.set('routeRepresentation', 'polyline');
    url.searchParams.set('subscription-key', subscriptionKey);

    const response = await fetch(url.toString());
    if (!response.ok) {
      const text = await response.text();
      return res.status(502).json({ error: 'Azure Maps route failed', details: text });
    }

    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('Azure Maps route error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.get('/api/metro/stations', async (req, res) => {
  try {
    const query = typeof req.query.query === 'string' ? req.query.query : '';
    const stations = await metroService.searchStations(query);
    res.json({ success: true, count: stations.length, stations });
  } catch (error) {
    console.error('Metro stations error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Internal Server Error' });
  }
});

app.post('/api/metro/route', async (req, res) => {
  try {
    const from = req.body?.from;
    const to = req.body?.to;

    if (!from || !to || !from.name || !to.name || !Number.isFinite(from.lat) || !Number.isFinite(from.lng) || !Number.isFinite(to.lat) || !Number.isFinite(to.lng)) {
      return res.status(400).json({ error: 'Invalid from/to station' });
    }

    if (String(from.name).trim().toLowerCase() === String(to.name).trim().toLowerCase()) {
      return res.status(400).json({ error: 'From and To stations cannot be the same' });
    }

    const routes = await metroService.computeMetroRoutes(
      { id: String(from.id || ''), name: String(from.name), lat: Number(from.lat), lng: Number(from.lng) },
      { id: String(to.id || ''), name: String(to.name), lat: Number(to.lat), lng: Number(to.lng) }
    );

    res.json({ success: true, count: routes.length, routes });
  } catch (error) {
    console.error('Metro route error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Internal Server Error' });
  }
});

app.post('/api/metro/fare', async (req, res) => {
  try {
    const from = req.body?.from;
    const to = req.body?.to;

    if (!from || !to || !from.name || !to.name || !Number.isFinite(from.lat) || !Number.isFinite(from.lng) || !Number.isFinite(to.lat) || !Number.isFinite(to.lng)) {
      return res.status(400).json({ error: 'Invalid from/to station' });
    }

    const routes = await metroService.computeMetroRoutes(
      { id: String(from.id || ''), name: String(from.name), lat: Number(from.lat), lng: Number(from.lng) },
      { id: String(to.id || ''), name: String(to.name), lat: Number(to.lat), lng: Number(to.lng) }
    );

    res.json({
      success: true,
      count: routes.length,
      fares: routes.map((r) => r.fare_inr),
    });
  } catch (error) {
    console.error('Metro fare error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Internal Server Error' });
  }
});

app.post('/api/metro/time', async (req, res) => {
  try {
    const from = req.body?.from;
    const to = req.body?.to;

    if (!from || !to || !from.name || !to.name || !Number.isFinite(from.lat) || !Number.isFinite(from.lng) || !Number.isFinite(to.lat) || !Number.isFinite(to.lng)) {
      return res.status(400).json({ error: 'Invalid from/to station' });
    }

    const routes = await metroService.computeMetroRoutes(
      { id: String(from.id || ''), name: String(from.name), lat: Number(from.lat), lng: Number(from.lng) },
      { id: String(to.id || ''), name: String(to.name), lat: Number(to.lat), lng: Number(to.lng) }
    );

    res.json({
      success: true,
      count: routes.length,
      times: routes.map((r) => ({ seconds: r.total_duration_seconds, label: r.total_duration })),
    });
  } catch (error) {
    console.error('Metro time error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Internal Server Error' });
  }
});

app.post('/api/metro/travel-time', async (req, res) => {
  try {
    const from = req.body?.from;
    const to = req.body?.to;

    if (!from || !to || !from.name || !to.name || !Number.isFinite(from.lat) || !Number.isFinite(from.lng) || !Number.isFinite(to.lat) || !Number.isFinite(to.lng)) {
      return res.status(400).json({ error: 'Invalid from/to station' });
    }

    const routes = await metroService.computeMetroRoutes(
      { id: String(from.id || ''), name: String(from.name), lat: Number(from.lat), lng: Number(from.lng) },
      { id: String(to.id || ''), name: String(to.name), lat: Number(to.lat), lng: Number(to.lng) }
    );

    res.json({
      success: true,
      count: routes.length,
      times: routes.map((r) => ({ seconds: r.total_duration_seconds, label: r.total_duration })),
    });
  } catch (error) {
    console.error('Metro travel-time error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Internal Server Error' });
  }
});

app.get('/', (req, res) => {
  res.send('Backend Server is Running! 🚀<br>Please open the frontend application (usually at http://localhost:5173) to use the app.');
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Graceful Shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down...');
  await BrowserService.getInstance().close();
  process.exit(0);
});

export { app };

if (!isVercel && require.main === module) {
  app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
  });
}
