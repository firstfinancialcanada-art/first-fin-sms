// ============================================================
// Seed Inventory — Loads your current inventory into PostgreSQL
// Run once: node seed-inventory.js
// ============================================================
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Your current inventory (extracted from index.html)
const inventory = [
{"stock":"AM24036","year":2023,"make":"JEEP","model":"COMPASS","mileage":69200,"price":35980,"condition":"Average","carfax":0,"type":"4x4"},
{"stock":"AM24042","year":2024,"make":"MERCEDES-BENZ","model":"GLE","mileage":20057,"price":72980,"condition":"Clean","carfax":0,"type":"4MATIC SUV"},
{"stock":"AM24051A","year":2013,"make":"BMW","model":"X5","mileage":151000,"price":14980,"condition":"Rough","carfax":0,"type":"AWD 4dr"},
{"stock":"AM24074A","year":2016,"make":"HYUNDAI","model":"SANTA FE SPORT","mileage":181852,"price":15980,"condition":"Rough","carfax":0,"type":"AWD 4dr 2.4L"},
{"stock":"AM24137A","year":2015,"make":"MERCEDES-BENZ","model":"C-CLASS","mileage":116603,"price":19980,"condition":"Average","carfax":0,"type":"4dr Sdn 4MATIC"},
{"stock":"AM24256","year":2020,"make":"FORD","model":"FUSION ENERGI","mileage":98225,"price":21980,"condition":"Average","carfax":0,"type":"FWD"},
{"stock":"AM24277","year":2022,"make":"JEEP","model":"GRAND CHEROKEE 4XE","mileage":42552,"price":53980,"condition":"Clean","carfax":0,"type":"4x4"},
{"stock":"AM24340A","year":2019,"make":"FORD","model":"FUSION HYBRID","mileage":137792,"price":23980,"condition":"Rough","carfax":0,"type":"FWD"},
{"stock":"AM24346","year":2023,"make":"FORD","model":"F-150","mileage":117088,"price":40980,"condition":"Average","carfax":0,"type":"4WD SuperCrew 6.5' Box"},
{"stock":"AM24423","year":2022,"make":"RAM","model":"1500","mileage":51640,"price":56980,"condition":"Average","carfax":0,"type":"4x4 Crew Cab"},
{"stock":"AM24441","year":2024,"make":"JEEP","model":"WRANGLER 4XE","mileage":40966,"price":59980,"condition":"Clean","carfax":0,"type":"4 Door 4x4"},
{"stock":"AM24446","year":2023,"make":"GMC","model":"TERRAIN","mileage":74041,"price":30980,"condition":"Average","carfax":0,"type":"AWD 4dr"},
{"stock":"AM24448","year":2018,"make":"KIA","model":"SOUL EV","mileage":115313,"price":15980,"condition":"Average","carfax":0,"type":"FWD"},
{"stock":"AM24692","year":2022,"make":"TOYOTA","model":"COROLLA","mileage":73839,"price":23980,"condition":"Average","carfax":0,"type":"CVT"},
{"stock":"AM24700","year":2019,"make":"FORD","model":"F-150","mileage":121814,"price":27980,"condition":"Rough","carfax":0,"type":"4WD SuperCab"},
{"stock":"AM24705","year":2017,"make":"TOYOTA","model":"HIGHLANDER HYBRID","mileage":101027,"price":34980,"condition":"Average","carfax":0,"type":"AWD 4dr"},
{"stock":"AM24706","year":2023,"make":"CHEVROLET","model":"SILVERADO 3500HD","mileage":159673,"price":57980,"condition":"Rough","carfax":0,"type":"4WD Crew Cab"},
{"stock":"AM24710","year":2017,"make":"VOLKSWAGEN","model":"GOLF GTI","mileage":108673,"price":21980,"condition":"Average","carfax":0,"type":"5dr HB DSG"},
{"stock":"AM24730","year":2024,"make":"NISSAN","model":"ROGUE","mileage":58789,"price":31980,"condition":"Average","carfax":0,"type":"AWD"},
{"stock":"AM24734","year":2022,"make":"CHEVROLET","model":"CORVETTE","mileage":14744,"price":107980,"condition":"Clean","carfax":0,"type":"2dr Stingray"},
{"stock":"AM24742","year":1966,"make":"CHEVROLET","model":"CORVETTE","mileage":690,"price":249980,"condition":"Clean","carfax":0,"type":"Classic"},
{"stock":"AM24754","year":2024,"make":"NISSAN","model":"ALTIMA","mileage":12977,"price":27980,"condition":"Clean","carfax":0,"type":"AWD"},
{"stock":"AM24758","year":2023,"make":"CHRYSLER","model":"PACIFICA","mileage":62607,"price":36980,"condition":"Average","carfax":0,"type":"FWD"},
{"stock":"AM24762","year":2023,"make":"FORD","model":"EDGE","mileage":98095,"price":30980,"condition":"Average","carfax":0,"type":"AWD"},
{"stock":"AM24765","year":2024,"make":"CHEVROLET","model":"MALIBU","mileage":9389,"price":25980,"condition":"Clean","carfax":0,"type":"4dr Sdn"},
{"stock":"AM24772","year":2022,"make":"CHEVROLET","model":"SILVERADO 3500HD","mileage":111482,"price":66980,"condition":"Average","carfax":0,"type":"4WD Crew Cab"},
{"stock":"AM24778","year":2022,"make":"RAM","model":"1500","mileage":107305,"price":42980,"condition":"Average","carfax":0,"type":"4x4 Crew Cab"},
{"stock":"AM24791","year":2023,"make":"CHRYSLER","model":"300","mileage":54463,"price":32980,"condition":"Average","carfax":0,"type":"AWD"},
{"stock":"AM24794","year":2023,"make":"FORD","model":"EXPLORER","mileage":80249,"price":42980,"condition":"Average","carfax":0,"type":"4WD"},
{"stock":"AM24795","year":2022,"make":"HYUNDAI","model":"VENUE","mileage":91171,"price":21980,"condition":"Average","carfax":0,"type":"IVT"},
{"stock":"AM24800","year":2022,"make":"BMW","model":"X3","mileage":81442,"price":36980,"condition":"Average","carfax":0,"type":"SAV"},
{"stock":"AM24811","year":2024,"make":"PORSCHE","model":"TAYCAN","mileage":10914,"price":114980,"condition":"Clean","carfax":0,"type":"Cross Turismo AWD"},
{"stock":"AM24819","year":2022,"make":"HYUNDAI","model":"VENUE","mileage":83506,"price":21980,"condition":"Average","carfax":0,"type":"IVT"},
{"stock":"AM24826","year":2021,"make":"DODGE","model":"CHARGER","mileage":79910,"price":35980,"condition":"Average","carfax":0,"type":"AWD"},
{"stock":"AM24833","year":2023,"make":"AUDI","model":"A3 SEDAN","mileage":83871,"price":35980,"condition":"Average","carfax":0,"type":"40 TFSI"},
{"stock":"AM24839","year":2023,"make":"FORD","model":"F-150","mileage":82651,"price":45980,"condition":"Average","carfax":0,"type":"4WD SuperCrew"},
{"stock":"AM24846","year":2023,"make":"NISSAN","model":"ALTIMA","mileage":88984,"price":31980,"condition":"Average","carfax":0,"type":"AWD"},
{"stock":"AM24852","year":2023,"make":"FORD","model":"ESCAPE","mileage":72807,"price":32980,"condition":"Average","carfax":0,"type":"AWD"},
{"stock":"AM24860","year":2024,"make":"NISSAN","model":"KICKS","mileage":54990,"price":24980,"condition":"Average","carfax":0,"type":"FWD"},
{"stock":"AM24861","year":2024,"make":"NISSAN","model":"KICKS","mileage":58519,"price":24980,"condition":"Average","carfax":0,"type":"FWD"},
{"stock":"AM24866","year":2024,"make":"CHEVROLET","model":"MALIBU","mileage":65673,"price":26980,"condition":"Average","carfax":0,"type":"4dr Sdn"},
{"stock":"AM24868","year":2024,"make":"NISSAN","model":"PATHFINDER","mileage":58604,"price":41980,"condition":"Average","carfax":0,"type":"4WD"},
{"stock":"AM24876","year":2024,"make":"MAZDA","model":"CX-5","mileage":49437,"price":35980,"condition":"Clean","carfax":0,"type":"AWD"},
{"stock":"AM24885","year":2024,"make":"MAZDA","model":"CX-5","mileage":45614,"price":36980,"condition":"Clean","carfax":0,"type":"AWD"},
{"stock":"AM24891","year":2024,"make":"NISSAN","model":"PATHFINDER","mileage":61104,"price":41980,"condition":"Average","carfax":0,"type":"4WD"},
{"stock":"AM24892","year":2024,"make":"NISSAN","model":"ALTIMA","mileage":54866,"price":28980,"condition":"Average","carfax":0,"type":"AWD"},
{"stock":"AM24898","year":2023,"make":"FORD","model":"F-150","mileage":44140,"price":46980,"condition":"Clean","carfax":0,"type":"4WD SuperCrew"},
{"stock":"AM24899","year":2024,"make":"CHEVROLET","model":"SUBURBAN","mileage":73272,"price":66980,"condition":"Average","carfax":0,"type":"4WD 4dr"},
{"stock":"AM24908","year":2024,"make":"MITSUBISHI","model":"OUTLANDER PHEV","mileage":51023,"price":41980,"condition":"Average","carfax":0,"type":"S-AWC"},
{"stock":"AM24911","year":2025,"make":"NISSAN","model":"KICKS PLAY","mileage":16402,"price":27980,"condition":"Clean","carfax":0,"type":"FWD"},
{"stock":"AM24915","year":2024,"make":"VOLKSWAGEN","model":"TIGUAN","mileage":65372,"price":33980,"condition":"Average","carfax":0,"type":"4MOTION"},
{"stock":"AM24925","year":2023,"make":"AUDI","model":"A4 SEDAN","mileage":81388,"price":37980,"condition":"Average","carfax":0,"type":"40 TFSI"},
{"stock":"AM24981","year":2023,"make":"FORD","model":"F-150","mileage":51751,"price":62980,"condition":"Average","carfax":0,"type":"4WD SuperCrew"},
{"stock":"AM24982","year":2022,"make":"MAZDA","model":"MX-5","mileage":24551,"price":32980,"condition":"Clean","carfax":0,"type":"Manual"},
{"stock":"AM24984","year":2024,"make":"MAZDA","model":"CX-5","mileage":45876,"price":37980,"condition":"Clean","carfax":0,"type":"AWD"},
{"stock":"AM24992","year":2023,"make":"FORD","model":"F-150","mileage":79306,"price":46980,"condition":"Average","carfax":0,"type":"4WD SuperCrew"},
{"stock":"AM24995","year":2023,"make":"HYUNDAI","model":"SANTA FE","mileage":80833,"price":32980,"condition":"Average","carfax":0,"type":"AWD"},
{"stock":"AM24996","year":2023,"make":"JEEP","model":"GRAND CHEROKEE","mileage":80925,"price":39980,"condition":"Average","carfax":0,"type":"4x4"},
{"stock":"AM24997","year":2025,"make":"MAZDA","model":"CX-70 MHEV","mileage":41436,"price":48980,"condition":"Clean","carfax":0,"type":"AWD"},
{"stock":"AM25011","year":2024,"make":"VOLKSWAGEN","model":"TAOS","mileage":51086,"price":28980,"condition":"Average","carfax":0,"type":"FWD"},
{"stock":"AM25013","year":2021,"make":"RAM","model":"1500 CLASSIC","mileage":123020,"price":36980,"condition":"Rough","carfax":0,"type":"4x4 Crew Cab"},
{"stock":"AM25016A","year":2021,"make":"MERCEDES-BENZ","model":"GLA-CLASS","mileage":69067,"price":39980,"condition":"Average","carfax":0,"type":"4MATIC"},
{"stock":"AM25017","year":2023,"make":"TOYOTA","model":"CAMRY","mileage":81616,"price":32980,"condition":"Average","carfax":0,"type":"Auto"},
{"stock":"AM25019","year":2024,"make":"VOLKSWAGEN","model":"TIGUAN","mileage":54626,"price":42980,"condition":"Average","carfax":0,"type":"4MOTION"},
{"stock":"AM25023","year":2024,"make":"NISSAN","model":"KICKS","mileage":70289,"price":24980,"condition":"Average","carfax":0,"type":"FWD"},
{"stock":"AM25033","year":2024,"make":"VOLKSWAGEN","model":"TAOS","mileage":83884,"price":29980,"condition":"Average","carfax":0,"type":"FWD"},
{"stock":"AM25041","year":2022,"make":"HYUNDAI","model":"KONA","mileage":103433,"price":31980,"condition":"Average","carfax":0,"type":"1.6T AWD"},
{"stock":"AM25047","year":2023,"make":"JEEP","model":"WRANGLER","mileage":84660,"price":54980,"condition":"Average","carfax":0,"type":"4 Door 4x4"},
{"stock":"AM25048","year":2023,"make":"JEEP","model":"WRANGLER","mileage":86702,"price":54980,"condition":"Average","carfax":0,"type":"4 Door 4x4"},
{"stock":"AM25057","year":2023,"make":"VOLKSWAGEN","model":"JETTA","mileage":75281,"price":26980,"condition":"Average","carfax":0,"type":"Auto"},
{"stock":"AM25064","year":2023,"make":"FORD","model":"EDGE","mileage":82715,"price":35980,"condition":"Average","carfax":0,"type":"AWD"},
{"stock":"AM25065","year":2023,"make":"FORD","model":"EXPEDITION","mileage":107617,"price":64980,"condition":"Average","carfax":0,"type":"4x4"},
{"stock":"AM25070","year":2021,"make":"FORD","model":"F-150","mileage":153432,"price":36980,"condition":"Rough","carfax":0,"type":"4WD SuperCrew"},
{"stock":"AM25080","year":2022,"make":"RAM","model":"1500 CLASSIC","mileage":96878,"price":39980,"condition":"Average","carfax":0,"type":"4x4 Crew Cab"},
{"stock":"AM25083","year":2024,"make":"NISSAN","model":"SENTRA","mileage":70147,"price":25980,"condition":"Average","carfax":0,"type":"CVT"},
{"stock":"AM25087","year":2022,"make":"CHEVROLET","model":"SILVERADO 3500HD","mileage":154389,"price":72980,"condition":"Rough","carfax":0,"type":"4WD Crew Cab"},
{"stock":"AM25099","year":2023,"make":"RAM","model":"3500","mileage":254769,"price":59980,"condition":"Rough","carfax":0,"type":"4x4 Crew Cab"},
{"stock":"AM25107A","year":2021,"make":"VOLKSWAGEN","model":"PASSAT","mileage":127862,"price":23980,"condition":"Rough","carfax":0,"type":"Auto"},
{"stock":"AM25118","year":2025,"make":"MAZDA","model":"CX-90 MHEV","mileage":63858,"price":44980,"condition":"Average","carfax":0,"type":"AWD"},
{"stock":"AM25119","year":2023,"make":"MERCEDES-BENZ","model":"GLB","mileage":71503,"price":38980,"condition":"Average","carfax":0,"type":"4MATIC SUV"},
{"stock":"AM25121","year":2023,"make":"NISSAN","model":"QASHQAI","mileage":68354,"price":28980,"condition":"Average","carfax":0,"type":"AWD CVT"},
{"stock":"AM25128","year":2024,"make":"FORD","model":"ESCAPE","mileage":70191,"price":29980,"condition":"Average","carfax":0,"type":"AWD"},
{"stock":"AM25132","year":2024,"make":"CHRYSLER","model":"GRAND CARAVAN","mileage":73844,"price":37980,"condition":"Average","carfax":0,"type":"2WD"},
{"stock":"AM25134","year":2023,"make":"RAM","model":"1500 CLASSIC","mileage":50733,"price":38980,"condition":"Average","carfax":0,"type":"4x4 Crew Cab"},
{"stock":"AM25145","year":2024,"make":"CHEVROLET","model":"SILVERADO 1500","mileage":36559,"price":63980,"condition":"Clean","carfax":0,"type":"4WD Crew Cab"},
{"stock":"AM25146","year":2023,"make":"CHEVROLET","model":"TRAILBLAZER","mileage":79294,"price":28980,"condition":"Average","carfax":0,"type":"AWD 4dr"},
{"stock":"AM25147","year":2021,"make":"MERCEDES-BENZ","model":"GLC","mileage":82021,"price":34980,"condition":"Average","carfax":0,"type":"4MATIC SUV"},
{"stock":"AM25150","year":2025,"make":"FORD","model":"BRONCO","mileage":23547,"price":67980,"condition":"Clean","carfax":0,"type":"4 Door 4x4"},
{"stock":"AM25153","year":2022,"make":"RAM","model":"1500 CLASSIC","mileage":121975,"price":37980,"condition":"Rough","carfax":0,"type":"4x4 Crew Cab"},
{"stock":"AM25155","year":2022,"make":"CHRYSLER","model":"300","mileage":62927,"price":27980,"condition":"Average","carfax":0,"type":"RWD"},
{"stock":"AM25158","year":2023,"make":"HYUNDAI","model":"SONATA","mileage":80082,"price":28980,"condition":"Average","carfax":0,"type":"1.6T"},
{"stock":"AM25159","year":2024,"make":"FORD","model":"BRONCO SPORT","mileage":55000,"price":33980,"condition":"Average","carfax":0,"type":"4x4"},
{"stock":"AM25224","year":2023,"make":"CHEVROLET","model":"SILVERADO 1500","mileage":62062,"price":53980,"condition":"Average","carfax":0,"type":"4WD Crew Cab"},
{"stock":"AM25225","year":2024,"make":"CHEVROLET","model":"MALIBU","mileage":64503,"price":25980,"condition":"Average","carfax":0,"type":"4dr Sdn"},
{"stock":"AM25227","year":2024,"make":"FORD","model":"BRONCO SPORT","mileage":65345,"price":32980,"condition":"Average","carfax":0,"type":"4x4"},
{"stock":"AM25232","year":2023,"make":"CHEVROLET","model":"EQUINOX","mileage":75641,"price":28980,"condition":"Average","carfax":0,"type":"AWD 4dr"},
{"stock":"AM25237","year":2021,"make":"DODGE","model":"DURANGO","mileage":73859,"price":35980,"condition":"Average","carfax":0,"type":"AWD"},
{"stock":"AM25239","year":2024,"make":"NISSAN","model":"SENTRA","mileage":35511,"price":28980,"condition":"Clean","carfax":0,"type":"CVT"},
{"stock":"AM25241","year":2024,"make":"MITSUBISHI","model":"RVR","mileage":66544,"price":28980,"condition":"Average","carfax":0,"type":"AWC"},
{"stock":"AM25243","year":2024,"make":"MITSUBISHI","model":"RVR","mileage":74354,"price":26980,"condition":"Average","carfax":0,"type":"AWC"},
{"stock":"AM25244A","year":2019,"make":"JEEP","model":"COMPASS","mileage":111000,"price":24980,"condition":"Average","carfax":0,"type":"4x4"},
{"stock":"AM25246","year":2017,"make":"JEEP","model":"RENEGADE","mileage":98170,"price":19980,"condition":"Average","carfax":0,"type":"4WD 4dr"},
{"stock":"AM25248","year":2024,"make":"FORD","model":"BRONCO SPORT","mileage":70475,"price":32980,"condition":"Average","carfax":0,"type":"4x4"},
{"stock":"AM25249","year":2024,"make":"FORD","model":"BRONCO SPORT","mileage":59686,"price":33980,"condition":"Average","carfax":0,"type":"4x4"},
{"stock":"AM25250","year":2023,"make":"HYUNDAI","model":"ELANTRA","mileage":77449,"price":23980,"condition":"Average","carfax":0,"type":"IVT"},
{"stock":"AM25251","year":2023,"make":"KIA","model":"RIO 5-DOOR","mileage":75909,"price":21980,"condition":"Average","carfax":0,"type":"IVT"},
{"stock":"AM25252","year":2023,"make":"KIA","model":"RIO 5-DOOR","mileage":76393,"price":21980,"condition":"Average","carfax":0,"type":"IVT"},
{"stock":"AM25254","year":2023,"make":"NISSAN","model":"QASHQAI","mileage":70752,"price":27980,"condition":"Average","carfax":0,"type":"AWD CVT"},
{"stock":"AM25256","year":2023,"make":"RAM","model":"3500","mileage":74158,"price":59980,"condition":"Average","carfax":0,"type":"4x4 Crew Cab"},
{"stock":"AM25259","year":2023,"make":"BUICK","model":"ENVISION","mileage":66112,"price":31980,"condition":"Average","carfax":0,"type":"AWD 4dr"},
{"stock":"AM25261","year":2023,"make":"KIA","model":"FORTE","mileage":69995,"price":22980,"condition":"Average","carfax":0,"type":"IVT"},
{"stock":"AM25262","year":2022,"make":"RAM","model":"1500 CLASSIC","mileage":88000,"price":36980,"condition":"Average","carfax":0,"type":"4x4 Crew Cab"},
{"stock":"AM25267","year":2025,"make":"BUICK","model":"ENCORE GX","mileage":40675,"price":29980,"condition":"Clean","carfax":0,"type":"AWD 4dr"},
{"stock":"AM25270","year":2025,"make":"BUICK","model":"ENVISTA","mileage":47929,"price":28980,"condition":"Clean","carfax":0,"type":"FWD 4dr"},
{"stock":"AM25271","year":2024,"make":"JEEP","model":"COMPASS","mileage":67966,"price":32980,"condition":"Average","carfax":0,"type":"4x4"},
{"stock":"AM25274","year":2022,"make":"FORD","model":"F-150","mileage":81198,"price":40980,"condition":"Average","carfax":0,"type":"4WD SuperCrew"},
{"stock":"AM25278","year":2024,"make":"RAM","model":"3500","mileage":60533,"price":66980,"condition":"Average","carfax":0,"type":"4x4 Crew Cab"},
{"stock":"AM25280","year":2024,"make":"TOYOTA","model":"RAV4","mileage":65327,"price":38980,"condition":"Average","carfax":0,"type":"AWD"},
{"stock":"AM25281","year":2024,"make":"TOYOTA","model":"RAV4","mileage":67334,"price":38980,"condition":"Average","carfax":0,"type":"AWD"},
{"stock":"AM25282","year":2024,"make":"FORD","model":"BRONCO SPORT","mileage":59211,"price":32980,"condition":"Average","carfax":0,"type":"4x4"}
];

async function seed() {
  const client = await pool.connect();
  try {
    // Check if already seeded
    const existing = await client.query('SELECT COUNT(*) as c FROM desk_inventory');
    if (parseInt(existing.rows[0].c) > 0) {
      console.log(`ℹ️  desk_inventory already has ${existing.rows[0].c} vehicles. Skipping seed.`);
      console.log('   To re-seed: DELETE FROM desk_inventory; then run again.');
      return;
    }

    console.log(`🚗 Seeding ${inventory.length} vehicles into desk_inventory...`);

    for (const v of inventory) {
      await client.query(
        `INSERT INTO desk_inventory (stock, year, make, model, mileage, price, condition, carfax, type)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (stock) DO NOTHING`,
        [v.stock, v.year, v.make, v.model, v.mileage, v.price, v.condition, v.carfax, v.type]
      );
    }

    console.log(`✅ Seeded ${inventory.length} vehicles!`);
  } catch (e) {
    console.error('❌ Seed error:', e);
  } finally {
    client.release();
    await pool.end();
  }
}

seed();
