import { Pool } from "pg";
import { PostgresAvailabilityStore } from "./stores/availability-store";

// ...before mounting the routes:
let availabilityStore;
if (process.env.DATABASE_URL) {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const pg = new PostgresAvailabilityStore(pool);
  await pg.init(); // skip if you use a migrations folder
  availabilityStore = pg;
} else {
  console.warn("DATABASE_URL not set: attestor availability is in-memory and will be lost on restart");
}
// pass it in: createAttestorsRouter(availabilityStore)  (or setAvailabilityStore(availabilityStore))
