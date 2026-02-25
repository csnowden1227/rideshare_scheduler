import dotenv from "dotenv";
dotenv.config();
import pg from "pg";

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function runMigrations() {
  const client = await pool.connect();
  try {
    console.log("🚀 Starting Database Migrations...");
    await client.query("BEGIN");

    // 1. UPDATE USERS TABLE
    console.log("Checking 'users' table...");
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        business_name TEXT,
        address TEXT,
        phone TEXT,
        maps_api_key TEXT,
        CRM_One_Source_api_key TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS tax_rate NUMERIC(5,2) DEFAULT 0;`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS peak_multiplier NUMERIC(4,2) DEFAULT 1.0;`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_booking_enabled BOOLEAN DEFAULT true;`);

    // 2. UPDATE SERVICES TABLE
    console.log("Checking 'services' table...");
    await client.query(`
      CREATE TABLE IF NOT EXISTS services (
        id SERIAL PRIMARY KEY,
        saas_location_staff_id TEXT,
        name TEXT,
        duration_min INTEGER DEFAULT 60,
        outbound_buffer_min INTEGER DEFAULT 15,
        min_notice_min INTEGER DEFAULT 120
      );
    `);

    // 🔒 BULLETPRROOF UNIQUE CONSTRAINT
    // We drop and re-add to ensure the constraint is named correctly and active
    console.log("Enforcing UNIQUE constraint on 'saas_location_staff_id'...");
    await client.query(`
      ALTER TABLE services DROP CONSTRAINT IF EXISTS services_saas_location_staff_id_key;
      ALTER TABLE services ADD CONSTRAINT services_saas_location_staff_id_key UNIQUE (saas_location_staff_id);
    `);

    await client.query(`ALTER TABLE services ADD COLUMN IF NOT EXISTS base_rate NUMERIC(10,2) DEFAULT 0;`);
    await client.query(`ALTER TABLE services ADD COLUMN IF NOT EXISTS per_mile_rate NUMERIC(10,2) DEFAULT 0;`);
    await client.query(`ALTER TABLE services ADD COLUMN IF NOT EXISTS minimum_fare NUMERIC(10,2) DEFAULT 0;`);
    await client.query(`ALTER TABLE services ADD COLUMN IF NOT EXISTS peak_multiplier NUMERIC(4,2) DEFAULT 1.0;`);
    await client.query(`ALTER TABLE services ADD COLUMN IF NOT EXISTS is_fixed BOOLEAN DEFAULT false;`);

    // 3. CREATE FIXED_RATES TABLE
    console.log("Creating 'fixed_rates' table...");
    await client.query(`
      CREATE TABLE IF NOT EXISTS fixed_rates (
          id SERIAL PRIMARY KEY,
          user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
          service_id INTEGER REFERENCES services(id) ON DELETE CASCADE,
          route_name TEXT,
          pickup_keyword TEXT,
          dropoff_keyword TEXT,
          fixed_price NUMERIC(10,2),
          is_active BOOLEAN DEFAULT true,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 4. CREATE OR UPDATE BOOKINGS TABLE
    console.log("Checking 'bookings' table...");
    await client.query(`
      CREATE TABLE IF NOT EXISTS bookings (
          id SERIAL PRIMARY KEY,
          user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
          service_id INTEGER REFERENCES services(id) ON DELETE CASCADE,
          start_time TIMESTAMP NOT NULL,
          end_time TIMESTAMP NOT NULL,
          pickup_address TEXT,
          dropoff_address TEXT,
          customer_email TEXT,
          first_name TEXT,
          last_name TEXT,
          phone TEXT,
          status TEXT DEFAULT 'confirmed',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Safely add/update total_price to bookings
    await client.query(`
      DO $$ 
      BEGIN 
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='bookings' AND column_name='total_price') THEN
          ALTER TABLE bookings ADD COLUMN total_price NUMERIC(10,2);
        ELSE
          ALTER TABLE bookings ALTER COLUMN total_price TYPE NUMERIC(10,2);
        END IF;
      END $$;
    `);

    await client.query("COMMIT");
    console.log("✅ Migrations complete! Your database is now 100% ready.");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Migration failed:", err.message);
  } finally {
    client.release();
    process.exit();
  }
}

runMigrations();