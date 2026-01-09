import os
import sys
import time
from dataclasses import dataclass, field
from typing import Callable, Dict, List, Tuple

import requests
from dotenv import load_dotenv

from geocode import geocode_place

load_dotenv()


@dataclass
class StationSegment:
    line_name: str
    vehicle_type: str
    departure_station: str
    arrival_station: str
    num_stops: int
    duration_seconds: int
    stations: List[str] = field(default_factory=list)

    @property
    def duration(self) -> str:
        return f"{self.duration_seconds // 60} mins"


@dataclass
class LineChange:
    station: str
    from_line: str
    to_line: str


@dataclass
class MetroRoute:
    total_duration_seconds: int
    total_distance_meters: int
    segments: List[StationSegment]
    line_changes: List[LineChange]

    @property
    def total_duration(self) -> str:
        return f"{self.total_duration_seconds // 60} mins"

    @property
    def metro_stations(self) -> List[str]:
        seen = set()
        ordered = []
        for segment in self.segments:
            for station in segment.stations:
                if station not in seen:
                    seen.add(station)
                    ordered.append(station)
        return ordered

    def as_dict(self) -> Dict:
        return {
            "total_duration_seconds": self.total_duration_seconds,
            "total_duration": self.total_duration,
            "total_distance_meters": self.total_distance_meters,
            "segments": [
                {
                    "line_name": s.line_name,
                    "vehicle_type": s.vehicle_type,
                    "departure_station": s.departure_station,
                    "arrival_station": s.arrival_station,
                    "num_stops": s.num_stops,
                    "duration_seconds": s.duration_seconds,
                    "duration": s.duration,
                    "stations": s.stations,
                }
                for s in self.segments
            ],
            "metro_stations": self.metro_stations,
            "line_changes": [
                {"station": c.station, "from_line": c.from_line, "to_line": c.to_line}
                for c in self.line_changes
            ],
        }


class MetroRouteService:
    endpoint = "https://routes.googleapis.com/directions/v2:computeRoutes"
    field_mask = "routes"

    def __init__(self, geocoder: Callable[[str], Tuple[float, float]] = geocode_place, api_key: str | None = None):
        self.api_key = api_key or os.getenv("GOOGLE_MAPS_API_KEY")
        if not self.api_key:
            raise EnvironmentError("GOOGLE_MAPS_API_KEY is not set in the environment")
        self.geocode = geocoder

    def compute_route(self, start_place: str, end_place: str) -> MetroRoute:
        origin = self._geocode(start_place)
        destination = self._geocode(end_place)
        payload = self._build_payload(origin, destination)
        route = self._fetch_route(payload)
        return self._parse_route(route)

    def _geocode(self, place: str) -> Tuple[float, float]:
        try:
            return self.geocode(place)
        except Exception as exc:
            raise ValueError(f"Geocoding failed: {exc}") from exc

    def _build_payload(self, origin: Tuple[float, float], destination: Tuple[float, float]) -> Dict:
        return {
            "origin": {"location": {"latLng": {"latitude": origin[0], "longitude": origin[1]}}},
            "destination": {"location": {"latLng": {"latitude": destination[0], "longitude": destination[1]}}},
            "travelMode": "TRANSIT",
            "transitPreferences": {"allowedTravelModes": ["SUBWAY"]},
            "departureTime": {"seconds": self._next_departure_seconds()},
            "computeAlternativeRoutes": False,
            "languageCode": "en",
            "regionCode": "IN",
        }

    def _headers(self) -> Dict[str, str]:
        return {
            "Content-Type": "application/json",
            "X-Goog-Api-Key": self.api_key,
            "X-Goog-FieldMask": self.field_mask,
        }

    def _fetch_route(self, payload: Dict) -> Dict:
        response = requests.post(self.endpoint, headers=self._headers(), json=payload, timeout=15)
        response.raise_for_status()
        data = response.json()
        routes = data.get("routes") or []
        if not routes:
            raise ValueError("No metro routes found between these locations")
        return routes[0]

    def _parse_route(self, route: Dict) -> MetroRoute:
        duration_seconds = self._parse_duration(route.get("duration", "0s"))
        distance_meters = route.get("distanceMeters", 0)
        segments = self._segments_from(route)
        line_changes = self._line_changes_from(segments)
        return MetroRoute(
            total_duration_seconds=duration_seconds,
            total_distance_meters=distance_meters,
            segments=segments,
            line_changes=line_changes,
        )

    def _segments_from(self, route: Dict) -> List[StationSegment]:
        segments: List[StationSegment] = []
        for leg in route.get("legs", []):
            for step in leg.get("steps", []):
                if step.get("travelMode") != "TRANSIT":
                    continue
                transit = step.get("transitDetails", {})
                stop_details = transit.get("stopDetails", {})
                transit_line = transit.get("transitLine", {})
                vehicle_type = transit_line.get("vehicle", {}).get("type", "SUBWAY")
                if vehicle_type not in {"SUBWAY", "RAIL"}:
                    continue
                departure_stop = stop_details.get("departureStop", {}).get("name", "Unknown")
                arrival_stop = stop_details.get("arrivalStop", {}).get("name", "Unknown")
                line_name = (
                    transit_line.get("nameShort")
                    or transit_line.get("name")
                    or transit.get("headsign")
                    or "Unknown Line"
                )
                stop_count = transit.get("stopCount", 0)
                duration_seconds = self._parse_duration(step.get("staticDuration", "0s"))
                intermediate = stop_details.get("intermediateStops", [])
                stations = [departure_stop]
                stations.extend([s.get("name") or "Unknown" for s in intermediate])
                stations.append(arrival_stop)
                segments.append(
                    StationSegment(
                        line_name=line_name,
                        vehicle_type=vehicle_type,
                        departure_station=departure_stop,
                        arrival_station=arrival_stop,
                        num_stops=stop_count,
                        duration_seconds=duration_seconds,
                        stations=stations,
                    )
                )
        return segments

    def _line_changes_from(self, segments: List[StationSegment]) -> List[LineChange]:
        changes: List[LineChange] = []
        for idx in range(1, len(segments)):
            prev_line = segments[idx - 1].line_name
            curr_line = segments[idx].line_name
            if prev_line != curr_line:
                changes.append(
                    LineChange(
                        station=segments[idx].departure_station,
                        from_line=prev_line,
                        to_line=curr_line,
                    )
                )
        return changes

    def _next_departure_seconds(self) -> int:
        now = time.localtime()
        if now.tm_hour >= 23:
            return int(time.mktime((
                now.tm_year,
                now.tm_mon,
                now.tm_mday + 1,
                10, 0, 0,
                now.tm_wday,
                now.tm_yday,
                now.tm_isdst,
            )))
        if now.tm_hour < 5:
            return int(time.mktime((
                now.tm_year,
                now.tm_mon,
                now.tm_mday,
                10, 0, 0,
                now.tm_wday,
                now.tm_yday,
                now.tm_isdst,
            )))
        target_hour = min(now.tm_hour + 1, 22)
        return int(time.mktime((
            now.tm_year,
            now.tm_mon,
            now.tm_mday,
            target_hour, 0, 0,
            now.tm_wday,
            now.tm_yday,
            now.tm_isdst,
        )))

    @staticmethod
    def _parse_duration(duration: str) -> int:
        return int(duration.replace("s", "")) if duration.endswith("s") else 0


def get_metro_route(start_place: str, end_place: str) -> Dict:
    service = MetroRouteService()
    return service.compute_route(start_place, end_place).as_dict()


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Usage: python metro_service.py <start_place> <end_place>")
        sys.exit(1)
    start_arg, end_arg = sys.argv[1], sys.argv[2]
    try:
        route = MetroRouteService().compute_route(start_arg, end_arg)
        import json
        print(json.dumps(route.as_dict(), indent=2))
    except Exception as e:
        print(f"Error: {e}")
        sys.exit(1)