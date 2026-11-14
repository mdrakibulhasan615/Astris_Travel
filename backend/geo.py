"""Geo helpers for the FastAPI service.

NOTE: Smart Score / VTTS scoring is intentionally NOT implemented in Python.
`shared/smartScore.ts` is the single canonical implementation (see ARCHITECTURE.md §5);
this service only stores and serves the breakdown objects it produces.
"""

import math


def haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> int:
    earth_radius_km = 6371.0
    d_lat = math.radians(lat2 - lat1)
    d_lng = math.radians(lng2 - lng1)
    a = (
        math.sin(d_lat / 2) ** 2
        + math.cos(math.radians(lat1))
        * math.cos(math.radians(lat2))
        * math.sin(d_lng / 2) ** 2
    )
    return round(earth_radius_km * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a)))
