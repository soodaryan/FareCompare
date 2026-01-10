import os
import sys
import time
import requests
from geocode import geocode_place
from dotenv import load_dotenv

load_dotenv()


def get_metro_route(start_place: str, end_place: str) -> dict:
    api_key = os.getenv("GOOGLE_MAPS_API_KEY")
    if not api_key:
        raise EnvironmentError("GOOGLE_MAPS_API_KEY is not set in the environment")

    start_lat, start_lng = geocode_place(start_place)
    end_lat, end_lng = geocode_place(end_place)

    endpoint = "https://routes.googleapis.com/directions/v2:computeRoutes"

    headers = {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": api_key,
        "X-Goog-FieldMask": "routes",
    }

    def next_departure_seconds() -> int:
        now = time.localtime()
        if now.tm_hour >= 23:
            return int(
                time.mktime(
                    (
                        now.tm_year,
                        now.tm_mon,
                        now.tm_mday + 1,
                        10,
                        0,
                        0,
                        now.tm_wday,
                        now.tm_yday,
                        now.tm_isdst,
                    )
                )
            )
        if now.tm_hour < 5:
            return int(
                time.mktime(
                    (
                        now.tm_year,
                        now.tm_mon,
                        now.tm_mday,
                        10,
                        0,
                        0,
                        now.tm_wday,
                        now.tm_yday,
                        now.tm_isdst,
                    )
                )
            )
        target_hour = min(now.tm_hour + 1, 22)
        return int(
            time.mktime(
                (
                    now.tm_year,
                    now.tm_mon,
                    now.tm_mday,
                    target_hour,
                    0,
                    0,
                    now.tm_wday,
                    now.tm_yday,
                    now.tm_isdst,
                )
            )
        )

    body = {
        "origin": {"location": {"latLng": {"latitude": start_lat, "longitude": start_lng}}},
        "destination": {"location": {"latLng": {"latitude": end_lat, "longitude": end_lng}}},
        "travelMode": "TRANSIT",
        "transitPreferences": {"allowedTravelModes": ["SUBWAY"]},
        "departureTime": {"seconds": next_departure_seconds()},
        "computeAlternativeRoutes": False,
        "languageCode": "en",
        "regionCode": "IN",
    }

    response = requests.post(endpoint, headers=headers, json=body, timeout=15)
    response.raise_for_status()

    data = response.json()
    if "routes" not in data or not data["routes"]:
        raise ValueError("No metro routes found between these locations")

    route = data["routes"][0]

    duration_str = route.get("duration", "0s")
    duration_seconds = int(duration_str.replace("s", "")) if duration_str.endswith("s") else 0

    result = {
        "total_duration_seconds": duration_seconds,
        "total_duration": f"{duration_seconds // 60} mins",
        "total_distance_meters": route.get("distanceMeters", 0),
        "segments": [],
        "metro_stations": [],
        "line_changes": [],
    }

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

            step_duration_str = step.get("staticDuration", "0s")
            step_duration_sec = (
                int(step_duration_str.replace("s", "")) if step_duration_str.endswith("s") else 0
            )

            intermediate = stop_details.get("intermediateStops", [])
            stations_in_segment = [departure_stop]
            for s in intermediate:
                name = s.get("name") or "Unknown"
                stations_in_segment.append(name)
            stations_in_segment.append(arrival_stop)

            result["segments"].append(
                {
                    "line_name": line_name,
                    "vehicle_type": vehicle_type,
                    "departure_station": departure_stop,
                    "arrival_station": arrival_stop,
                    "num_stops": stop_count,
                    "duration_seconds": step_duration_sec,
                    "duration": f"{step_duration_sec // 60} mins",
                    "stations": stations_in_segment,
                }
            )

            for st in stations_in_segment:
                if st not in result["metro_stations"]:
                    result["metro_stations"].append(st)

    for i in range(1, len(result["segments"])):
        prev_line = result["segments"][i - 1]["line_name"]
        curr_line = result["segments"][i]["line_name"]
        if prev_line != curr_line:
            change_station = result["segments"][i]["departure_station"]
            result["line_changes"].append(
                {"station": change_station, "from_line": prev_line, "to_line": curr_line}
            )

    return result


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Usage: python metro_service.py <start_place> <end_place>")
        sys.exit(1)

    start_arg, end_arg = sys.argv[1], sys.argv[2]
    try:
        route = get_metro_route(start_arg, end_arg)
        import json

        print(json.dumps(route, indent=2))
    except Exception as e:
        print(f"Error: {e}")
        sys.exit(1)

