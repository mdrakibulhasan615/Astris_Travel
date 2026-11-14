import itertools
import json
from pathlib import Path
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from .models import OptimizeRouteRequest, Trip, Voucher
from .smart_score import haversine_km

app = FastAPI(title="Astris Travel API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

DATA_PATH = Path(__file__).parent / "data" / "mock_trip.json"


def load_mock_data() -> dict:
    with DATA_PATH.open("r", encoding="utf-8") as f:
        return json.load(f)


@app.get("/api/trips/default", response_model=Trip)
def get_default_trip():
    data = load_mock_data()
    return Trip(**data["trip"])


@app.get("/api/vouchers", response_model=list[Voucher])
def list_vouchers():
    data = load_mock_data()
    return [Voucher(**v) for v in data["vouchers"]]


@app.post("/api/optimize-route")
def optimize_route(payload: OptimizeRouteRequest):
    """Two-stage route optimizer: Stage 1 filters permutations by great-circle distance."""
    stops = payload.stops
    if len(stops) <= 2:
        return {"already_optimal": True, "optimized_stops": stops}

    fixed_origin = stops[0] if payload.lock_origin else None
    permutable = stops[1:] if payload.lock_origin else stops

    scored_paths = []
    for perm in itertools.permutations(permutable):
        candidate = ([fixed_origin] + list(perm)) if fixed_origin else list(perm)
        total_km = sum(
            haversine_km(candidate[i].lat, candidate[i].lng, candidate[i + 1].lat, candidate[i + 1].lng)
            for i in range(len(candidate) - 1)
        )
        scored_paths.append((total_km, candidate))

    scored_paths.sort(key=lambda item: item[0])
    best_km, best_stops = scored_paths[0]
    return {
        "optimized_distance_km": best_km,
        "optimized_stops": [s.model_dump() for s in best_stops],
        "candidates_evaluated": len(scored_paths),
    }
