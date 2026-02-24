-- ===== SEED: SERVICES =====
-- SERVICES: upsert by name
insert into services (name, is_active)
values
('Airport Pickup', true),
('Point-to-Point', true)
on conflict (name) do update
set is_active = excluded.is_active;

-- DRIVERS: upsert by name (adjust if you want unique keys differently)
insert into drivers (name, home_base_address, google_calendar_id, is_active)
values
('Driver 1', 'Los Angeles, CA', 'primary', true),
('Driver 2', 'Los Angeles, CA', 'primary', true)
on conflict (name) do update
set home_base_address = excluded.home_base_address,
    google_calendar_id = excluded.google_calendar_id,
    is_active = excluded.is_active;
