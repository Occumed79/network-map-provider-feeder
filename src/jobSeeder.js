import { query } from "./db.js";
import { logger } from "./logger.js";

const SERVICE_LINES = [
  ["occupational_health", "occupational health clinic", 90],
  ["occupational_medicine", "occupational medicine clinic", 90],
  ["pre_employment", "pre employment physical clinic", 80],
  ["dot_physical", "DOT physical clinic", 75],
  ["workers_comp", "workers compensation clinic", 70],
  ["physical_ability", "physical ability test clinic", 65],
  ["occupational_audiogram", "occupational health audiogram clinic", 60],
  ["occupational_spirometry", "occupational health spirometry clinic", 60],
].map(([key, phrase, priority]) => ({ key, phrase, priority }));

const CITY_ROWS = `
Los Angeles|CA|California|34.0522|-118.2437
San Diego|CA|California|32.7157|-117.1611
San Jose|CA|California|37.3382|-121.8863
San Francisco|CA|California|37.7749|-122.4194
Fresno|CA|California|36.7378|-119.7871
Sacramento|CA|California|38.5816|-121.4944
Long Beach|CA|California|33.7701|-118.1937
Oakland|CA|California|37.8044|-122.2712
Bakersfield|CA|California|35.3733|-119.0187
Anaheim|CA|California|33.8366|-117.9143
Riverside|CA|California|33.9806|-117.3755
Stockton|CA|California|37.9577|-121.2908
Dallas|TX|Texas|32.7767|-96.7970
Houston|TX|Texas|29.7604|-95.3698
San Antonio|TX|Texas|29.4241|-98.4936
Austin|TX|Texas|30.2672|-97.7431
Fort Worth|TX|Texas|32.7555|-97.3308
El Paso|TX|Texas|31.7619|-106.4850
Phoenix|AZ|Arizona|33.4484|-112.0740
Tucson|AZ|Arizona|32.2226|-110.9747
Mesa|AZ|Arizona|33.4152|-111.8315
Yuma|AZ|Arizona|32.6927|-114.6277
Las Vegas|NV|Nevada|36.1699|-115.1398
Reno|NV|Nevada|39.5296|-119.8138
Portland|OR|Oregon|45.5152|-122.6784
Seattle|WA|Washington|47.6062|-122.3321
Spokane|WA|Washington|47.6588|-117.4260
Denver|CO|Colorado|39.7392|-104.9903
Colorado Springs|CO|Colorado|38.8339|-104.8214
Salt Lake City|UT|Utah|40.7608|-111.8910
Boise|ID|Idaho|43.6150|-116.2023
Albuquerque|NM|New Mexico|35.0844|-106.6504
Oklahoma City|OK|Oklahoma|35.4676|-97.5164
Tulsa|OK|Oklahoma|36.1540|-95.9928
Kansas City|MO|Missouri|39.0997|-94.5786
St. Louis|MO|Missouri|38.6270|-90.1994
Wichita|KS|Kansas|37.6872|-97.3301
Omaha|NE|Nebraska|41.2565|-95.9345
Minneapolis|MN|Minnesota|44.9778|-93.2650
Chicago|IL|Illinois|41.8781|-87.6298
Indianapolis|IN|Indiana|39.7684|-86.1581
Detroit|MI|Michigan|42.3314|-83.0458
Milwaukee|WI|Wisconsin|43.0389|-87.9065
Cleveland|OH|Ohio|41.4993|-81.6944
Columbus|OH|Ohio|39.9612|-82.9988
Cincinnati|OH|Ohio|39.1031|-84.5120
Pittsburgh|PA|Pennsylvania|40.4406|-79.9959
Philadelphia|PA|Pennsylvania|39.9526|-75.1652
New York|NY|New York|40.7128|-74.0060
Buffalo|NY|New York|42.8864|-78.8784
Boston|MA|Massachusetts|42.3601|-71.0589
Providence|RI|Rhode Island|41.8240|-71.4128
Hartford|CT|Connecticut|41.7658|-72.6734
Newark|NJ|New Jersey|40.7357|-74.1724
Baltimore|MD|Maryland|39.2904|-76.6122
Washington|DC|District of Columbia|38.9072|-77.0369
Richmond|VA|Virginia|37.5407|-77.4360
Virginia Beach|VA|Virginia|36.8529|-75.9780
Charlotte|NC|North Carolina|35.2271|-80.8431
Raleigh|NC|North Carolina|35.7796|-78.6382
Charleston|SC|South Carolina|32.7765|-79.9311
Atlanta|GA|Georgia|33.7490|-84.3880
Savannah|GA|Georgia|32.0809|-81.0912
Jacksonville|FL|Florida|30.3322|-81.6557
Orlando|FL|Florida|28.5383|-81.3792
Tampa|FL|Florida|27.9506|-82.4572
Miami|FL|Florida|25.7617|-80.1918
Pensacola|FL|Florida|30.4213|-87.2169
Nashville|TN|Tennessee|36.1627|-86.7816
Memphis|TN|Tennessee|35.1495|-90.0490
Birmingham|AL|Alabama|33.5186|-86.8104
Mobile|AL|Alabama|30.6954|-88.0399
New Orleans|LA|Louisiana|29.9511|-90.0715
Baton Rouge|LA|Louisiana|30.4515|-91.1871
Jackson|MS|Mississippi|32.2988|-90.1848
Little Rock|AR|Arkansas|34.7465|-92.2896
`.trim();

const CITY_TARGETS = CITY_ROWS.split("\n").map((row) => {
  const [city, state, region, lat, lng] = row.split("|");
  return { city, state, region, lat: Number(lat), lng: Number(lng) };
});

function splitEnvList(value) {
  return (value || "").split(",").map((part) => part.trim()).filter(Boolean);
}

function chooseCities() {
  const states = new Set(splitEnvList(process.env.TARGET_STATES).map((state) => state.toUpperCase()));
  const cities = new Set(splitEnvList(process.env.TARGET_CITIES).map((city) => city.toLowerCase()));
  return CITY_TARGETS.filter((target) => {
    const cityKey = `${target.city} ${target.state}`.toLowerCase();
    const stateMatch = states.size === 0 || states.has(target.state.toUpperCase());
    const cityMatch = cities.size === 0 || cities.has(cityKey) || cities.has(target.city.toLowerCase());
    return stateMatch && cityMatch;
  });
}

function chooseServiceLines() {
  const enabled = new Set(splitEnvList(process.env.TARGET_SERVICE_LINES));
  return enabled.size === 0 ? SERVICE_LINES : SERVICE_LINES.filter((service) => enabled.has(service.key));
}

export function buildTargetedJobs({ maxJobs = 250 } = {}) {
  const radiusMeters = parseInt(process.env.DEFAULT_RADIUS_METERS || "40000", 10);
  const scraperDepth = parseInt(process.env.DEFAULT_SCRAPER_DEPTH || "1", 10);
  const scraperFastMode = process.env.DEFAULT_FAST_MODE === "1";
  const jobs = [];

  for (const city of chooseCities()) {
    for (const service of chooseServiceLines()) {
      jobs.push({
        query: `${service.phrase} in ${city.city} ${city.state}`,
        country_code: "US",
        region_name: city.region,
        service_line: service.key,
        priority: service.priority,
        target_lat: city.lat,
        target_lng: city.lng,
        radius_meters: radiusMeters,
        scraper_depth: scraperDepth,
        scraper_fast_mode: scraperFastMode,
      });
      if (jobs.length >= maxJobs) return jobs;
    }
  }

  return jobs;
}

export async function seedTargetedJobs({ maxJobs = 250, source = "auto_seed" } = {}) {
  const jobs = buildTargetedJobs({ maxJobs });
  let inserted = 0;

  for (const job of jobs) {
    const { rowCount } = await query(
      `INSERT INTO provider_feeder_jobs
        (query, country_code, region_name, service_line, priority, source,
         target_lat, target_lng, radius_meters, scraper_depth, scraper_fast_mode)
       SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11
       WHERE NOT EXISTS (
         SELECT 1 FROM provider_feeder_jobs
         WHERE lower(query) = lower($1)
           AND country_code = $2
           AND COALESCE(region_name, '') = COALESCE($3, '')
           AND COALESCE(service_line, '') = COALESCE($4, '')
       )`,
      [
        job.query,
        job.country_code,
        job.region_name,
        job.service_line,
        job.priority,
        source,
        job.target_lat,
        job.target_lng,
        job.radius_meters,
        job.scraper_depth,
        job.scraper_fast_mode,
      ]
    );
    inserted += rowCount;
  }

  logger.info("Targeted feeder jobs seeded", { attempted: jobs.length, inserted, source });
  return { attempted: jobs.length, inserted };
}

export async function ensureQueueBacklog({ minPending = 25, maxSeedJobs = 250 } = {}) {
  const { rows } = await query(
    `SELECT count(*)::int AS count
     FROM provider_feeder_jobs
     WHERE status IN ('pending','running')`
  );
  const activeCount = rows[0]?.count || 0;

  if (activeCount >= minPending) {
    logger.info("Queue already has enough active jobs", { activeCount, minPending });
    return { attempted: 0, inserted: 0, activeCount };
  }

  return { ...(await seedTargetedJobs({ maxJobs: maxSeedJobs, source: "auto_backlog" })), activeCount };
}
