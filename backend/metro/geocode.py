import os
import requests
from dotenv import load_dotenv
load_dotenv()
def geocode_place(place_name: str) -> tuple[float, float]:

    api_key = os.getenv("GOOGLE_MAPS_API_KEY")
    if not api_key:
        raise EnvironmentError(
            "GOOGLE_MAPS_API_KEY is not set in the environment"
        )

    endpoint = "https://maps.googleapis.com/maps/api/geocode/json"
    params = {
        "address": place_name,
        "key": api_key
    }

    response = requests.get(endpoint, params=params, timeout=10)
    response.raise_for_status()

    data = response.json()

    if data["status"] != "OK" or not data["results"]:
        raise ValueError(f"Geocoding failed: {data['status']}")

    location = data["results"][0]["geometry"]["location"]
    return location["lat"], location["lng"]
