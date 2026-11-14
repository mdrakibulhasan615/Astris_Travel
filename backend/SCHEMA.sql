-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. Users Table
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) UNIQUE NOT NULL,
    full_name VARCHAR(100),
    preferred_currency VARCHAR(3) DEFAULT 'USD',
    time_value_per_hour DECIMAL(6, 2) DEFAULT 15.00, -- Used for Smart Score penalty math
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 2. Trips Table
CREATE TABLE trips (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    title VARCHAR(150) NOT NULL,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    currency VARCHAR(3) DEFAULT 'USD',
    is_route_optimized BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 3. Trip Legs Table (Timeline stops + Map Coordinates)
CREATE TABLE trip_legs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    trip_id UUID REFERENCES trips(id) ON DELETE CASCADE,
    order_index INT NOT NULL, -- Sequence on timeline & numbered map pin (1, 2, 3...)
    
    -- Origin Stop Details
    origin_city VARCHAR(100) NOT NULL,
    origin_code VARCHAR(10) NOT NULL, -- e.g., KUL
    origin_lat DECIMAL(9, 6) NOT NULL,
    origin_lng DECIMAL(9, 6) NOT NULL,
    
    -- Destination Stop Details
    destination_city VARCHAR(100) NOT NULL,
    destination_code VARCHAR(10) NOT NULL, -- e.g., IST
    destination_lat DECIMAL(9, 6) NOT NULL,
    destination_lng DECIMAL(9, 6) NOT NULL,
    
    -- Timing & Selection
    departure_date DATE NOT NULL,
    nights_at_destination INT DEFAULT 3,
    selected_option_id UUID, -- References chosen TransitOption
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 4. Cached Transit Options (Flights, Trains, Buses, Ferries)
CREATE TABLE transit_options (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    leg_id UUID REFERENCES trip_legs(id) ON DELETE CASCADE,
    transport_mode VARCHAR(20) CHECK (transport_mode IN ('flight', 'train', 'bus', 'ferry')),
    provider_name VARCHAR(100) NOT NULL, -- e.g., Turkish Airlines, Eurostar
    
    -- Pricing & Vouchers
    base_price DECIMAL(10, 2) NOT NULL,
    discounted_price DECIMAL(10, 2),
    applied_voucher_id UUID,
    currency VARCHAR(3) DEFAULT 'USD',
    
    -- Duration & Smart Score
    departure_time TIMESTAMP WITH TIME ZONE NOT NULL,
    arrival_time TIMESTAMP WITH TIME ZONE NOT NULL,
    duration_minutes INT NOT NULL,
    layover_minutes INT DEFAULT 0,
    stops_count INT DEFAULT 0,
    smart_score DECIMAL(10, 2) NOT NULL, -- Lower is better: price + (hours * time_value)
    
    -- Booking & Cache TTL
    booking_url TEXT NOT NULL,
    raw_api_payload JSONB,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 5. Vouchers & Discounts Table
CREATE TABLE vouchers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    provider_name VARCHAR(100) NOT NULL,
    platform_source VARCHAR(100), -- e.g., Trip.com, Klook, Direct
    promo_code VARCHAR(50) NOT NULL,
    description TEXT,
    discount_type VARCHAR(20) CHECK (discount_type IN ('percentage', 'fixed')),
    discount_value DECIMAL(10, 2) NOT NULL,
    max_discount_cap DECIMAL(10, 2),
    min_spend DECIMAL(10, 2) DEFAULT 0.00,
    valid_from DATE,
    valid_until DATE,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Foreign Key Constraints
ALTER TABLE trip_legs 
    ADD CONSTRAINT fk_selected_option 
    FOREIGN KEY (selected_option_id) REFERENCES transit_options(id) ON DELETE SET NULL;

ALTER TABLE transit_options 
    ADD CONSTRAINT fk_applied_voucher 
    FOREIGN KEY (applied_voucher_id) REFERENCES vouchers(id) ON DELETE SET NULL;

-- Performance Indexes
CREATE INDEX idx_trip_legs_trip_order ON trip_legs(trip_id, order_index);
CREATE INDEX idx_transit_options_leg_score ON transit_options(leg_id, smart_score ASC);
CREATE INDEX idx_vouchers_active_provider ON vouchers(provider_name, is_active);
