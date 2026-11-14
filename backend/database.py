"""PostgreSQL persistence helpers aligned with backend/SCHEMA.sql."""

import os
from pathlib import Path
from typing import Optional

SCHEMA_PATH = Path(__file__).parent / "SCHEMA.sql"


def get_database_url() -> Optional[str]:
    """Return configured PostgreSQL connection URI (e.g., Supabase Postgres)."""
    return os.getenv("DATABASE_URL")


def load_schema_sql() -> str:
    """Load the DDL statements from SCHEMA.sql for migrations or bootstrap."""
    return SCHEMA_PATH.read_text(encoding="utf-8")


SQL_QUERIES = {
    "get_trip_by_id": """
        SELECT id, user_id, title, start_date, end_date, currency, is_route_optimized, created_at
        FROM trips
        WHERE id = %(trip_id)s;
    """,
    "get_trip_legs_ordered": """
        SELECT id, trip_id, order_index, origin_city, origin_code, origin_lat, origin_lng,
               destination_city, destination_code, destination_lat, destination_lng,
               departure_date, nights_at_destination, selected_option_id
        FROM trip_legs
        WHERE trip_id = %(trip_id)s
        ORDER BY order_index ASC;
    """,
    "get_cached_transit_options": """
        SELECT id, leg_id, transport_mode, provider_name, base_price, discounted_price,
               applied_voucher_id, currency, departure_time, arrival_time,
               duration_minutes, layover_minutes, stops_count, smart_score,
               booking_url, raw_api_payload, expires_at
        FROM transit_options
        WHERE leg_id = %(leg_id)s
          AND expires_at > NOW()
        ORDER BY smart_score ASC;
    """,
    "get_active_vouchers": """
        SELECT id, provider_name, platform_source, promo_code, description,
               discount_type, discount_value, max_discount_cap, min_spend,
               valid_from, valid_until, is_active
        FROM vouchers
        WHERE is_active = TRUE
          AND (valid_until IS NULL OR valid_until >= CURRENT_DATE);
    """,
}
