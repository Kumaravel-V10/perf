import http from "k6/http";
import { check, group } from "k6";
import { Trend, Rate, Counter } from "k6/metrics";
import { config } from './lib/config.js';
import { safeJsonParse } from './lib/helpers.js'

/*
  Multi-Scenario Booking Test
  Supports One-Way (OW), Round-Trip (RT), and Multi-City (MC) itineraries
  with dynamic passenger types, seats, and services.

  Passenger type codes:
    ADT = Adult
    CHD = Child
    YTH = Youth
    INF = Infant without seat
    INS = Infant with seat

  Scenario rotation:
    Each VU iteration picks TEST_SCENARIOS[__ITER % total] so all 8 scenarios
    are exercised evenly across the load profile.

  Flow:
    01_JWT_Token             POST /token
    02_Shop_Offer            POST /shop/flights        (getOffers)
    03_Create_Cart           POST /create-cart         (createCart)
    03b_Retrieve_Cart        POST /cart/retrieve       (retrieveCart)
    04_Checkout_Passengers   POST /checkout/passengers (updatePassengerInformation)
    05_Services_Catalogue    POST /services            (getServicesCatalogue)
    06_SeatMap               POST /seatmap             (getSeatMap)
    07_Add_Services          POST /seat/services       (addService)
    08_Add_Seats             POST /seat/services       (addSeat)
    09_Checkout_Confirm      POST /checkoutConfirm     (ConfirmCheckout)
    10_Retrieve_Order        POST /orders/retrieve     (retrieveOrder)
*/

// ======================================================================
// ENVIRONMENT
// ======================================================================
const BASE_URL = (__ENV.APIM_URL && String(__ENV.APIM_URL).trim())
  ? String(__ENV.APIM_URL).trim()
  : "https://apim-aai-perf-neu-02.azure-api.net"; // perf environment
 
  // : "https://apim-test-ay-fra-sc.azure-api.net"; // test environment
  // : "https://nevioservicecenterapim.azure-api.net"; // dev environment

const FLOW_NAME = __ENV.FLOW_NAME || "Prime_Booking";
const VERBOSE_LOGS = String(__ENV.VERBOSE_LOGS || "").toLowerCase() === "true";
const HTTP_TIMEOUT = __ENV.HTTP_TIMEOUT || "120s";  // override k6 default 60s; set to '0s' for no timeout

function dbg(msg) {
  if (VERBOSE_LOGS) console.log(msg);
}

// ======================================================================
// K6 OPTIONS  (load profile — unchanged from original)
// ======================================================================
export const options = {
 

   stages: [
    { duration: "5m",target: 50 },//start
    { duration: "5m",target: 100 }, // Add User
    { duration: "5m",target: 100 }, // Add User
    { duration: "50m",target: 250 }, // ramp down
    { duration: "5m",target: 0 }
 ], 

  //      scenarios: {
  //   one_round: {
  //     executor: 'per-vu-iterations',
  //     vus: 1,
  //     iterations: 6,

  //   },
  // },  
  thresholds: {
    http_req_duration: ["p(95)<90000"],
  },
  tags: { test_type: "multi_scenario" },
};

// ======================================================================
// TEST SCENARIOS
// ======================================================================
// Each object defines one booking scenario.
// Passenger fields:
//   passengerTypeCode  {string}   "ADT" | "CHD" | "YTH" | "INF" | "INS"
//   age                {number?}  Numeric age — drives DOB generation
//   seat               {string?}  Preferred seat (falls back to first available)
//   services           {string[]?} Service names looked up in the catalogue SKUs
//
// Trip fields:
//   OW / RT  →  origin, destination, departureDate (+ returnDate for RT)
//   MC       →  segments[{origin, destination, departureDate}]

// ── Scenario passenger fields ──────────────────────────────────────────
//   passengerTypeCode  {string}  ADT | CHD | INF | INS
//   age                {number}  Used to derive date of birth
//   requestSeat        {boolean} true = script picks a seat from available pool
//                                INF is always skipped regardless of this flag
//   serviceCategories  {string[]} Categories to pick from the services catalogue.
//                                Script selects the first available SKU per
//                                category using SKU.serviceCategory + keyword
//                                fallback. Supported values:
//                                  "baggage"  – prepaid bags / luggage
//                                  "wifi"     – streaming / internet
//                                  "meals"    – meal / food / beverage
//                                  "lounge"   – airport lounge access
//                                  "priority" – priority boarding / fast-track
//                                  "sports"   – sports equipment
//                                  "other"    – any SKU not in above categories
//   associatedAdultIndex {number} INF/INS only — 0-based index of the adult
//                                passenger in this scenario's passengers[] array
//                                that this infant travels with. Maps to
//                                PassengerInput.associatedPassengerId.
//
// ── fareType values ────────────────────────────────────────────────────
//   Only "Economy" or "Business" — sent as fareTypes:["Economy"|"Business"]
//   in the getOffers query (schema: fareTypes: [String!]!)

// Scenarios are loaded from scenarios.json at init time.
// To add, remove or change scenarios edit scenarios.json only — no JS changes needed.
const TEST_SCENARIOS = JSON.parse(open("./scenarios.json"));

// ======================================================================
// SCENARIO ROTATION
// ======================================================================
// Returns the scenario for the current VU iteration.
// __ITER is a per-VU counter (0-based); modulo distributes evenly.
function getScenario(iter) {
  return TEST_SCENARIOS[iter % TEST_SCENARIOS.length];
}

// ======================================================================
// DATE-OF-BIRTH HELPER
// ======================================================================
// Generates a yyyy-mm-dd date of birth for a passenger of the given age.
function getDOB(age) {
  const now   = new Date();
  const year  = now.getFullYear() - Number(age);
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day   = String(now.getDate()).padStart(2, "0");
  return year + "-" + month + "-" + day;
}

// Acquire JWT auth token from APIM
export function getAuthToken() {
  try {
    // Step 1: Fetch a fresh CSRF token and its cookie
    const csrfRes = http.get(config.CSRF_URL, {
      tags: { name: 'get_csrf' },
      timeout: '30s',
    });

    const csrfData = safeJsonParse(csrfRes.body);
    if (!csrfData || !csrfData.csrfToken) {
      console.log(`CSRF fetch failed | status=${csrfRes.status} | body=${String(csrfRes.body || '').substring(0, 200)}`);
      return null;
    }
    const freshCsrfToken = csrfData.csrfToken;

    // Build Cookie header from the CSRF response cookies
    let cookieParts = [];
    const csrfCookies = csrfRes.cookies['__Host-next-auth.csrf-token'];
    if (csrfCookies && csrfCookies.length > 0) {
      cookieParts.push(`__Host-next-auth.csrf-token=${csrfCookies[0].value}`);
    }
    cookieParts.push(`__Secure-next-auth.callback-url=${encodeURIComponent(config.BASE_URL)}`);
    const cookieHeader = cookieParts.join('; ');

    // Step 2: Sign in with the fresh CSRF token; disable redirects to capture the session cookie
    const tokenBody = JSON.stringify({
      json: true,
      csrfToken: freshCsrfToken,
      role: 'Admin',
      office: '12345678',
      email: 'hari.m@tcs.com',
      name: 'Hari',
    });

    const res = http.post(config.TOKEN_URL, tokenBody, {
      headers: {
        'Content-Type': 'application/json',
        'Cookie': cookieHeader,
      },
      redirects: 0,
      tags: { name: 'get_token' },
      timeout: '30s',
    });

    check(res, {
      'token response received': (r) => r.status === 200 || r.status === 302,
    });
    logStep("01_JWT_Token", res, config.TOKEN_URL);

    // Try JSON body first
    const parsed = safeJsonParse(res.body);
    if (parsed && parsed.authToken) {
      return parsed.authToken;
    }

    // Try NextAuth chunked session cookies (.0 / .1)
    const chunk0 = res.cookies['__Secure-next-auth.session-token.0'];
    const chunk1 = res.cookies['__Secure-next-auth.session-token.1'];
    if (chunk0 && chunk0.length > 0) {
      let cookieStr = `__Secure-next-auth.session-token.0=${chunk0[0].value}`;
      if (chunk1 && chunk1.length > 0) {
        cookieStr += `; __Secure-next-auth.session-token.1=${chunk1[0].value}`;
      }
      return cookieStr;
    }

    

    // Try non-chunked NextAuth session cookie
    const sessionCookies = res.cookies['__Secure-next-auth.session-token'];
    if (sessionCookies && sessionCookies.length > 0) {
      return `__Secure-next-auth.session-token=${sessionCookies[0].value}`;
    }

    // Fallback: scan Set-Cookie header for AuthToken or session-token
    const sc = res.headers['Set-Cookie'] || res.headers['set-cookie'];
    if (sc) {
      const authMatch = /AuthToken=([^;]+)/.exec(sc);
      if (authMatch) return authMatch[1];
      const sessionMatch = /__Secure-next-auth\.session-token=([^;]+)/.exec(sc);
      if (sessionMatch) return sessionMatch[1];
    }

    console.log(`Token not found | status=${res.status} | cookies=${JSON.stringify(res.cookies)}`);
    return sessionCookies | sc;
  } catch (e) {
    console.log(`Token request error: ${e.message || e}`);
    return null;
  }
}

// Fallback age (years) per passenger type when no age is specified in scenario
const DEFAULT_AGE_BY_PTC = { ADT: 30, CHD: 8, YTH: 16, INF: 1, INS: 1 };

// ── Passenger name tables ───────────────────────────────────────────────
// Root-cause: the passenger validation pattern rejects any name that contains
// digits or non-alphabetic characters.  "Test1" / "User1" both fail because
// they end with the digit "1".  All names here are strictly [A-Za-z] only.
const PAX_FIRST_NAMES = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Hotel"];
const PAX_LAST_NAMES  = ["Smith", "Jones", "Brown", "Taylor", "Wilson", "Evans", "Thomas", "Roberts"];

// ======================================================================
// STEP METRICS  (unchanged from original)
// ======================================================================
const STEPS = [
  "01_JWT_Token",
  "02_Shop_Offer",
  "03_Create_Cart",
  "03b_Retrieve_Cart",
  "04_Checkout_Passengers",
  "05_Services_Catalogue",
  "06_SeatMap",
  "07_Add_Services",
  "08_Add_Seats",
  "09_Checkout_Confirm",
  "10_Retrieve_Order",
];

const stepTrends = {};
const stepFails  = {};
const stepCounts = {};
for (let i = 0; i < STEPS.length; i++) {
  const s = STEPS[i];
  stepTrends[s] = new Trend(`step_${s}`, true);
  stepFails[s]  = new Rate(`fail_${s}`);
  stepCounts[s] = new Counter(`count_${s}`);
}
const successCount     = new Counter("successful_iterations");
const failedCount      = new Counter("failed_iterations");
const seatAddFailCount = new Counter("seat_add_failures");  // explicit seat failure counter

// ======================================================================
// ERROR COLLECTION  (unchanged from original)
// ======================================================================
const ERROR_LOG = [];

// ======================================================================
// RUN LOG  — one entry per VU iteration, written to a .txt file via handleSummary
// ======================================================================
// Captures SKU, checkoutId, flightIds, orderId, seats/services added, and
// which step caused a failure.  All detailed HTTP req/res logs go to stdout
// via console.log; redirect to a file with:
//   k6 run script.js 2>&1 | tee run-console.log
const RUN_LOG = [];
const MAX_RUN_LOG_ENTRIES = 500;

function logRun(entry) {
  if (RUN_LOG.length < MAX_RUN_LOG_ENTRIES) RUN_LOG.push(entry);
}

function recordFailure(step, res) {
  if (!res || res.status === 200) return;
  if (ERROR_LOG.length >= 20) return;
  let code = "", msg = "";
  try {
    const j  = res.json();
    const e0 = j && j.errors && j.errors[0];
    code = e0 && e0.code    ? String(e0.code)    : "";
    msg  = e0 && e0.message ? String(e0.message) : "";
  } catch (e) {}
  ERROR_LOG.push({ step, status: res.status, code, message: msg, body: snippet(res.body, 500) });
}

function recordStepMetrics(step, res) {
  if (!res) return;
  if (stepTrends[step] && res.timings && typeof res.timings.duration === "number")
    stepTrends[step].add(res.timings.duration);
  if (stepFails[step])  stepFails[step].add(!(res.status == 200 || res.status == 302));
  if (stepCounts[step]) stepCounts[step].add(1);
  recordFailure(step, res);
}

function dur(res) { return (!res || !res.timings) ? "NA" : String(Math.round(res.timings.duration)); }

function logStep(step, res, url) {
  console.log(`${step} | status=${res.status} | dur_ms=${dur(res)} | url=${url}`);
  recordStepMetrics(step, res);
}

function snippet(s, max) {
  s = (s === undefined || s === null) ? "" : String(s);
  return s.length <= max ? s : s.substring(0, max) + "...";
}

function safeJson(res) {
  try { return res.json(); } catch (e) { return null; }
}

// ======================================================================
// AUTH  (unchanged from original)
// ======================================================================
function extractAuthToken(res) {
  const sc = res.headers["Set-Cookie"] || res.headers["set-cookie"];
  if (!sc) return "";
  const m = /AuthToken=([^;]+)/.exec(sc);
  return m ? m[1] : "";
}

function headers(jwt) {
  return {
    "Content-Type":  "application/json",
    "Accept":        "application/json",
    "Cache-Control": "no-cache",
    "Authorization": jwt,
    "Cookie":        "AuthToken=" + jwt,
  };
}

// ======================================================================
// STEP 01: JWT Token  (unchanged from original)
// ======================================================================
function postToken(flowName) {
  const url = BASE_URL + "/token";
  const res = http.post(url, "{}", {
    headers: { "Content-Type": "application/json" },
    timeout: HTTP_TIMEOUT,
    tags: { name: "01_JWT_Token", flow: flowName },
  });
  logStep("01_JWT_Token", res, url);
  const jwt = extractAuthToken(res);
  check(res, {
    "token status 200":            r => r.status === 200,
    "AuthToken cookie extracted":  () => jwt && jwt.length > 20,
  });
  if (!jwt) console.log("01_JWT_Token failed body=" + snippet(res.body, 800));
  return jwt;
}

// ======================================================================
// GRAPHQL HELPER  (unchanged from original)
// ======================================================================
function postGql(step, path, query, variables, flow) {
  const url     = path;
  // Extract operationName from the query/mutation document (e.g. "mutation AddService(...)" → "AddService")
  const opMatch       = query.match(/(?:query|mutation|subscription)\s+(\w+)/);
  const operationName = opMatch ? opMatch[1] : undefined;
  const payload = JSON.stringify({ operationName, query, variables: variables || {} });
  const res = http.post(url, payload, { timeout: HTTP_TIMEOUT, tags: { name: step, flow } });
  logStep(step, res, url);
  if (res.status !== 200) console.log(step + " failed body=" + snippet(res.body, 2500));
  return res;
}

function normalizePtcString(v, fallback) {
  if (v === undefined || v === null) return fallback;
  let s = String(v).replace(/\"/g, "").trim().replace(/[^A-Za-z]/g, "");
  return s || fallback;
}

// ======================================================================
// TRIP SEGMENT BUILDER
// ======================================================================
// Returns an array of trip objects for the OfferRequest variables.
// API supports OW and RT only — no MC tripType.
//   OW → 1 outbound trip object
//   RT → outbound + inbound (origin/destination swapped, returnDate for inbound)
function buildTripBlocks(d) {
  if (d.tripType === "RT") {
    const ret = d.returnDate || d.departureDate;
    return [
      { departureLocationCode: d.origin, arrivalLocationCode: d.destination, departureDateTime: d.departureDate, isRequestedBound: true },
      { departureLocationCode: d.destination, arrivalLocationCode: d.origin, departureDateTime: ret, isRequestedBound: false }
    ];
  }
  // OW (and any unrecognised tripType — treated as OW)
  return [
    { departureLocationCode: d.origin, arrivalLocationCode: d.destination, departureDateTime: d.departureDate, isRequestedBound: true }
  ];
}

// ======================================================================
// PASSENGER BLOCK BUILDER  (for getOffers variables)
// ======================================================================
// Returns an array of passenger objects matching the OfferRequest schema.
// INS (infant with seat) is submitted as INF — the API resolves the seat type internally.
function buildPassengerBlocks(passengers) {
  // INS (infant with seat) is sent as-is to shopOffer — confirmed from real API payload.
  // The API accepts both INS and INF natively; do NOT convert here.
  return passengers.map(function(p) {
    return {
      passengerTypeCode: p.passengerTypeCode,
      frequentFlyer: null,
      discountCode: null
    };
  });
}

// ======================================================================
// STEP 02: Shop Offer
// ======================================================================
// Uses variables format matching the confirmed actual API request:
//   operationName: "Offer"
//   variable:      $offerRequest: OfferRequest!
//   field arg:     getOffers(OfferRequest: $offerRequest)
// No selectedFlightProductId (not in real request).
// Passenger objects include frequentFlyer/discountCode as null.
function shopOffer(d) {
  const query = `query Offer($offerRequest: OfferRequest!) {
    getOffers(OfferRequest: $offerRequest) {
      response {
        connections {
          flightProducts {
            flightSKUs { SKUId seatsLeft }
          }
        }
      }
    }
  }`;

  const variables = {
    offerRequest: {
      tripType:   d.tripType,
      passengers: buildPassengerBlocks(d.passengers),
      fareTypes:  [d.fareType],
      trips:      buildTripBlocks(d)
    }
  };

  const res = postGql("02_Shop_Offer", config.FLIGHT_URL, query, variables, d.name);
  if (res.status !== 200) return [];
  const body = safeJson(res);

  // For RT the API returns two connections (one per bound).
  // For OW it returns one.  We pick the best SKU from EACH connection
  // independently and return them as an array — createCart sends all of
  // them as skuIds[] so the cart covers every bound.
  //
  // Per-connection strategy:
  //   Pass 1 — first SKU with seatsLeft > 0  (prefer available inventory)
  //   Pass 2 — first SKU regardless of seatsLeft (sold-out / null fallback)
  try {
    const connections = body.data.getOffers.response.connections || [];
    if (!connections.length) {
      console.log("[02_Shop_Offer] No connections in response");
      return [];
    }

    var selectedSkus = [];

    for (var c = 0; c < connections.length; c++) {
      var products = (connections[c] && connections[c].flightProducts) ? connections[c].flightProducts : [];
      var pickedId = "";
      var firstAny = "";

      for (var p = 0; p < products.length; p++) {
        var skus = (products[p] && products[p].flightSKUs) ? products[p].flightSKUs : [];
        for (var s = 0; s < skus.length; s++) {
          var sku = skus[s];
          var id  = sku && sku.SKUId ? String(sku.SKUId) : "";
          if (!id) continue;
          if (!firstAny) firstAny = id;
          if (sku.seatsLeft > 0) { pickedId = id; break; }
        }
        if (pickedId) break;
      }

      var finalId = pickedId || firstAny;
      if (finalId) {
        selectedSkus.push(finalId);
        console.log("[02_Shop_Offer] conn[" + c + "] SKU=" + finalId +
          (pickedId ? " (seatsLeft>0)" : " (fallback, seatsLeft=0 or null)"));
      } else {
        console.log("[02_Shop_Offer] WARN - conn[" + c + "] no SKU found");
      }
    }

    if (!selectedSkus.length) {
      console.log("[02_Shop_Offer] No SKUs selected - body=" + snippet(res.body, 1000));
    }
    return selectedSkus;
  } catch (e) {
    console.log("[02_Shop_Offer] SKU extraction error: " + String(e));
  }

  return [];
}

// ======================================================================
// STEP 03: Create Cart
// ======================================================================
// ── Root-cause analysis (SCCM0020 fix history) ───────────────────────
//
//   CAUSE 1 — CONFIRMED FIX: GraphQL variable name mismatch
//     BROKEN:  mutation CreateCart($requestBody: CreateCart!) {
//                createCart(requestBody: $requestBody) { ... }
//              }
//              JSON variables: { "requestBody": { skuIds:[...] } }
//
//     FIXED:   mutation CreateCart($input: CreateCart!) {
//                createCart(requestBody: $input) { ... }
//              }
//              JSON variables: { "input": { skuIds:[...] } }
//
//     Explanation:
//       The GraphQL VARIABLE is named "$input" → JSON key must be "input".
//       The field ARGUMENT is named "requestBody" → the schema expects
//       createCart(requestBody: ...) not createCart(input: ...).
//       These are two independent names: variable declaration ($input)
//       and how that variable is passed to the field (requestBody: $input).
//       Both match the confirmed working Postman request exactly.
//
//   CAUSE 2 — PREVIOUSLY INCORRECT ASSUMPTION (now reverted):
//     A prior patch incorrectly changed:
//       - Type from CreateCart! → CreateCartInput!   (WRONG)
//       - Field arg from requestBody: → input:        (WRONG)
//       - Selection set to id/creationPointOfSale/airOffers (WRONG)
//     All three have been reverted to match the confirmed Postman schema.
//
//   CONFIRMED SCHEMA (from working Postman request):
//     Type:          CreateCart!                      ✅
//     Field arg:     requestBody: $input              ✅
//     Selection:     travelers / dataList / response / warnings   ✅
//     flightId src:  response.air.connections[0].flights[0].id   ✅
//     checkoutId src: response.checkoutId                        ✅
// ─────────────────────────────────────────────────────────────────────
function createCart(d, skuIds) {

  const query = `mutation CreateCart($input: CreateCart!) {
    createCart(requestBody: $input) {
      dataList {
        aircraft
        airline
        bookingStatus
        country
        currency
        flights
        location
        meal
        tax
      }
      response {
        cartId
        checkoutId
        airofferid
        airlinecode
        passengers {
          passengerTypeCode
          passengerId
          oldPassengerId
        }
        air {
          price {
            unitPrices {
              travelerIds
              prices {
                base
                total
              }
            }
          }
          connections {
            flights {
              id
            }
          }
        }
      }
      warnings {
        severity
        message
        code
      }
    }
  }`;

  const variables = {
    input: {
      skuIds: skuIds.map(function(id) { return String(id); }),
      airlineId: String(d.airlineId),
      agentId: String(d.agentId),
      passengers: [],
      flightSKU: null,
      outBoundDateTime: String(d.departureDate) + "T00:00:00.000Z",
      inBoundDateTime: d.tripType === "RT" ? (String(d.returnDate) + "T00:00:00.000Z") : null,
    },
  };

  const payload = JSON.stringify({ query, variables });

  dbg("[03_Create_Cart] SKU IDs = [" + skuIds.join(",") + "]");
  dbg("[03_Create_Cart] Variables = " + JSON.stringify(variables, null, 2));
  dbg("[03_Create_Cart] Payload = " + snippet(payload, 4000));

  const res = postGql(
    "03_Create_Cart",
    config.ONE_SHOT_CART_URL,
    query,
    variables,
    d.name
  );

  dbg("[03_Create_Cart] HTTP Status = " + res.status);
  dbg("[03_Create_Cart] Response Body = " + snippet(res.body, 4000));

  if (res.status !== 200) {
    console.log("[03_Create_Cart] FAILED — status=" + res.status);
    return {
      checkoutId: "",
      cartId: "",
      passengers: [],
      flightIds: []
    };
  }

  const body = safeJson(res);

  const out = {
    checkoutId: "",
    cartId: "",
    passengers: [],
    flightIds: []
  };

  try {

    const cart = body.data.createCart;
    const resp = cart.response;

    out.cartId = String(resp.cartId || "");
    out.checkoutId = String(resp.checkoutId || "");

    // Passenger mapping
    const respPax = resp.passengers || [];

    out.passengers = respPax.map(function(p) {
      return {
        id: String(p.passengerId || ""),
        passengerId: String(p.passengerId || ""),
        oldPassengerId: String(p.oldPassengerId || ""),
        passengerTypeCode: String(p.passengerTypeCode || ""),
        travelerId: String(p.passengerId || "")
      };
    });

    // Collect ALL flight IDs across all connections and all legs.
    // A connecting itinerary (e.g. HEL→AMS→LHR) returns multiple flights[].id
    // per connection. Each id needs its own seatMap call and a seat entry
    // per passenger in the addSeat request.
    try {
      const conn = resp.air.connections || [];
      for (let c = 0; c < conn.length; c++) {
        const flights = (conn[c] && conn[c].flights) ? conn[c].flights : [];
        for (let f = 0; f < flights.length; f++) {
          const fid = String(flights[f].id || "");
          if (fid) out.flightIds.push(fid);
        }
      }
    } catch (e) {}

    // Fallback: extract from dataList.flights object keys
    if (!out.flightIds.length) {
      try {
        const flightsObj = cart.dataList && cart.dataList.flights;
        if (flightsObj && typeof flightsObj === "object") {
          const keys = Object.keys(flightsObj);
          for (let k = 0; k < keys.length; k++) {
            if (keys[k]) out.flightIds.push(String(keys[k]));
          }
        }
      } catch (e) {}
    }

    const warnings = cart.warnings || [];

    for (let w = 0; w < warnings.length; w++) {
      console.log(
        "[03_Create_Cart] WARNING code=" +
        String(warnings[w].code || "") +
        " sev=" +
        String(warnings[w].severity || "") +
        " msg=" +
        String(warnings[w].message || "")
      );
    }

    console.log(
      "[03_Create_Cart] cartId=" + out.cartId +
      " | checkoutId=" + out.checkoutId +
      " | passengers=" + out.passengers.length +
      " | flightIds=[" + out.flightIds.join(",") + "]"
    );

  } catch (e) {

    console.log(
      "[03_Create_Cart] Parse error: " +
      String(e) +
      " | raw body=" +
      snippet(res.body, 2000)
    );
  }

  return out;
}
// ======================================================================
// STEP 03b: Retrieve Cart
// ======================================================================
// Root-cause notes (SCCM0020 fix):
//   The API schema for retrieveCart only exposes { checkoutID } in the
//   response type.  Requesting extra fields (airofferid, airlinecode,
//   passengers, air{...}) causes the BFF to return SCCM0020 "Invalid
//   request" instead of a standard GraphQL schema error.
//   Response selection is kept minimal to match the verified schema.
//
//   Input  : checkoutId from createCart (passed as GraphQL arg checkoutID)
//   Returns: parsed response object on success, null on any failure.
//   Non-blocking: the main flow continues even if this step fails.
function retrieveCart(d, checkoutId) {
  // ── Pre-flight null / empty guards ────────────────────────────────
  if (!checkoutId || String(checkoutId).trim() === "") {
    console.log("[03b_Retrieve_Cart] SKIPPED - checkoutId is null/empty");
    return null;
  }

  // ── Minimal response selection — matches confirmed API schema ─────
  // Only { checkoutID } is a valid field on RetrieveCartResponse.
  // Requesting any other field triggers SCCM0020 from the BFF.
  const q = `query RetrieveCart {
    retrieveCart(checkoutID: "${checkoutId}") {
      response { checkoutID }
      warnings  { code message severity }
    }
  }`;

  const url     = config.CART_RETRIEVE_URL;
  const payload = JSON.stringify({ query: q, variables: {} });
  // const hdrs    = headers(jwt);

  // ── Debug: log request details before sending ─────────────────────
  dbg("[03b_Retrieve_Cart] REQUEST url=" + url);
  dbg("[03b_Retrieve_Cart] REQUEST checkoutId=" + checkoutId);
  dbg("[03b_Retrieve_Cart] REQUEST payload=" + snippet(payload, 800));
  
  const res = http.post(url, payload, {
    timeout: HTTP_TIMEOUT,
    tags: { name: "03b_Retrieve_Cart", flow: d.name },
  });
  logStep("03b_Retrieve_Cart", res, url);

  // ── Debug: log full response on any non-200 ───────────────────────
  if (res.status !== 200) {
    console.log("[03b_Retrieve_Cart] FAILED status=" + res.status +
      " body=" + snippet(res.body, 2500));
    return null;
  }

  dbg("[03b_Retrieve_Cart] RESPONSE body=" + snippet(res.body, 2500));

  const body = safeJson(res);
  let cartData = null;
  try {
    cartData = body.data.retrieveCart.response;
    dbg("[CART_RETRIEVE] checkoutID=" + String((cartData && cartData.checkoutID) || ""));

    const warnings = (body.data.retrieveCart.warnings || []);
    for (let w = 0; w < warnings.length; w++) {
      dbg("[03b_Retrieve_Cart] WARNING code=" + String(warnings[w].code || "") +
        " | msg=" + String(warnings[w].message || ""));
    }
  } catch (e) {
    console.log("[03b_Retrieve_Cart] Parse error: " + String(e));
  }

  check(res, {
    "retrieveCart status 200":       r => r.status === 200,
    "retrieveCart has checkoutID":   () => !!(cartData && cartData.checkoutID),
  });

  return cartData;
}

// ======================================================================
// STEP 04: Checkout Passengers
// ======================================================================
// Enhanced:
//   - DOB derived from scenario passenger age (falls back to type default)
//   - Unique firstName / lastName per passenger index
//   - Unique email per passenger index
//   - title / gender set by passenger type (minor vs adult)
function checkoutPassengers(d, checkoutId, cartPassengers) {
  const passengersArr = [];

  // Build per-PTC queues from scenario passengers so cart passengers are matched
  // by TYPE not by array position. Cart may return [ADT,CHD,INS] while scenario
  // defines [ADT,INS,CHD] — positional matching assigns wrong age to each slot.
  var scenQueues = {};
  for (var qi = 0; qi < d.passengers.length; qi++) {
    var qptc = String(d.passengers[qi].passengerTypeCode || "ADT");
    if (!scenQueues[qptc]) scenQueues[qptc] = [];
    scenQueues[qptc].push(d.passengers[qi]);
  }
  var scenQueueIdx = {};  // next-to-dequeue index per PTC

  // Build adult→infant mapping using PTC-matched pairing so INF/INS associatedAdultIndex
  // resolves to the correct cart passengerId even when cart order differs from scenario order.
  // Strategy: first pass — match each cart passenger to its scenario counterpart by PTC,
  // collect (scenarioIndex → cartPassengerId) for INF/INS, then resolve adultToInfantId.
  var scenIndexToCartId = {};
  var tempQueueIdx = {};
  for (var pi = 0; pi < cartPassengers.length; pi++) {
    var tptc = normalizePtcString(cartPassengers[pi].passengerTypeCode, "ADT");
    if (tempQueueIdx[tptc] === undefined) tempQueueIdx[tptc] = 0;
    var tQueue = scenQueues[tptc] || [];
    // find the scenario-level index for this cart passenger
    var tScenPax = tQueue[tempQueueIdx[tptc]];
    if (tScenPax) {
      var globalIdx = d.passengers.indexOf(tScenPax);
      scenIndexToCartId[globalIdx] = String(cartPassengers[pi].passengerId);
    }
    tempQueueIdx[tptc]++;
  }

  const adultToInfantId = {};
  for (var ai = 0; ai < d.passengers.length; ai++) {
    var ap = d.passengers[ai];
    var aptc = String(ap.passengerTypeCode || "");
    // Only INF needs ADT.associatedPassengerId — confirmed from real API payload.
    // INS is sent as-is and requires NO association on the adult.
    if (aptc === "INF" && ap.associatedAdultIndex !== undefined && ap.associatedAdultIndex !== null) {
      var infantCartId = scenIndexToCartId[ai];
      if (infantCartId) adultToInfantId[ap.associatedAdultIndex] = infantCartId;
    }
  }

  // ── Determine which ADT gets contactDetails ───────────────────────
  // Per real API: only the first ADT carries contact details.
  let firstAdtDone = false;

  for (let i = 0; i < cartPassengers.length; i++) {
    const cartPax = cartPassengers[i];
    const ptc     = normalizePtcString(cartPax.passengerTypeCode, "ADT");

    // Dequeue the first unmatched scenario passenger of the same PTC
    if (scenQueueIdx[ptc] === undefined) scenQueueIdx[ptc] = 0;
    var queue   = scenQueues[ptc] || [];
    var scenPax = queue[scenQueueIdx[ptc]] || {};
    var scenPaxGlobalIdx = d.passengers.indexOf(scenPax);
    scenQueueIdx[ptc]++;


    // ── Date of birth ─────────────────────────────────────────────────
    // Prefer scenario.dateOfBirth (static, matches WireMock expectations);
    // fallback to calculating from age.
    const dob = (scenPax.dateOfBirth !== undefined && scenPax.dateOfBirth !== null)
      ? String(scenPax.dateOfBirth)
      : getDOB(
          (scenPax.age !== undefined && scenPax.age !== null)
            ? scenPax.age
            : (DEFAULT_AGE_BY_PTC[ptc] || 30)
        );

    // ── Alphabetic-only names (unique per passenger slot) ───────────────
    // Root-cause fix: passenger API rejects names containing digits.
    // Index wraps via modulo so more than 8 passengers still get valid names.
    const nameIdx   = i % PAX_FIRST_NAMES.length;
    const firstName = PAX_FIRST_NAMES[nameIdx];
    const lastName  = PAX_LAST_NAMES[nameIdx];

    // ── Title and gender by passenger type ────────────────────────────
    const isMinor = (ptc === "CHD" || ptc === "INF" || ptc === "INS");
    const title   = isMinor ? "master" : "mr";
    const gender  = "male";

    // ── Email — alphabetic local-part, no digits ──────────────────────
    const email = firstName.toLowerCase() + "." + lastName.toLowerCase() + "@example.com";

    // ── Build passenger object ────────────────────────────────────────
    // id must equal response.passengers[].passengerId — confirmed by schema.
    // INS is sent as-is (confirmed from real API payload — INS stays INS).
    // Only INF gets ADT.associatedPassengerId; INS stands alone with no association.
    const paxObj = {
      id: String(cartPax.passengerId),
      passengerTypeCode: ptc,
      identityDetails: {
        firstName, lastName, gender,
        nameType: "universal",
        dateOfBirth: dob,
        title,
      },
    };

    // ── associatedPassengerId: on the ADT, pointing to INF/INS ───────
    // The ADULT carries associatedPassengerId (the infant's id), not the
    // other way around.  Confirmed from real API payload.
    if (ptc === "ADT" && adultToInfantId[scenPaxGlobalIdx] !== undefined) {
      paxObj.associatedPassengerId = adultToInfantId[scenPaxGlobalIdx];
    }

    // ── contactDetails: first ADT only ────────────────────────────────
    // Per real API: only the first ADT passenger gets contactDetails
    // (email + mobile).  Other ADTs, CHD, INF, INS, YTH get none.
    // tid format: {passengerId}_{m|e}_{index} — required by the API to
    // track new (unsaved) contact entries.
    if (ptc === "ADT" && !firstAdtDone) {
      firstAdtDone = true;
      const paxId = String(cartPax.passengerId);
      paxObj.contactDetails = {
        mobile: [
          { tid: paxId + "_m_0", isDefault: true, category: "personal", number: "9876543210", countryCode: "+91", purposes: ["standard"] },
        ],
        email: [
          { tid: paxId + "_e_0", isDefault: true, category: "personal", purposes: ["standard"], emailAddress: email },
        ],
      };
    }

    dbg("[04_Checkout_Passengers] PAX[" + i + "]" +
      " ptc=" + ptc +
      " id=" + String(cartPax.passengerId) +
      " associatedPassengerId=" + (paxObj.associatedPassengerId || "none") +
      " hasContactDetails=" + (!!paxObj.contactDetails));

    passengersArr.push(paxObj);
  }

  const query = `mutation Mutation($passengerInput: AddPassengerInput!) {
    updatePassengerInformation(passengerInput: $passengerInput) { checkoutId }
  }`;
  const variables = { passengerInput: { checkoutId, passengers: passengersArr } };

  // ── Pre-request debug logging ───────────────────────────────────────
  dbg("[04_Checkout_Passengers] checkoutId=" + checkoutId +
    " | passengerCount=" + passengersArr.length);
  dbg("[04_Checkout_Passengers] Variables=" + JSON.stringify(variables, null, 2));

  return postGql("04_Checkout_Passengers", config.PASSENGERS_URL, query, variables, d.name);
}

// ======================================================================
// STEP 05: Services Catalogue
// ======================================================================
// The API returns SKUs at two distinct levels:
//   Bound-level  → passenger.SKUs[]          (baggage, sports equipment)
//   Flight-level → passenger.segments[].SKUs[] (meals, wifi, other)
// Both levels are fetched and merged in addServices() so all categories work.
function servicesCatalogue(d, checkoutId) {
  const q = `query ServicesCatalogue {
    getServicesCatalogue(checkoutId:"${checkoutId}") {
      connections {
        passengers {
          id type
          SKUs { id name serviceCategory code oncePerPassengerPerFlight }
          segments {
            flightId
            SKUs { id name serviceCategory code oncePerPassengerPerFlight }
          }
        }
      }
    }
  }`;
  const res = postGql("05_Services_Catalogue", config.SERVICES_URL, q, {}, d.name);
  if (res.status !== 200) return [];
  const body = safeJson(res);
  try { return body.data.getServicesCatalogue.connections[0].passengers || []; } catch (e) { return []; }
}

// ======================================================================
// STEP 06: Seat Map  (unchanged from original)
// ======================================================================
function seatMap(d, checkoutId, flightId) {
  const q = `query SeatMap {
    getSeatMap(input:{ checkoutId:"${checkoutId}" flightId:"${flightId}" }) {
      data { seatmaps { decks { seats { seatNumber travelers { seatAvailabilityStatus } } } } }
    }
  }`;

  const url     = config.SEAT_MAP_URL;
  const payload = JSON.stringify({ operationName: "SeatMap", query: q, variables: {} });
  const res     = http.post(url, payload, { timeout: HTTP_TIMEOUT, tags: { name: "06_SeatMap", flow: d.name } });

  // SCSM0020 = "No SeatMap For these Flight" — expected for some legs (e.g. codeshare,
  // short-haul, open-jaw). Treat as a successful no-seat result, not a failure.
  if (res.status !== 200) {
    var errCode = "";
    try { errCode = res.json().errors[0].code; } catch (e) {}
    if (errCode === "SCSM0020") {
      dbg("[06_SeatMap] No seat map for flight=" + flightId + " (SCSM0020) — skipping seats for this leg");
      // Record timing but NOT as a failure
      if (stepTrends["06_SeatMap"] && res.timings) stepTrends["06_SeatMap"].add(res.timings.duration);
      if (stepCounts["06_SeatMap"]) stepCounts["06_SeatMap"].add(1);
      if (stepFails["06_SeatMap"])  stepFails["06_SeatMap"].add(0);   // not a failure
    } else {
      logStep("06_SeatMap", res, url);
    }
    return [];
  }

  logStep("06_SeatMap", res, url);
  const body = safeJson(res);
  const out  = [];
  try {
    const seatmaps = body.data.getSeatMap.data.seatmaps || [];
    for (let i = 0; i < seatmaps.length; i++) {
      const decks = seatmaps[i].decks || [];
      for (let d2 = 0; d2 < decks.length; d2++) {
        const seats = decks[d2].seats || [];
        for (let s = 0; s < seats.length; s++) {
          const t0 = (seats[s].travelers || [])[0];
          if (t0 && String(t0.seatAvailabilityStatus).toLowerCase() === "available") {
            out.push(String(seats[s].seatNumber));
          }
        }
      }
    }
  } catch (e) {}
  dbg("[SEAT_AVAILABLE] flight=" + flightId + " count=" + out.length + " sample=" + out.slice(0, 10).join(", "));
  return out;
}

// ======================================================================
// SERVICE CATEGORY MATCHING
// ======================================================================
// The services catalogue API returns SKU.serviceCategory on every SKU
// (e.g. "BAGGAGE", "WIFI", "MEALS").  Scenarios declare serviceCategories
// as lowercase human-readable strings.  Resolution order:
//
//   1. Direct check — requested category appears in (or equals) the API's
//      SKU.serviceCategory value (case-insensitive, substring both ways).
//   2. Keyword fallback on SKU.name — handles APIs where serviceCategory
//      is null/empty.
//   3. Special "other" category — matches any SKU not claimed by a known
//      keyword pattern, useful for exploratory or catch-all scenarios.
//
// Supported scenario category strings:
//   "baggage"  → prepaid bag / luggage
//   "wifi"     → streaming / internet / browsing
//   "meals"    → meal / food / snack / beverage / drink / dining
//   "lounge"   → lounge / vip
//   "priority" → priority boarding / fast-track
//   "sports"   → sports equipment / bicycle / ski / golf
//   "other"    → any SKU not matched by the patterns above

const CATEGORY_KEYWORD_MAP = {
  baggage:  /bag|baggage|luggage|prepaid/i,
  wifi:     /streaming|internet|wifi|wi-fi|browsing/i,
  meals:    /meal|food|snack|beverage|drink|dining/i,
  lounge:   /lounge|vip/i,
  priority: /priority|fast.?track/i,
  sports:   /sport|bicycle|ski|golf/i,
};

// Returns true if the given SKU satisfies the requested category.
function categoryMatchesSku(requestedCategory, sku) {
  const cat     = String(requestedCategory || "").toLowerCase().trim();
  const skuCat  = String(sku.serviceCategory || "").toLowerCase().trim();
  const skuName = String(sku.name || "").toLowerCase().trim();

  // 1. API serviceCategory field match (both-direction substring)
  if (skuCat && (skuCat === cat || skuCat.indexOf(cat) !== -1 || cat.indexOf(skuCat) !== -1)) {
    return true;
  }

  // 2. Keyword fallback on SKU name
  const rx = CATEGORY_KEYWORD_MAP[cat];
  if (rx && rx.test(skuName)) return true;

  // 3. "other" = any SKU not matched by any known keyword pattern
  if (cat === "other") {
    for (const key in CATEGORY_KEYWORD_MAP) {
      if (CATEGORY_KEYWORD_MAP[key].test(skuName)) return false;
    }
    return true;
  }

  return false;
}

// ======================================================================
// STEP 07: Add Services
// ======================================================================
// Category-driven service selection — no hardcoded service names.
// Each scenario passenger declares serviceCategories (e.g. ["baggage","wifi"]).
// For each category, the FIRST matching SKU from the catalogue is selected
// using categoryMatchesSku().  SKU.serviceCategory from the API is checked
// first; a keyword fallback on SKU.name handles null/empty categories.
// Each SKU id is used at most once per passenger (deduplication via usedSkuIds).
function addServices(d, checkoutId, svcPassengers, cartPassengers) {
  if (!svcPassengers || !svcPassengers.length) {
    console.log("[07_Add_Services] SKIPPED - No passengers returned from Services Catalogue");
    return;
  }

  // Build PTC queues for type-safe scenario passenger matching
  var svcScenQueues = {};
  for (var sqi = 0; sqi < d.passengers.length; sqi++) {
    var sqptc = String(d.passengers[sqi].passengerTypeCode || "ADT");
    if (!svcScenQueues[sqptc]) svcScenQueues[sqptc] = [];
    svcScenQueues[sqptc].push(d.passengers[sqi]);
  }
  var svcScenQueueIdx = {};

  const travellerBlocks = [];

  for (let i = 0; i < cartPassengers.length; i++) {
    const cartPax = cartPassengers[i];
    var svcPtc = normalizePtcString(cartPax.passengerTypeCode, "ADT");
    if (svcScenQueueIdx[svcPtc] === undefined) svcScenQueueIdx[svcPtc] = 0;
    var svcQueue = svcScenQueues[svcPtc] || [];
    const scenPax = svcQueue[svcScenQueueIdx[svcPtc]] || {};
    svcScenQueueIdx[svcPtc]++;

    const pid    = String(cartPax.travelerId || cartPax.passengerId || cartPax.id || "");
    const oldPid = String(cartPax.oldPassengerId || "");

    if (!pid) {
      console.log("[07_Add_Services] WARN - travelerId empty for slot " + (i + 1));
      continue;
    }

    const requestedCategories = Array.isArray(scenPax.serviceCategories) ? scenPax.serviceCategories : [];
    if (!requestedCategories.length) {
      dbg("[07_Add_Services] SKIP - No serviceCategories for pax=" + pid);
      continue;
    }

    // Match this passenger against the services catalogue by traveler ID
    let match = null;
    for (let j = 0; j < svcPassengers.length; j++) {
      const sid = String(svcPassengers[j].id || "");
      if (sid === pid || (oldPid && sid === oldPid)) { match = svcPassengers[j]; break; }
    }

    if (!match) {
      console.log("[07_Add_Services] WARN - No catalogue match for pax=" + pid +
        " Catalogue IDs=" + svcPassengers.map(function(p) { return String(p.id || ""); }).join(","));
      continue;
    }
    // Merge bound-level SKUs (passenger.SKUs) and flight-level SKUs
    // (passenger.segments[].SKUs) into one pool.
    // API structure confirmed from actual response:
    //   Bound-level  → passenger.SKUs[]            serviceCategory: "Extra Baggage", "Sports Equipment"
    //   Flight-level → passenger.segments[].SKUs[] serviceCategory: "Meal", "Wifi", "Other"
    // Without merging, categories "wifi" / "meals" / "other" always return no match.
    const allSkus = (match.SKUs || []).slice();
    const segments = match.segments || [];
    for (let sg = 0; sg < segments.length; sg++) {
      const segSkus = segments[sg].SKUs || [];
      for (let sk = 0; sk < segSkus.length; sk++) {
        allSkus.push(segSkus[sk]);
      }
    }

    if (!allSkus.length) {
      console.log("[07_Add_Services] SKIP - No SKUs available (bound or segment) for pax=" + pid);
      continue;
    }

    // Log full SKU pool (bound + segment) with API categories for debugging
    dbg("[07_Add_Services] pax=" + pid +
      " bound SKUs=" + (match.SKUs || []).length +
      " segmentSKUs=" + (allSkus.length - (match.SKUs || []).length) +
      " pool: " + allSkus.map(function(s) {
        return "\"" + s.name + "\"[cat=" + String(s.serviceCategory || "?") + "]";
      }).join(", "));

    // Pick one SKU per requested category — first match wins
    const serviceInputs = [];
    const usedSkuIds    = {};

    for (let c = 0; c < requestedCategories.length; c++) {
      const category    = requestedCategories[c];
      let   selectedSku = null;

      for (let s = 0; s < allSkus.length; s++) {
        const sku = allSkus[s];
        if (usedSkuIds[sku.id]) continue;
        if (categoryMatchesSku(category, sku)) {
          selectedSku = sku;
          break;
        }
      }

      if (selectedSku) {
        serviceInputs.push({ id: selectedSku.id, quantity: 1 });
        usedSkuIds[selectedSku.id] = true;
        dbg("[SVC_PICK] pax=" + pid +
          " category=" + category +
          " sku=" + selectedSku.id +
          " name=\"" + selectedSku.name + "\"" +
          " apiCategory=" + String(selectedSku.serviceCategory || "N/A"));
      } else {
        dbg("[SVC_NOT_FOUND] pax=" + pid +
          " category=" + category +
          " - no SKU matched; verify CATEGORY_KEYWORD_MAP covers the API serviceCategory values");
      }
    }

    if (serviceInputs.length) {
      travellerBlocks.push({ id: pid, services: serviceInputs });
    }
  }

  if (!travellerBlocks.length) {
    console.log("[07_Add_Services] FINAL SKIP - No valid services to add");
    return;
  }

  // Use variables format (consistent with addSeat and confirmed by actual API request shape)
  const query = `mutation AddService($input: ServicesInput!) {
    addService(input: $input) { data { id } }
  }`;
  const variables = { input: { checkoutId: checkoutId, traveller: travellerBlocks } };
  return postGql("07_Add_Services", config.ADD_SERVICES_URL, query, variables, d.name);
}

// ======================================================================
// STEP 08: Add Seats
// ======================================================================
// Multi-leg aware seat assignment.
// Accepts flightSeatMap: { flightId → [availableSeatNumbers] } so that
// connecting itineraries (e.g. HEL→AMS→LHR with two flight legs) are
// handled correctly — each passenger gets one seat entry per leg.
// Each flight maintains its own sequential pool index independently.
//
// Seats are OPTIONAL — failure does NOT abort the flow.
function addSeats(d, checkoutId, flightSeatMap, cartPassengers) {

  const flightIds = Object.keys(flightSeatMap || {});

  dbg(
    "[08_Add_Seats] PRE-CHECK" +
    " | checkoutId=" + String(checkoutId || "NULL") +
    " | flights=" + flightIds.length + " [" + flightIds.join(",") + "]" +
    " | cartPassengers=" + (cartPassengers ? cartPassengers.length : "NULL")
  );

  if (!checkoutId || !flightIds.length || !(cartPassengers && cartPassengers.length)) {
    console.log("[08_Add_Seats] SKIPPED - missing required inputs");
    return;
  }

  // Per-flight sequential pool — each leg consumes its own seat list independently
  const poolIndexes = {};
  for (let fi = 0; fi < flightIds.length; fi++) {
    poolIndexes[flightIds[fi]] = 0;
  }

  // Build PTC queues for type-safe scenario passenger matching
  var seatScenQueues = {};
  for (var stqi = 0; stqi < d.passengers.length; stqi++) {
    var stqptc = String(d.passengers[stqi].passengerTypeCode || "ADT");
    if (!seatScenQueues[stqptc]) seatScenQueues[stqptc] = [];
    seatScenQueues[stqptc].push(d.passengers[stqi]);
  }
  var seatScenQueueIdx = {};

  const travellerBlocks = [];

  for (let i = 0; i < cartPassengers.length; i++) {

    const cartPax = cartPassengers[i];
    var seatPtc = String(cartPax.passengerTypeCode || "").toUpperCase();
    if (seatScenQueueIdx[seatPtc] === undefined) seatScenQueueIdx[seatPtc] = 0;
    var seatQueue = seatScenQueues[seatPtc] || [];
    var scenPax = seatQueue[seatScenQueueIdx[seatPtc]] || {};
    seatScenQueueIdx[seatPtc]++;

    const travelerId = String(
      cartPax.travelerId ||
      cartPax.passengerId ||
      cartPax.id ||
      ""
    );

    if (!travelerId) {
      console.log("[08_Add_Seats] travelerId missing for slot " + i);
      continue;
    }

    // INF (lap infant) never occupies a physical seat
    const ptc = String(cartPax.passengerTypeCode || scenPax.passengerTypeCode || "").toUpperCase();
    if (ptc === "INF") {
      dbg("[08_Add_Seats] SKIP INF pax travelerId=" + travelerId);
      continue;
    }

    // Only assign if the scenario requests a seat for this passenger
    if (!scenPax.requestSeat) {
      dbg("[08_Add_Seats] SKIP requestSeat=false travelerId=" + travelerId + " ptc=" + ptc);
      continue;
    }

    // One seat entry per flight leg — if a leg's pool is exhausted that leg is skipped
    const seatEntries = [];
    for (let fi = 0; fi < flightIds.length; fi++) {
      const fid  = flightIds[fi];
      const pool = flightSeatMap[fid] || [];
      const idx  = poolIndexes[fid];

      if (idx >= pool.length) {
        dbg("[08_Add_Seats] WARN - Pool exhausted for flight=" + fid + " travelerId=" + travelerId);
        continue;
      }

      const seatNum = pool[idx];
      poolIndexes[fid] = idx + 1;
      seatEntries.push({ flightId: fid, seat: seatNum });
      dbg("[SEAT_ASSIGNED] travelerId=" + travelerId + " flight=" + fid + " seat=" + seatNum + " ptc=" + ptc);
    }

    if (seatEntries.length) {
      travellerBlocks.push({ id: travelerId, seat: seatEntries });
    }
  }

  if (!travellerBlocks.length) {
    console.log("[08_Add_Seats] No seats selected");
    return;
  }

  const query = `
    mutation ADDSeat($input: SeatInput!) {
      addSeat(input: $input) {
        data {
          id
          seat {
            seatNumber
            travelerId
            seatCharacteristics {
              code
            }
            isExempted
            isChargeable
          }
          flightId
        }
        dataLists
      }
    }`;

  const variables = {
    input: {
      checkoutId: checkoutId,
      traveller: travellerBlocks
    }
  };

  const payload = JSON.stringify({
    operationName: "ADDSeat",
    query,
    variables
  });

  dbg("[08_Add_Seats] REQUEST VARIABLES=");
  dbg(JSON.stringify(variables, null, 2));

  const url = config.ADD_SEAT_URL;
  const res = http.post(url, payload, {
    timeout: HTTP_TIMEOUT,
    tags: {
      name: "08_Add_Seats",
      flow: d.name
    }
  });

  logStep("08_Add_Seats", res, url);

  if (res.status !== 200) {

    let errCode = "";
    let errMsg = "";

    try {
      const j = safeJson(res);
      const e0 = j && j.errors && j.errors[0];

      errCode = (e0 && e0.code) ? String(e0.code) : "";
      errMsg  = (e0 && e0.message) ? String(e0.message) : "";
    } catch (e) {}

    console.log(
      "[08_Add_Seats] FAILED" +
      " | status=" + res.status +
      " | code=" + errCode +
      " | msg=" + errMsg +
      " | body=" + snippet(res.body, 2500)
    );

    seatAddFailCount.add(1);

  } else {

    dbg(
      "[08_Add_Seats] SUCCESS body=" +
      snippet(res.body, 2000)
    );
  }

  check(res, {
    "addSeat status 200": r => r.status === 200
  });

  return res;
}

// ======================================================================
// STEP 09: Checkout Confirm  (unchanged from original)
// ======================================================================
function checkoutConfirm(d, checkoutId) {
  const q = `mutation Confirm {
    ConfirmCheckout(CheckoutConfirmRequest:{ checkoutID:"${checkoutId}" }) { id }
  }`;
  const res = postGql("09_Checkout_Confirm", config.ORDER_CONFIRMATION_URL, q, {}, d.name);
  if (res.status !== 200) return "";
  const body = safeJson(res);
  try { return String(body.data.ConfirmCheckout.id || ""); } catch (e) { return ""; }
}

// ======================================================================
// STEP 10: Retrieve Order  (unchanged from original)
// ======================================================================
function retrieveOrder(d, orderId) {
  const q = `query RetrieveOrder {
    retrieveOrder(orderID:"${orderId}") {
      response { id pnrId }
      warnings { code message }
    }
  }`;
  const res = postGql("10_Retrieve_Order", config.ORDER_RETRIEVE_URL, q, {}, d.name);
  if (res && res.status === 200) dbg("[ORDER_RETRIEVE_BODY] " + snippet(res.body, 2500));
  return res;
}

// ======================================================================
// MAIN  (default function)
// ======================================================================
export default function () {
  // Pick scenario for this VU iteration — rotates through all scenarios in scenarios.json
  const scenario    = getScenario(__ITER);
  let   flowSuccess = false;

  // Structured log entry for this iteration — flushed to the run log file via handleSummary
  const iterLog = {
    iter:          __ITER,
    scenario:      scenario.name,
    route:         scenario.tripType + " " + (scenario.origin || "") + "->" + (scenario.destination || ""),
    paxCount:      scenario.passengers.length,
    skuId:         "",
    checkoutId:    "",
    flightIds:     "",
    seatsAdded:    false,
    servicesAdded: false,
    orderId:       "",
    result:        "FAILED",
    failedAt:      ""
  };

  group("Multi_Scenario_AllAPIs", function () {
    dbg(`[Config]   BASE_URL=${BASE_URL}`);
    dbg(`[Scenario] iter=${__ITER} | name=${scenario.name} | tripType=${scenario.tripType} | fareType=${scenario.fareType} | passengers=${scenario.passengers.length}`);

    // Step 01 — Auth
    const jwt = getAuthToken();
    if (!jwt) { iterLog.failedAt = "01_JWT_Token"; return; }

    // Step 02 — Get Offers (dynamic passengers + trip segments)
    // Returns array: OW → [skuOutbound], RT → [skuOutbound, skuInbound]
    const skuIds = shopOffer(scenario);
    iterLog.skuId = skuIds.join(",");
    if (!skuIds.length) { iterLog.failedAt = "02_Shop_Offer"; return; }

    // Step 03 — Create Cart
    const cart = createCart(scenario, skuIds);
    iterLog.checkoutId = String(cart.checkoutId || "");
    iterLog.flightIds  = (cart.flightIds || []).join(",");
    if (!cart.checkoutId) { iterLog.failedAt = "03_Create_Cart"; return; }

    // Step 03b — Retrieve Cart (verify cart state before checkout)
    const retrievedCart = retrieveCart(scenario, cart.checkoutId);
    if (!retrievedCart) {
      console.log("[WARN] Retrieve Cart returned no data; proceeding with cart from createCart response");
    }

    // Step 04 — Checkout Passengers (dynamic DOB + names)
    checkoutPassengers(scenario, cart.checkoutId, cart.passengers);

    // Step 05 — Services Catalogue
    const svcPassengers = servicesCatalogue(scenario, cart.checkoutId);

    // Step 07 — Add Services (name→SKU per passenger)
    const svcRes = addServices(scenario, cart.checkoutId, svcPassengers, cart.passengers);
    iterLog.servicesAdded = !!(svcRes && svcRes.status === 200);

    // Steps 06 + 08 — Seatmap then Add Seats (seats are OPTIONAL — failure does not abort flow)
    // One seatMap call per flight leg; results collected into flightSeatMap.
    // For direct flights this is one call; for connections (e.g. HEL→AMS→LHR) it is one per leg.
    var envFlightId = String(__ENV.FLIGHT_ID || "");
    var flightIds = (cart.flightIds && cart.flightIds.length)
      ? cart.flightIds
      : (envFlightId ? [envFlightId] : []);

    if (flightIds.length) {
      var flightSeatMap = {};
      for (var fi = 0; fi < flightIds.length; fi++) {
        var fid = flightIds[fi];
        flightSeatMap[fid] = seatMap(scenario, cart.checkoutId, fid);
      }
      const seatRes = addSeats(scenario, cart.checkoutId, flightSeatMap, cart.passengers);
      iterLog.seatsAdded = !!(seatRes && seatRes.status === 200);
      if (seatRes && seatRes.status !== 200) {
        console.log("[WARN] 08_Add_Seats failed (optional step) — booking will continue without seats");
      }
    } else {
      console.log("[WARN] flightIds is empty — 06_SeatMap and 08_Add_Seats skipped");
    }

    // Step 09 — Checkout Confirm
    const orderId = checkoutConfirm(scenario, cart.checkoutId);
    iterLog.orderId = String(orderId || "");
    if (orderId) {
      // Step 10 — Retrieve Order
      retrieveOrder(scenario, orderId);
      flowSuccess    = true;
      iterLog.result = "SUCCESS";
    } else {
      iterLog.failedAt = iterLog.failedAt || "09_Checkout_Confirm";
    }
  });

  logRun(iterLog);
  successCount.add(flowSuccess ? 1 : 0);
  failedCount.add(flowSuccess ? 0 : 1);
}

// ======================================================================
// HTML REPORT  (extended: adds Scenario Configuration table)
// ======================================================================
function _ms(v) { return v === null || v === undefined ? "-" : Number(v).toFixed(1); }
function _esc(s) {
  return String(s)
    .replace(/&/g,  "&amp;")
    .replace(/</g,  "&lt;")
    .replace(/>/g,  "&gt;")
    .replace(/"/g,  "&quot;")
    .replace(/'/g,  "&#39;");
}

export function handleSummary(data) {
  const metrics = data && data.metrics ? data.metrics : {};
  const flow    = FLOW_NAME;

  const vusMax         = (metrics.vus_max && metrics.vus_max.values && metrics.vus_max.values.max) || 1;
  const itersTotal     = (metrics.iterations && metrics.iterations.values && metrics.iterations.values.count) || 0;
  const iterRate       = (metrics.iterations && metrics.iterations.values && metrics.iterations.values.rate) || 0;
  const totalReq       = (metrics.http_reqs && metrics.http_reqs.values && metrics.http_reqs.values.count) || 0;
  const avgLat         = (metrics.http_req_duration && metrics.http_req_duration.values) ? metrics.http_req_duration.values.avg : null;
  const p95Lat         = (metrics.http_req_duration && metrics.http_req_duration.values) ? metrics.http_req_duration.values["p(95)"] : null;
  const minLat         = (metrics.http_req_duration && metrics.http_req_duration.values) ? metrics.http_req_duration.values.min : null;
  const maxLat         = (metrics.http_req_duration && metrics.http_req_duration.values) ? metrics.http_req_duration.values.max : null;
  const tps            = (metrics.http_reqs && metrics.http_reqs.values) ? metrics.http_reqs.values.rate : null;
  const failedIters    = (metrics.failed_iterations && metrics.failed_iterations.values && metrics.failed_iterations.values.count) || 0;
  const durationSec    = data.state ? data.state.testRunDurationMs / 1000 : 0;
  const durationMin    = (durationSec / 60).toFixed(2);
  const apiCallsPerTxn = itersTotal > 0 ? (totalReq / itersTotal).toFixed(1) : "-";

  const outName = ("Enhanced_" + flow + "_VUs" + vusMax + "_Iters" + itersTotal + ".html")
    .replace(/[^A-Za-z0-9_.-]+/g, "_");

  function getMetric(name) {
    return metrics[name] && metrics[name].values ? metrics[name].values : null;
  }

  const rows = STEPS.map(step => {
    const vT = getMetric("step_" + step);
    const vF = getMetric("fail_" + step);
    const vC = getMetric("count_" + step);
    const cnt      = (vC && vC.count !== undefined) ? vC.count : 0;
    const failRate = (vF && vF.rate) ? vF.rate * 100 : 0;
    return {
      step: step, count: cnt,
      avg:      (vT && vT.avg !== undefined)       ? vT.avg        : null,
      p95:      (vT && vT["p(95)"] !== undefined)  ? vT["p(95)"]   : null,
      min:      (vT && vT.min !== undefined)       ? vT.min        : null,
      max:      (vT && vT.max !== undefined)       ? vT.max        : null,
      failRate,
      status: failRate === 0 && cnt > 0 ? "✅" : (cnt === 0 ? "⚠️" : "❌"),
    };
  });

  let bottleneck = { step: "-", avg: 0 };
  rows.forEach(r => { if (r.avg !== null && r.avg > bottleneck.avg) bottleneck = { step: r.step, avg: r.avg }; });

  // Scenario configuration table (new)
  const scenTableHtml =
    '<table><thead><tr><th>#</th><th>Scenario</th><th>Trip</th><th>Route</th><th>Fare</th><th>Passengers (S=seat, →=assoc adult, [cat]=services)</th></tr></thead><tbody>' +
    TEST_SCENARIOS.map((sc, idx) => {
      const route = sc.tripType === "MC"
        ? sc.segments.map(s => s.origin + " → " + s.destination).join(", ")
        : (sc.origin || "") + " → " + (sc.destination || "");
      const paxSummary = sc.passengers
        .map(function(p) {
          let s = p.passengerTypeCode + (p.age !== undefined ? "(" + p.age + "yr)" : "");
          if (p.requestSeat) s += "[S]";
          if (p.associatedAdultIndex !== undefined) s += "→P" + p.associatedAdultIndex;
          if (p.serviceCategories && p.serviceCategories.length) s += "[" + p.serviceCategories.join("+") + "]";
          return s;
        })
        .join(", ");
      return `<tr>
        <td>${idx + 1}</td>
        <td>${_esc(sc.name)}</td>
        <td>${_esc(sc.tripType)}</td>
        <td>${_esc(route)}</td>
        <td>${_esc(sc.fareType)}</td>
        <td>${_esc(paxSummary)}</td>
      </tr>`;
    }).join("") +
    "</tbody></table>";

  // Per-step performance table
  const perfTableHtml =
    '<table><thead><tr><th>API Step</th><th>Count</th><th>RPS</th><th>Avg (ms)</th><th>Min (ms)</th><th>Max (ms)</th><th>P95 (ms)</th><th>Fail %</th></tr></thead><tbody>' +
    rows.map(r =>
      `<tr class="${r.failRate > 0 ? "fail" : ""}">
        <td>${_esc(r.step)}</td>
        <td>${_esc(r.count)}</td>
        <td>${Number(iterRate).toFixed(2)}</td>
        <td>${_ms(r.avg)}</td>
        <td>${_ms(r.min)}</td>
        <td>${_ms(r.max)}</td>
        <td>${_ms(r.p95)}</td>
        <td>${Number(r.failRate).toFixed(2)}</td>
       
      </tr>`
    ).join("") +
    "</tbody></table>";

  const errHtml = ERROR_LOG.length
    ? '<div class="section"><h2>Failures observed</h2><table><thead><tr><th>Step</th><th>Status</th><th>Code</th><th>Message</th></tr></thead><tbody>' +
      ERROR_LOG.map(e =>
        `<tr class="fail"><td>${_esc(e.step)}</td><td>${_esc(e.status)}</td><td>${_esc(e.code || "")}</td><td>${_esc(e.message || "")}</td></tr>`
      ).join("") +
      "</tbody></table></div>"
    : "";

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>Multi-Scenario Booking Summary</title>
<style>
body{font-family:Arial;background:#f0f4f1;margin:20px}
.section{background:#dfece0;padding:16px;border-radius:12px;margin-bottom:18px;border-left:6px solid #2e7d32}
.kpis{display:flex;flex-wrap:wrap;gap:15px}
.kpi{background:#eef1f3;border-radius:10px;padding:12px;min-width:170px}
.val{font-size:22px;font-weight:700}
.muted{color:#555;font-size:12px}
.fail-text{color:#dc2626}
table{width:100%;border-collapse:collapse;margin-top:10px}
th,td{border:1px solid #ddd;padding:8px;font-size:12px}
th{background:#eee}
tr.fail td{background:#fee2e2}
</style>
</head><body>

<h1>Multi-Scenario Booking Test Summary</h1>

<div class="section">
<div class="kpis">

<div class="kpi">
  <div class="muted">Flow</div>
  <div class="val">${_esc(flow)}</div>
</div>

<div class="kpi">
  <div class="muted">Total Scenarios</div>
  <div class="val">${TEST_SCENARIOS.length}</div>
</div>

<div class="kpi">
  <div class="muted">VUs</div>
  <div class="val">${vusMax}</div>
</div>

<div class="kpi">
  <div class="muted">Total Iterations</div>
  <div class="val">${itersTotal}</div>
</div>

<div class="kpi">
  <div class="muted">Failed Iterations</div>
  <div class="val ${failedIters > 0 ? "fail-text" : ""}">${failedIters}</div>
</div>

<div class="kpi">
  <div class="muted">Test Duration</div>
  <div class="val">${durationMin} min</div>
</div>

<div class="kpi">
  <div class="muted">Avg Latency</div>
  <div class="val">${_ms(avgLat)} ms</div>
</div>

<div class="kpi">
  <div class="muted">P95 Latency</div>
  <div class="val">${_ms(p95Lat)} ms</div>
</div>

<div class="kpi">
  <div class="muted">API Calls / Txn</div>
  <div class="val">${apiCallsPerTxn}</div>
</div>

</div>





<div class="section">
<h2>Per-step performance</h2>
${perfTableHtml}
</div>

${errHtml}

</body></html>`;

  // Build plain-text run log file
  var logLines = [
    "=== k6 Performance Run Log ===",
    "Flow:     " + flow,
    "VUs:      " + vusMax,
    "Iters:    " + itersTotal + "  (failed: " + failedIters + ")",
    "Duration: " + durationMin + " min",
    "Avg Lat:  " + _ms(avgLat) + " ms   P95: " + _ms(p95Lat) + " ms",
    "",
    "=== Per-Step Summary ===",
    ""
  ];
  for (var si = 0; si < rows.length; si++) {
    var r = rows[si];
    logLines.push(
      r.status + "  " +
      String(r.step).padEnd(28) +
      " count=" + String(r.count).padStart(4) +
      "  avg=" + _ms(r.avg) + "ms" +
      "  p95=" + _ms(r.p95) + "ms" +
      "  fail=" + Number(r.failRate).toFixed(1) + "%"
    );
  }
  logLines.push("");
  logLines.push("=== Per-Iteration Results ===");
  logLines.push("");
  for (var li = 0; li < RUN_LOG.length; li++) {
    var e = RUN_LOG[li];
    logLines.push("[Iter " + e.iter + "] " + e.scenario + "  route=" + e.route + "  pax=" + e.paxCount);
    logLines.push("  SKU        : " + (e.skuId      || "N/A"));
    logLines.push("  CheckoutId : " + (e.checkoutId || "N/A"));
    logLines.push("  Flights    : " + (e.flightIds  || "N/A"));
    logLines.push("  Services   : " + (e.servicesAdded ? "ADDED"          : "skipped / not requested / failed"));
    logLines.push("  Seats      : " + (e.seatsAdded    ? "ADDED"          : "skipped / no flight / failed"));
    logLines.push("  Order      : " + (e.orderId    || "N/A"));
    logLines.push("  Result     : " + e.result + (e.failedAt ? "  (failed at: " + e.failedAt + ")" : ""));
    logLines.push("");
  }
  if (ERROR_LOG.length) {
    logLines.push("=== HTTP Errors (captured up to 20) ===");
    logLines.push("");
    for (var ei = 0; ei < ERROR_LOG.length; ei++) {
      var err = ERROR_LOG[ei];
      logLines.push("[" + err.step + "]  status=" + err.status + "  code=" + (err.code || "-") + "  msg=" + (err.message || "-"));
      logLines.push("  body: " + (err.body || ""));
      logLines.push("");
    }
  }
  var logContent = logLines.join("\n");
  var logName    = ("RunLog_" + flow + "_VUs" + vusMax + "_Iters" + itersTotal + ".txt")
    .replace(/[^A-Za-z0-9_.-]+/g, "_");

  return { [outName]: html, [logName]: logContent };
}
