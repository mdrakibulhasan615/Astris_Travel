import math
from typing import Optional
from .models import SmartScoreBreakdown, TransitOption, Voucher


def get_layover_multiplier(layover_hours: float) -> float:
    if layover_hours <= 0:
        return 0.0
    if layover_hours < 2:
        return 1.0
    if layover_hours < 6:
        return 1.5
    return 2.5


def get_mode_multiplier(is_overnight_sleeper: bool) -> float:
    return 0.4 if is_overnight_sleeper else 1.0


def calculate_voucher_discount(
    option: TransitOption, voucher: Optional[Voucher]
) -> float:
    if not voucher:
        return 0.0
    if option.mode not in voucher.applicable_modes:
        return 0.0
    if option.base_price_usd < voucher.min_spend_usd:
        return 0.0
    if (
        voucher.applicable_carriers
        and option.carrier_code not in voucher.applicable_carriers
    ):
        return 0.0

    discount = (
        (option.base_price_usd * voucher.discount_value) / 100.0
        if voucher.discount_type == "percentage"
        else voucher.discount_value
    )
    if voucher.max_discount_usd is not None:
        discount = min(discount, voucher.max_discount_usd)
    return round(min(discount, option.base_price_usd), 2)


def compute_weighted_smart_score(
    option: TransitOption,
    hourly_rate_usd: float,
    voucher: Optional[Voucher] = None,
) -> SmartScoreBreakdown:
    discount_applied = calculate_voucher_discount(option, voucher)
    discounted_price = round(max(0.0, option.base_price_usd - discount_applied), 2)
    mode_mult = get_mode_multiplier(option.is_overnight_sleeper)
    layover_mult = get_layover_multiplier(option.layover_hours)

    in_vehicle_penalty = round(option.in_vehicle_hours * hourly_rate_usd * mode_mult, 2)
    layover_penalty = round(option.layover_hours * hourly_rate_usd * layover_mult, 2)
    total_score = round(discounted_price + in_vehicle_penalty + layover_penalty, 2)

    return SmartScoreBreakdown(
        base_price_usd=option.base_price_usd,
        discount_applied_usd=discount_applied,
        discounted_price_usd=discounted_price,
        hourly_rate_usd=hourly_rate_usd,
        in_vehicle_hours=option.in_vehicle_hours,
        mode_multiplier=mode_mult,
        in_vehicle_penalty_usd=in_vehicle_penalty,
        layover_hours=option.layover_hours,
        layover_multiplier=layover_mult,
        layover_penalty_usd=layover_penalty,
        total_smart_score=total_score,
    )


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
