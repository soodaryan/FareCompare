import express from 'express';
import cors from 'cors';
import path from 'path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'fs';
import { FareService } from './services/fare.service';
import { BusService } from './services/bus.service';
import { BrowserService } from './services/browser.service';
import { GeoLocation } from './interfaces/types';

const app = express();
const port = process.env.PORT || 3000;
const exec = promisify(execFile);

app.use(cors());
app.use(express.json());

const fareService = new FareService();
const busService = new BusService();

// Initialize Browser Service on startup
BrowserService.getInstance().init().catch(err => {
  console.error('Failed to initialize browser:', err);
});

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

app.post('/api/metro-route', async (req, res) => {
  try {
    const { originName, destinationName } = req.body;
    if (!originName || !destinationName) {
      return res.status(400).json({ error: 'originName and destinationName are required' });
    }

    const repoRoot = path.resolve(process.cwd(), '..');
    const venvPython = path.join(repoRoot, '.venv', 'bin', 'python');
    const pythonCmd = process.env.PYTHON_BIN || (fs.existsSync(venvPython) ? venvPython : 'python3');
    const scriptPath = path.join(process.cwd(), 'metro', 'metro_service.py');
    const { stdout } = await exec(pythonCmd, [scriptPath, originName, destinationName], {
      cwd: path.join(process.cwd(), 'metro'),
      env: process.env,
      maxBuffer: 1024 * 1024,
    });
    const route = JSON.parse(stdout);
    return res.json({ success: true, route });
  } catch (error) {
    console.error('Metro API Error:', error);
    return res.status(500).json({ error: 'Failed to compute metro route' });
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

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
