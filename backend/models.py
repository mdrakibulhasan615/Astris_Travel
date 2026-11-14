from datetime import date, datetime
from typing import Any, Dict, List, Literal, Optional
from pydantic import BaseModel, Field

TransitMode = Literal["flight", "train", "bus", "ferry"]
VttsTier = Literal["backpacker", "explorer", "express", "custom"]
DiscountType = Literal["percentage", "fixed"]


class UserProfile(BaseModel):
    """Maps to PostgreSQL `users` table."""

    id: str
    email: str
    full_name: Optional[str] = None
    preferred_currency: str = Field(default="USD", min_length=3, max_length=3)
    time_value_per_hour: float = Field(default=15.0, ge=0, le=500)
    created_at: Optional[datetime] = None


ScoreFlag = Literal[
    "red-eye",
    "early-departure",
    "late-arrival",
    "long-layover",
    "overnight-layover",
    "multi-stop",
    "airport-change",
]


class TravelerProfile(BaseModel):
    """Mirror of `TravelerProfile` in shared/types.ts."""

    price_weight: float = Field(default=1.5, ge=0.1, le=5)
    time_weight: float = Field(default=1.0, ge=0.1, le=5)
    allow_red_eyes: bool = False


class SmartScoreBreakdown(BaseModel):
    """Mirror of `SmartScoreBreakdown` in shared/types.ts.

    Produced exclusively by shared/smartScore.ts (canonical); never recomputed in Python.
    """

    base_price_usd: float = Field(..., ge=0)
    discount_applied_usd: float = Field(0.0, ge=0)
    discounted_price_usd: float = Field(..., ge=0)
    hourly_rate_usd: float = Field(..., ge=0)
    in_vehicle_hours: float = Field(..., ge=0)
    mode_multiplier: float = Field(..., gt=0)
    in_vehicle_penalty_usd: float = Field(..., ge=0)
    layover_hours: float = Field(0.0, ge=0)
    layover_multiplier: float = Field(0.0, ge=0)
    layover_penalty_usd: float = Field(..., ge=0)
    time_of_day_multiplier: float = Field(1.0, ge=0)
    time_of_day_penalty_usd: float = Field(0.0, ge=0)
    transfer_penalty_usd: float = Field(0.0, ge=0)
    airport_change_penalty_usd: float = Field(0.0, ge=0)
    price_weight: float = Field(1.5, ge=0)
    time_weight: float = Field(1.0, ge=0)
    flags: List[ScoreFlag] = Field(default_factory=list)
    total_smart_score: float = Field(..., ge=0)


class TripStop(BaseModel):
    id: str
    order: int = Field(..., ge=1)
    city: str
    country: str
    iata_code: str = Field(..., min_length=3, max_length=4)
    lat: float = Field(..., ge=-90, le=90)
    lng: float = Field(..., ge=-180, le=180)
    stay_nights: int = Field(..., ge=0)
    arrival_date: str
    departure_date: str
    notes: Optional[str] = None


class TransitOption(BaseModel):
    """Maps to PostgreSQL `transit_options` table."""

    id: str
    leg_id: Optional[str] = None
    mode: TransitMode
    is_overnight_sleeper: bool = False
    carrier: str
    carrier_code: str
    route_code: str
    origin_station: str
    destination_station: str
    departure_time: str
    arrival_time: str
    in_vehicle_hours: float = Field(..., ge=0)
    layover_hours: float = Field(0.0, ge=0)
    layover_hub: Optional[str] = None
    stops_count: int = Field(0, ge=0)
    base_price_usd: float = Field(..., ge=0)
    discounted_price_usd: float = Field(..., ge=0)
    currency: str = Field(default="USD", min_length=3, max_length=3)
    smart_score: float = Field(..., ge=0)
    smart_score_breakdown: SmartScoreBreakdown
    door_to_door_notes: str
    co2_kg: int = Field(..., ge=0)
    booking_url: Optional[str] = None
    raw_api_payload: Optional[Dict[str, Any]] = None
    expires_at: Optional[datetime] = None
    eligible_voucher_ids: List[str] = Field(default_factory=list)
    applied_voucher_id: Optional[str] = None


class TripLeg(BaseModel):
    """Maps to PostgreSQL `trip_legs` table."""

    id: str
    trip_id: Optional[str] = None
    order_index: Optional[int] = None
    from_stop_id: str
    to_stop_id: str
    from_city: str
    from_code: str
    origin_lat: Optional[float] = None
    origin_lng: Optional[float] = None
    to_city: str
    to_code: str
    destination_lat: Optional[float] = None
    destination_lng: Optional[float] = None
    departure_date: Optional[date] = None
    nights_at_destination: Optional[int] = None
    distance_km: int = Field(..., ge=0)
    selected_option_id: str
    transit_options: List[TransitOption]


class Voucher(BaseModel):
    """Maps to PostgreSQL `vouchers` table."""

    id: str
    code: str
    provider_name: Optional[str] = None
    platform_source: Optional[str] = None
    title: str
    discount_type: DiscountType
    discount_value: float = Field(..., gt=0)
    max_discount_usd: Optional[float] = Field(default=None, ge=0)
    min_spend_usd: float = Field(0.0, ge=0)
    applicable_modes: List[TransitMode]
    applicable_carriers: Optional[List[str]] = None
    valid_from: Optional[str] = None
    expires_at: str
    is_active: bool = True
    description: str


class Trip(BaseModel):
    """Maps to PostgreSQL `trips` table."""

    id: str
    user_id: Optional[str] = None
    title: str
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    travelers: int = Field(1, ge=1)
    currency: Literal["USD"] = "USD"
    is_route_optimized: bool = False
    vtts_tier: VttsTier = "explorer"
    hourly_time_value: float = Field(15.0, ge=0, le=200)
    traveler_profile: Optional[TravelerProfile] = None
    stops: List[TripStop]
    legs: List[TripLeg]
    applied_voucher_codes: List[str] = Field(default_factory=list)


class OptimizeRouteRequest(BaseModel):
    stops: List[TripStop]
    hourly_time_value: float = Field(15.0, ge=0, le=200)
    traveler_profile: Optional[TravelerProfile] = None
    applied_voucher_codes: List[str] = Field(default_factory=list)
    lock_origin: bool = True
