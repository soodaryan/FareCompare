import path from 'path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

type LatLng = { lat: number; lng: number };
type MetroProvider = 'google' | 'python';

export type MetroStation = {
  id: string;
  name: string;
  lat: number;
  lng: number;
};

export type MetroSegment = {
  line_name: string;
  vehicle_type: 'SUBWAY' | 'RAIL';
  departure_station: string;
  arrival_station: string;
  num_stops: number;
  duration_seconds: number;
  duration: string;
  stations: Array<{ name: string; lat: number; lng: number }>;
};

export type MetroRouteOption = {
  total_duration_seconds: number;
  total_duration: string;
  total_distance_meters: number;
  fare_inr: number | null;
  segments: MetroSegment[];
  metro_stations: Array<{ name: string; lat: number; lng: number }>;
  line_changes: Array<{ station: string; from_line: string; to_line: string }>;
};

export class MetroService {
  private stationCache = new Map<string, MetroStation[]>();
  private stationCoordCache = new Map<string, LatLng>();

  private getMetroProvider(): MetroProvider {
    const raw = String(process.env.METRO_PROVIDER || '').trim().toLowerCase();
    if (raw === 'python') return 'python';
    return 'google';
  }

  private getAzureMapsKey(): string {
    return (
      process.env.AZURE_MAPS_SUBSCRIPTION_KEY ||
      process.env.AZURE_MAPS_API_KEY ||
      process.env.MICROSOFT_MAPS_API_KEY ||
      ''
    );
  }

  private getGoogleRoutesKey(): string {
    return process.env.GOOGLE_ROUTES_API_KEY || process.env.GOOGLE_MAPS_API_KEY || '';
  }

  private async azureSearch(query: string, limit: number): Promise<Array<{ address: string; position: LatLng; id: string }>> {
    const key = this.getAzureMapsKey();
    if (!key) throw new Error('Azure Maps key missing in environment');

    const url = new URL('https://atlas.microsoft.com/search/address/json');
    url.searchParams.set('api-version', '1.0');
    url.searchParams.set('query', query);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('countrySet', 'IN');
    url.searchParams.set('subscription-key', key);
    url.searchParams.set('view', 'IN');

    const response = await fetch(url.toString());
    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || 'Azure Maps search failed');
    }
    const data = (await response.json()) as { results?: any[] };
    const results = Array.isArray(data?.results) ? data.results : [];
    return results
      .map((r) => ({
        id: String(r?.id ?? ''),
        address: String(r?.address?.freeformAddress ?? r?.poi?.name ?? r?.address?.streetName ?? ''),
        position: r?.position ? { lat: Number(r.position.lat), lng: Number(r.position.lon) } : null,
      }))
      .filter(
        (r): r is { id: string; address: string; position: LatLng } =>
          Boolean(r.address) &&
          r.position !== null &&
          Number.isFinite(r.position.lat) &&
          Number.isFinite(r.position.lng)
      )
      .map((r) => ({ id: r.id || `${r.position.lat},${r.position.lng}`, address: r.address, position: r.position }));
  }

  async searchStations(query: string): Promise<MetroStation[]> {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return [];

    const cached = this.stationCache.get(normalized);
    if (cached) return cached;

    const results = await this.azureSearch(`${query} metro station delhi`, 8);
    const stations = results.map((r) => ({
      id: r.id,
      name: r.address,
      lat: r.position.lat,
      lng: r.position.lng,
    }));

    this.stationCache.set(normalized, stations);
    return stations;
  }

  private async ensureStationCoord(stationName: string): Promise<LatLng | null> {
    const key = stationName.trim().toLowerCase();
    const cached = this.stationCoordCache.get(key);
    if (cached) return cached;

    const candidates = await this.azureSearch(`${stationName} metro station delhi`, 1);
    const first = candidates[0];
    if (!first) return null;

    this.stationCoordCache.set(key, first.position);
    return first.position;
  }

  private formatMins(seconds: number): string {
    const mins = Math.max(0, Math.round(seconds / 60));
    return `${mins} mins`;
  }

  private parseDurationSeconds(duration: unknown): number {
    if (typeof duration === 'string' && duration.endsWith('s')) {
      const n = Number(duration.slice(0, -1));
      return Number.isFinite(n) ? n : 0;
    }
    return 0;
  }

  private extractFareInr(route: any): number | null {
    const fare = route?.travelAdvisory?.transitFare;
    const currency = fare?.currencyCode;
    const units = typeof fare?.units === 'string' ? Number(fare.units) : typeof fare?.units === 'number' ? fare.units : 0;
    const nanos = typeof fare?.nanos === 'number' ? fare.nanos : 0;
    if (currency !== 'INR') return null;
    if (!Number.isFinite(units) || !Number.isFinite(nanos)) return null;
    const val = units + nanos / 1e9;
    if (!Number.isFinite(val)) return null;
    return Math.round(val);
  }

  private stationNameFromStop(stop: any): string {
    return String(stop?.name ?? 'Unknown');
  }

  private stationLatLngFromStop(stop: any): LatLng | null {
    const lat = stop?.location?.latLng?.latitude ?? stop?.location?.latitude ?? stop?.latLng?.latitude;
    const lng = stop?.location?.latLng?.longitude ?? stop?.location?.longitude ?? stop?.latLng?.longitude;
    const nLat = Number(lat);
    const nLng = Number(lng);
    if (!Number.isFinite(nLat) || !Number.isFinite(nLng)) return null;
    return { lat: nLat, lng: nLng };
  }

  private getPythonBin(): string {
    return process.env.PYTHON_BIN || 'python';
  }

  private getPythonMetroScriptPath(): string {
    return path.join(__dirname, '../../metro_services/metro_service.py');
  }

  private async computeMetroRoutesViaPython(fromName: string, toName: string): Promise<MetroRouteOption[]> {
    const scriptPath = this.getPythonMetroScriptPath();
    const pythonBin = this.getPythonBin();

    let stdout = '';
    try {
      const result = await execFileAsync(
        pythonBin,
        [scriptPath, fromName, toName],
        { windowsHide: true, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }
      );
      stdout = result.stdout || '';
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; message?: string };
      const detail = String(err.stderr || err.stdout || err.message || '').trim();
      throw new Error(detail || 'Python metro route failed');
    }

    let parsed: any;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new Error('Failed to parse python metro output');
    }

    const rawSegments = Array.isArray(parsed?.segments) ? parsed.segments : [];
    const stationNames = new Set<string>();
    for (const seg of rawSegments) {
      const stations = Array.isArray(seg?.stations) ? seg.stations : [];
      for (const s of stations) {
        const name = String(s || '').trim();
        if (name) stationNames.add(name);
      }
    }
    for (const s of Array.isArray(parsed?.metro_stations) ? parsed.metro_stations : []) {
      const name = String(s || '').trim();
      if (name) stationNames.add(name);
    }

    const coordByName = new Map<string, LatLng>();
    await Promise.all(
      Array.from(stationNames).map(async (name) => {
        const pos = await this.ensureStationCoord(name);
        if (pos) coordByName.set(name, pos);
      })
    );

    const segments: MetroSegment[] = rawSegments
      .map((seg: any) => {
        const lineName = String(seg?.line_name ?? 'Unknown Line');
        const vehicleType = String(seg?.vehicle_type ?? 'SUBWAY');
        const departureStation = String(seg?.departure_station ?? 'Unknown');
        const arrivalStation = String(seg?.arrival_station ?? 'Unknown');
        const numStops = typeof seg?.num_stops === 'number' ? seg.num_stops : 0;
        const durSec = typeof seg?.duration_seconds === 'number' ? seg.duration_seconds : 0;
        const stationPoints: Array<{ name: string; lat: number; lng: number }> = [];

        for (const s of Array.isArray(seg?.stations) ? seg.stations : []) {
          const name = String(s || '').trim();
          const pos = coordByName.get(name);
          if (!name || !pos) continue;
          stationPoints.push({ name, lat: pos.lat, lng: pos.lng });
        }

        if (stationPoints.length < 2) return null;
        return {
          line_name: lineName,
          vehicle_type: (vehicleType === 'RAIL' ? 'RAIL' : 'SUBWAY') as 'SUBWAY' | 'RAIL',
          departure_station: departureStation,
          arrival_station: arrivalStation,
          num_stops: numStops,
          duration_seconds: durSec,
          duration: this.formatMins(durSec),
          stations: stationPoints,
        };
      })
      .filter((s: MetroSegment | null): s is MetroSegment => Boolean(s));

    const metroStations: Array<{ name: string; lat: number; lng: number }> = Array.from(stationNames)
      .map((name) => {
        const pos = coordByName.get(name);
        if (!pos) return null;
        return { name, lat: pos.lat, lng: pos.lng };
      })
      .filter((s): s is { name: string; lat: number; lng: number } => Boolean(s));

    const totalDurationSec =
      typeof parsed?.total_duration_seconds === 'number'
        ? parsed.total_duration_seconds
        : typeof parsed?.total_duration === 'string'
          ? 0
          : 0;
    const totalDistanceMeters = typeof parsed?.total_distance_meters === 'number' ? parsed.total_distance_meters : 0;
    const lineChanges = Array.isArray(parsed?.line_changes) ? parsed.line_changes : [];

    const option: MetroRouteOption = {
      total_duration_seconds: totalDurationSec,
      total_duration: this.formatMins(totalDurationSec),
      total_distance_meters: totalDistanceMeters,
      fare_inr: null,
      segments,
      metro_stations: metroStations,
      line_changes: lineChanges
        .map((c: any) => ({
          station: String(c?.station ?? ''),
          from_line: String(c?.from_line ?? ''),
          to_line: String(c?.to_line ?? ''),
        }))
        .filter((c: { station: string }) => Boolean(c.station)),
    };

    return option.segments.length > 0 ? [option] : [];
  }

  async computeMetroRoutes(from: MetroStation, to: MetroStation): Promise<MetroRouteOption[]> {
    if (this.getMetroProvider() === 'python') {
      return this.computeMetroRoutesViaPython(from.name, to.name);
    }

    const key = this.getGoogleRoutesKey();
    if (!key) throw new Error('GOOGLE_ROUTES_API_KEY/GOOGLE_MAPS_API_KEY missing in environment');

    const endpoint = 'https://routes.googleapis.com/directions/v2:computeRoutes';
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask':
        'routes.duration,routes.distanceMeters,routes.legs.steps.travelMode,routes.legs.steps.staticDuration,routes.legs.steps.transitDetails,routes.travelAdvisory',
    };

    const departureSeconds = Math.floor(Date.now() / 1000) + 3600;

    const body = {
      origin: { location: { latLng: { latitude: from.lat, longitude: from.lng } } },
      destination: { location: { latLng: { latitude: to.lat, longitude: to.lng } } },
      travelMode: 'TRANSIT',
      transitPreferences: { allowedTravelModes: ['SUBWAY'] },
      departureTime: { seconds: departureSeconds },
      computeAlternativeRoutes: true,
      languageCode: 'en',
      regionCode: 'IN',
    };

    const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || 'Google Routes request failed');
    }

    const data = (await response.json()) as { routes?: any[] };
    const routes = Array.isArray(data?.routes) ? data.routes : [];
    if (routes.length === 0) return [];

    const options: MetroRouteOption[] = [];
    for (const route of routes) {
      const totalDurationSec = this.parseDurationSeconds(route?.duration);
      const totalDistance = typeof route?.distanceMeters === 'number' ? route.distanceMeters : 0;

      const segments: MetroSegment[] = [];
      const metroStations: Array<{ name: string; lat: number; lng: number }> = [];

      for (const leg of Array.isArray(route?.legs) ? route.legs : []) {
        for (const step of Array.isArray(leg?.steps) ? leg.steps : []) {
          if (step?.travelMode !== 'TRANSIT') continue;
          const transit = step?.transitDetails;
          const line = transit?.transitLine;
          const vehicleType = String(line?.vehicle?.type ?? 'SUBWAY');
          if (vehicleType !== 'SUBWAY' && vehicleType !== 'RAIL') continue;

          const stopDetails = transit?.stopDetails ?? {};
          const departureStop = stopDetails?.departureStop ?? {};
          const arrivalStop = stopDetails?.arrivalStop ?? {};
          const intermediateStops = Array.isArray(stopDetails?.intermediateStops) ? stopDetails.intermediateStops : [];

          const departureName = this.stationNameFromStop(departureStop);
          const arrivalName = this.stationNameFromStop(arrivalStop);

          const lineName =
            String(line?.nameShort || line?.name || transit?.headsign || 'Unknown Line');

          const stopCount = typeof transit?.stopCount === 'number' ? transit.stopCount : 0;
          const stepDurSec = this.parseDurationSeconds(step?.staticDuration);

          const stationStops = [departureStop, ...intermediateStops, arrivalStop];
          const stationPoints: Array<{ name: string; lat: number; lng: number }> = [];

          for (const st of stationStops) {
            const name = this.stationNameFromStop(st);
            let pos = this.stationLatLngFromStop(st);
            if (!pos) pos = await this.ensureStationCoord(name);
            if (!pos) continue;

            stationPoints.push({ name, lat: pos.lat, lng: pos.lng });
            if (!metroStations.some((s) => s.name === name)) {
              metroStations.push({ name, lat: pos.lat, lng: pos.lng });
            }
          }

          if (stationPoints.length < 2) continue;

          segments.push({
            line_name: lineName,
            vehicle_type: vehicleType as 'SUBWAY' | 'RAIL',
            departure_station: departureName,
            arrival_station: arrivalName,
            num_stops: stopCount,
            duration_seconds: stepDurSec,
            duration: this.formatMins(stepDurSec),
            stations: stationPoints,
          });
        }
      }

      const lineChanges: Array<{ station: string; from_line: string; to_line: string }> = [];
      for (let i = 1; i < segments.length; i++) {
        const prev = segments[i - 1];
        const curr = segments[i];
        if (prev.line_name !== curr.line_name) {
          lineChanges.push({
            station: curr.departure_station,
            from_line: prev.line_name,
            to_line: curr.line_name,
          });
        }
      }

      options.push({
        total_duration_seconds: totalDurationSec,
        total_duration: this.formatMins(totalDurationSec),
        total_distance_meters: totalDistance,
        fare_inr: this.extractFareInr(route),
        segments,
        metro_stations: metroStations,
        line_changes: lineChanges,
      });
    }

    return options.filter((o) => o.segments.length > 0);
  }
}
