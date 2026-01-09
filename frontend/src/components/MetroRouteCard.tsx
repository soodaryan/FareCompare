import React from 'react';

interface MetroSegment {
  line_name: string;
  vehicle_type: string;
  departure_station: string;
  arrival_station: string;
  num_stops: number;
  duration_seconds: number;
  stations: string[];
}

interface LineChange {
  station: string;
  from_line: string;
  to_line: string;
}

interface MetroRoute {
  total_duration_seconds: number;
  total_distance_meters: number;
  segments: MetroSegment[];
  line_changes: LineChange[];
}

const formatMinutes = (seconds: number) => `${Math.round(seconds / 60)} mins`;
const formatKm = (meters: number) => `${(meters / 1000).toFixed(1)} km`;

export const MetroRouteCard: React.FC<{ route: MetroRoute }> = ({ route }) => {
  return (
    <div className="rounded-2xl border border-gray-200 shadow-sm bg-white p-4 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-gray-500">Total Duration</p>
          <p className="text-xl font-bold text-gray-900">{formatMinutes(route.total_duration_seconds)}</p>
        </div>
        <div className="text-right">
          <p className="text-sm text-gray-500">Distance</p>
          <p className="text-lg font-semibold text-gray-900">{formatKm(route.total_distance_meters)}</p>
        </div>
      </div>

      <div className="space-y-3">
        {route.segments.map((seg, idx) => (
          <div key={idx} className="p-3 rounded-xl bg-gray-50 border border-gray-200">
            <div className="flex items-center justify-between">
              <div className="font-semibold text-gray-900">{seg.line_name}</div>
              <span className="text-xs px-2 py-1 rounded-full bg-indigo-100 text-indigo-700">{seg.vehicle_type}</span>
            </div>
            <div className="mt-2 text-sm text-gray-700">
              <div className="flex items-center justify-between">
                <span>{seg.departure_station}</span>
                <span className="text-xs text-gray-500">{formatMinutes(seg.duration_seconds)}</span>
                <span>{seg.arrival_station}</span>
              </div>
              <p className="text-xs text-gray-500 mt-1">Stops: {seg.num_stops}</p>
              <p className="text-xs text-gray-500 mt-1 truncate">Stations: {seg.stations.join(' • ')}</p>
            </div>
          </div>
        ))}
      </div>

      {route.line_changes.length > 0 && (
        <div className="border-t border-gray-200 pt-3">
          <p className="text-sm font-semibold text-gray-900 mb-2">Line Changes</p>
          <ul className="space-y-2 text-sm text-gray-700">
            {route.line_changes.map((c, idx) => (
              <li key={idx} className="flex items-center justify-between">
                <span className="font-medium text-gray-800">{c.station}</span>
                <span className="text-xs text-gray-500">{c.from_line} → {c.to_line}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};
