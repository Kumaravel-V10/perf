import http from 'k6/http';
import { check } from 'k6';
import { config, headers } from './config.js';
import { 
  extractSkuId, 
  extractCheckoutId, 
  extractPassengerIds,
  extractFlightId,
  safeJsonParse,
  checkLandingPage,
  checkGraphqlResponse
} from './helpers.js';
import {
  getOffersQuery,
  createCartMutation,
  updatePassengerMutation,
  getSeatMapQuery,
  confirmCheckoutMutation,
  getServicesCatalogueQuery,
  addServiceMutation,
  addSeatMutation,
  retrieveOrderQuery
} from './queries.js';
import { generateBookingWithScenario } from '../scripts/passenger-data-loader.js';

// WireMock-accepted booking scenarios — only these will be matched by the mock server
const WIREMOCK_SCENARIOS = [
  {
    name: 'SC1_OW_HEL_OUL_Economy',
    tripType: 'OW',
    origin: 'HEL',
    destination: 'OUL',
    departureDate: '2026-08-01',
    fareType: 'Economy',
    airlineId: 'AY',
    agentId: '1234567890',
    passengers: [
      { passengerTypeCode: 'ADT', dateOfBirth: '1996-07-14' },
    ],
  },
  {
    name: 'SC2_OW_HEL_ARN_Economy',
    tripType: 'OW',
    origin: 'HEL',
    destination: 'ARN',
    departureDate: '2026-08-01',
    fareType: 'Economy',
    airlineId: 'AY',
    agentId: '1234567890',
    passengers: [
      { passengerTypeCode: 'ADT', dateOfBirth: '1992-07-14' },
      { passengerTypeCode: 'ADT', dateOfBirth: '1984-07-14' },
      { passengerTypeCode: 'CHD', dateOfBirth: '2018-07-14' },
    ],
  },
  {
    name: 'SC3_OW_HEL_LHR_Economy',
    tripType: 'OW',
    origin: 'HEL',
    destination: 'LHR',
    departureDate: '2026-08-01',
    fareType: 'Economy',
    airlineId: 'AY',
    agentId: '1234567890',
    passengers: [
      { passengerTypeCode: 'ADT', dateOfBirth: '1988-07-14' },
      { passengerTypeCode: 'INS', dateOfBirth: '2025-07-14', associatedAdultIndex: 0 },
      { passengerTypeCode: 'CHD', dateOfBirth: '2017-07-14' },
    ],
  },
  {
    name: 'SC4_RT_HEL_CPH_Economy',
    tripType: 'RT',
    origin: 'HEL',
    destination: 'CPH',
    departureDate: '2026-08-01',
    returnDate: '2026-08-08',
    fareType: 'Economy',
    airlineId: 'AY',
    agentId: '1234567890',
    passengers: [
      { passengerTypeCode: 'ADT', dateOfBirth: '1986-07-14' },
    ],
  },
  {
    name: 'SC5_RT_HEL_FRA_Economy',
    tripType: 'RT',
    origin: 'HEL',
    destination: 'FRA',
    departureDate: '2026-08-01',
    returnDate: '2026-08-08',
    fareType: 'Economy',
    airlineId: 'AY',
    agentId: '1234567890',
    passengers: [
      { passengerTypeCode: 'ADT', dateOfBirth: '1994-07-14' },
      { passengerTypeCode: 'ADT', dateOfBirth: '1990-07-14' },
      { passengerTypeCode: 'CHD', dateOfBirth: '2017-07-14' },
    ],
  },
  {
    name: 'SC6_OW_ARN_HEL_Business',
    tripType: 'OW',
    origin: 'ARN',
    destination: 'HEL',
    departureDate: '2026-08-01',
    fareType: 'Business',
    airlineId: 'AY',
    agentId: '1234567890',
    passengers: [
      { passengerTypeCode: 'ADT', dateOfBirth: '1997-07-14' },
    ],
  },
];

// Rotate through all scenarios deterministically — iter 0→SC1, 1→SC2 … wraps around
function getScenario(iter) {
  return WIREMOCK_SCENARIOS[iter % WIREMOCK_SCENARIOS.length];
}

// Root-cause: the passenger validation pattern rejects any name that contains
// digits or non-alphabetic characters.  Strictly [A-Za-z] only.
const PAX_FIRST_NAMES = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel'];
const PAX_LAST_NAMES  = ['Smith', 'Jones', 'Brown', 'Taylor', 'Wilson', 'Evans', 'Thomas', 'Roberts'];

// Build the passenger array for updatePassengerMutation using scenario DOBs and iterated names
function buildScenarioPassengers(scenario, cartPassengerIds, iter) {
  // Group cart IDs by normalised type
  const idsByType = {};
  for (const p of (Array.isArray(cartPassengerIds) ? cartPassengerIds : [])) {
    const type = String(p.passengerTypeCode || '').replace(/"/g, '').trim().toUpperCase();
    if (!idsByType[type]) idsByType[type] = [];
    idsByType[type].push(p.passengerId);
  }
  const usedIdxByType = {};

  // Collect ADT cart IDs in order to resolve associatedAdultIndex for INS passengers
  const adtCartIds = idsByType['ADT'] || [];

  const passengers = [];
  let paxIndex = 0;

  for (const pax of (scenario.passengers || [])) {
    const type = String(pax.passengerTypeCode || '').toUpperCase();
    if (!usedIdxByType[type]) usedIdxByType[type] = 0;

    const cartId = (idsByType[type] || [])[usedIdxByType[type]];
    usedIdxByType[type]++;

    if (!cartId) {
      console.log(`[buildScenarioPassengers] No cart ID for type=${type}, skipping`);
      continue;
    }

    const nameIdx = (iter + paxIndex) % PAX_FIRST_NAMES.length;
    paxIndex++;

    const firstName = PAX_FIRST_NAMES[nameIdx];
    const lastName  = PAX_LAST_NAMES[nameIdx];

    const passenger = {
      id: cartId,
      passengerTypeCode: type,
      identityDetails: {
        firstName,
        lastName,
        gender: 'male',
        nameType: 'universal',
        dateOfBirth: pax.dateOfBirth,
        title: type === 'CHD' || type === 'INF' || type === 'INS' ? 'master' : 'mr',
      },
    };

    // API requires: "At least one contact should need to be provided for a trip!"
    // Only the first ADT gets contactDetails; non-adults must NOT have them.
    if (type === 'ADT' && !passengers.some(p => p.contactDetails)) {
      passenger.contactDetails = {
        email: [
          {
            isDefault: true,
            category: 'personal',
            purposes: ['standard'],
            emailAddress: firstName.toLowerCase() + '.' + lastName.toLowerCase() + '@example.com',
          }
        ],
        mobile: [
          {
            isDefault: true,
            category: 'personal',
            number: '9876543210',
            countryCode: '+91',
            purposes: ['standard'],
          }
        ],
      };
    }

    // INS (infant with seat) requires NO association — confirmed from real API payload.
    // INF (infant without seat) requires the ADULT to carry associatedPassengerId
    // pointing to the infant's ID (not the other way around). Handled in second pass below.

    passengers.push(passenger);
  }

  // Second pass: for INF passengers with associatedAdultIndex, set associatedPassengerId
  // on the ADULT (pointing to the infant's cart ID). The ADULT carries the link, not the infant.
  for (let i = 0; i < scenario.passengers.length; i++) {
    const scenPax = scenario.passengers[i];
    const type = String(scenPax.passengerTypeCode || '').toUpperCase();
    if (type === 'INF' && typeof scenPax.associatedAdultIndex === 'number') {
      // Find the INF passenger in our built array
      const infPax = passengers.find(p => p.passengerTypeCode === 'INF');
      // Find the associated ADT passenger
      const adultIdx = scenPax.associatedAdultIndex;
      const adultPax = passengers.filter(p => p.passengerTypeCode === 'ADT')[adultIdx];
      if (infPax && adultPax) {
        adultPax.associatedPassengerId = infPax.id;
      }
    }
  }

  return passengers;
}

// Post passenger update using scenario-derived passenger data
function updatePassengersFromScenario(checkoutId, scenario, cartPassengerIds, testType, authToken, iter) {
  try {
    const preparedPassengers = buildScenarioPassengers(scenario, cartPassengerIds, iter);
    if (!preparedPassengers.length) {
      console.log('[update_passenger] No passengers built from scenario, skipping');
      return { response: { status: 204 }, data: null };
    }
    const mutation = updatePassengerMutation(checkoutId, preparedPassengers);

    console.log(`[update_passenger] scenario=${scenario.name} paxCount=${preparedPassengers.length} types=${preparedPassengers.map(p => p.passengerTypeCode).join(',')}`);

    const res = http.post(
      config.PASSENGERS_URL,
      JSON.stringify(mutation),
      {
        headers: headers.graphql(config.BASE_URL, authToken),
        tags: { name: 'update_passenger' },
        timeout: '30s',
      }
    );
    if (res.status !== 200) {
      console.log(`[update_passenger] FAILED scenario=${scenario.name} status=${res.status} body=${String(res.body || '').substring(0, 1500)}`);
    }
    checkGraphqlResponse(res, 'passenger', testType);
    return { response: res, data: safeJsonParse(res.body) };
  } catch (e) {
    console.log(`[update_passenger] error: ${e.message || e}`);
    return { response: { status: 500 }, data: null };
  }
}

const RETRYABLE_STATUS = {
  0: true,
  408: true,
  425: true,
  429: true,
  500: true,
  502: true,
  503: true,
  504: true,
};

function shouldRetryStatus(status) {
  return !!RETRYABLE_STATUS[Number(status) || 0];
}

function postWithRetry(url, payload, requestParams, stepName, maxAttempts = 3) {
  let res = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    res = http.post(url, payload, requestParams);
    if (!shouldRetryStatus(res.status)) {
      return res;
    }

    if (attempt < maxAttempts) {
      console.log(`[${stepName}] retrying attempt ${attempt + 1}/${maxAttempts} after status=${res.status}`);
    }
  }

  return res;
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
    return null;
  } catch (e) {
    console.log(`Token request error: ${e.message || e}`);
    return null;
  }
}

// Load landing page
export function loadLandingPage(testType = 'smoke', authToken = null) {
  try {
    const h = Object.assign({}, headers.html);
    if (authToken) {
      h['Cookie'] = authToken;
    }
    const res = http.get(config.BASE_URL, { 
      headers: h,
      tags: { name: 'landing_page' },
      timeout: '30s'
    });
    
    checkLandingPage(res, testType);
    return res;
  } catch (e) {
    return { status: 500, body: '' };
  }
}

// Search for flight offers
export function searchFlightOffers(origin, destination, departureDate, testType = 'smoke', authToken = null, tripType = 'OW', returnDate = null, fareType = 'Economy', passengers = null) {
  try {
    const query = getOffersQuery(origin, destination, departureDate, tripType, fareType, returnDate, passengers);
    
    const res = http.post(
      config.GRAPHQL_URL, 
      JSON.stringify(query), 
      {
        headers: headers.graphql(config.BASE_URL, authToken),
        tags: { name: 'get_offers' },
        timeout: '60s'
      }
    );
    
    checkGraphqlResponse(res, 'offers', testType);
    
    const data = safeJsonParse(res.body);
    const skuId = extractSkuId(data);
    
    return { response: res, data, skuId };
  } catch (e) {
    return { response: { status: 500 }, data: null, skuId: null };
  }
}

// Create cart with selected SKU
export function createCart(skuId, testType = 'smoke', authToken = null, airlineId = 'AY', agentId = '1234567890') {
  try {
    const mutation = createCartMutation(skuId, airlineId, agentId);
    
    const res = http.post(
      config.ONE_SHOT_CART_URL,
      JSON.stringify(mutation),
      {
        headers: headers.graphql(config.BASE_URL, authToken),
        tags: { name: 'create_cart' },
        timeout: '60s'
      }
    );
    
    checkGraphqlResponse(res, 'cart', testType);
    
    const data = safeJsonParse(res.body);
    const checkoutId = extractCheckoutId(data);
    const passengerIds = extractPassengerIds(data);
    const flightId = extractFlightId(data);
    
    return { response: res, data, checkoutId, passengerIds, flightId };
  } catch (e) {
    return { response: { status: 500 }, data: null, checkoutId: null, passengerIds: [], flightId: null };
  }
}

// Update passenger information
export function updatePassengers(checkoutId, passengerIds, testType = 'smoke', authToken = null) {
  try {
    // Generate booking data with scenarios
    const bookingData = generateBookingWithScenario();

    const normalizePassengerType = (value, fallback = 'ADT') => {
      const normalized = String(value === undefined || value === null ? '' : value)
        .replace(/"/g, '')
        .trim()
        .toUpperCase()
        .replace(/[^A-Z]/g, '');
      return normalized || fallback;
    };

    const priorityByType = {
      ADT: 0,
      CHD: 1,
      INF: 2,
    };

    const normalizedPassengerIds = (Array.isArray(passengerIds) ? passengerIds : []).map((p) => ({
      passengerId: p && p.passengerId ? p.passengerId : null,
      passengerTypeCode: normalizePassengerType(p && p.passengerTypeCode, ''),
    }));
    
    // Map scenario passengers to cart passengers by type (ADT/CHD/INF) instead of index.
    // This avoids mismatches when scenario order differs from cart response order.
    const passengerIdsByType = normalizedPassengerIds.reduce((acc, p) => {
      const type = normalizePassengerType(p.passengerTypeCode, 'ADT');
      if (!acc[type]) {
        acc[type] = [];
      }
      acc[type].push(p);
      return acc;
    }, {});

    const usedIds = new Set();
    const placeholderToActualId = {};

    const sortedScenarioPassengers = (Array.isArray(bookingData.passengers) ? bookingData.passengers : [])
      .slice()
      .sort((a, b) => {
        const typeA = normalizePassengerType(a && a.passengerTypeCode, 'ADT');
        const typeB = normalizePassengerType(b && b.passengerTypeCode, 'ADT');
        const prioA = Object.prototype.hasOwnProperty.call(priorityByType, typeA) ? priorityByType[typeA] : 99;
        const prioB = Object.prototype.hasOwnProperty.call(priorityByType, typeB) ? priorityByType[typeB] : 99;
        return prioA - prioB;
      });

    const preparedPassengers = sortedScenarioPassengers
      .map((originalPassenger) => {
        const passenger = JSON.parse(JSON.stringify(originalPassenger));
        const type = normalizePassengerType(passenger.passengerTypeCode, 'ADT');
        passenger.passengerTypeCode = type;
        const typedCandidates = passengerIdsByType[type] || [];

        let mappedPassenger = typedCandidates.find((p) => p && p.passengerId && !usedIds.has(p.passengerId));

        // Only ADT may use fallback mapping. Non-ADT fallback can incorrectly consume adult IDs.
        if (!mappedPassenger && type === 'ADT') {
          mappedPassenger = normalizedPassengerIds.find((p) => p && p.passengerId && !usedIds.has(p.passengerId));
        }

        if (!mappedPassenger || !mappedPassenger.passengerId) {
          return null;
        }

        const oldPlaceholderId = passenger.id;
        passenger.id = mappedPassenger.passengerId;
        usedIds.add(mappedPassenger.passengerId);

        if (oldPlaceholderId) {
          placeholderToActualId[oldPlaceholderId] = mappedPassenger.passengerId;
        }

        return passenger;
      })
      .filter(Boolean);

    // Remap placeholder associated IDs (e.g. INF-1) to actual cart passenger IDs.
    preparedPassengers.forEach((passenger) => {
      if (
        passenger.associatedPassengerId &&
        placeholderToActualId[passenger.associatedPassengerId]
      ) {
        passenger.associatedPassengerId = placeholderToActualId[passenger.associatedPassengerId];
      }
    });
    
    // CRITICAL FIX: API rules for contact details
    // 1. "Atleast one contact should need to be provide for a trip!"
    // 2. "Contact details cannot be provided for the passenger other than ADULT"
    
    // Step 1: Remove contact details from all non-adult passengers
    preparedPassengers.forEach(passenger => {
      if (normalizePassengerType(passenger.passengerTypeCode, 'ADT') !== 'ADT' && passenger.contactDetails) {
        delete passenger.contactDetails;
      }
    });
    
    // Step 2: Ensure at least one adult has complete contact details
    const firstAdult = preparedPassengers.find(p => normalizePassengerType(p.passengerTypeCode, 'ADT') === 'ADT');
    
    if (firstAdult) {
      // Check if adult has valid contact details
      const hasValidEmail = firstAdult.contactDetails && 
                           firstAdult.contactDetails.email && 
                           firstAdult.contactDetails.email.length > 0 &&
                           firstAdult.contactDetails.email[0].emailAddress;
      
      const hasValidMobile = firstAdult.contactDetails && 
                            firstAdult.contactDetails.mobile && 
                            firstAdult.contactDetails.mobile.length > 0 &&
                            firstAdult.contactDetails.mobile[0].number;
      
      // If either email or mobile is missing/invalid, add complete contact details
      if (!hasValidEmail || !hasValidMobile) {
        firstAdult.contactDetails = {
          email: [
            {
              isDefault: true,
              category: 'personal',
              purposes: ['standard'],
              emailAddress: 'test.booking@example.com'
            }
          ],
          mobile: [
            {
              isDefault: true,
              category: 'personal',
              number: '9876543210',
              countryCode: '+91',
              purposes: ['standard']
            }
          ]
        };
      }
    }
    
    const mutation = updatePassengerMutation(checkoutId, preparedPassengers);
    
    const res = http.post(
      config.PASSENGERS_URL,
      JSON.stringify(mutation),
      {
        headers: headers.graphql(config.BASE_URL, authToken),
        tags: { name: 'update_passenger' },
        timeout: '30s'
      }
    );

    console.log(res)

    checkGraphqlResponse(res, 'passenger', testType);
    
    return { response: res, data: safeJsonParse(res.body) };
  } catch (e) {
    return { response: { status: 500 }, data: null };
  }
}

// Get seat map
export function getSeatMap(checkoutId, flightId, testType = 'smoke', authToken = null) {
  try {
    const query = getSeatMapQuery(checkoutId, flightId);

    const payload = JSON.stringify(query);
    const requestParams = {
      headers: headers.graphql(config.BASE_URL, authToken),
      tags: { name: 'seat_map' },
      timeout: '30s'
    };

    const res = postWithRetry(
      config.SEAT_MAP_URL,
      payload,
      requestParams,
      'seat_map',
      Number(__ENV.SEATMAP_RETRY_ATTEMPTS || '3')
    );
    
    checkGraphqlResponse(res, 'seat map', testType);
    
    return { response: res, data: safeJsonParse(res.body) };
  } catch (e) {
    return { response: { status: 500 }, data: null };
  }
}

function extractAvailableSeatNumbers(seatMapData) {
  const out = [];
  try {
    const seatmaps = seatMapData.data.getSeatMap.data.seatmaps || [];
    for (let i = 0; i < seatmaps.length; i++) {
      const decks = seatmaps[i].decks || [];
      for (let j = 0; j < decks.length; j++) {
        const seats = decks[j].seats || [];
        for (let k = 0; k < seats.length; k++) {
          const seat = seats[k];
          const t0 = (seat.travelers || [])[0];
          if (t0 && String(t0.seatAvailabilityStatus).toLowerCase() === 'available') {
            out.push(String(seat.seatNumber));
          }
        }
      }
    }
  } catch (e) {
    return [];
  }
  return out;
}

// Get services catalogue
export function getServicesCatalogue(checkoutId, testType = 'smoke', authToken = null) {
  try {
    const query = getServicesCatalogueQuery(checkoutId);

    const payload = JSON.stringify(query);
    const requestParams = {
      headers: headers.graphql(config.BASE_URL, authToken),
      tags: { name: 'get_services' },
      timeout: '30s'
    };

    const res = postWithRetry(
      config.SERVICES_URL,
      payload,
      requestParams,
      'get_services',
      Number(__ENV.SERVICES_RETRY_ATTEMPTS || '3')
    );

    checkGraphqlResponse(res, 'services catalogue', testType);

    const data = safeJsonParse(res.body);
    let passengers = [];
    try {
      passengers = data.data.getServicesCatalogue.connections[0].passengers || [];
    } catch (e) {
      passengers = [];
    }

    if (!passengers.length) {
      console.log('[get_services] No passengers returned from services catalogue');
    }

    return { response: res, data, passengers };
  } catch (e) {
    return { response: { status: 500 }, data: null, passengers: [] };
  }
}

// Add service selections
export function addServices(checkoutId, cartPassengers, servicePassengers, testType = 'smoke', authToken = null) {
  try {
    if (!servicePassengers || !servicePassengers.length) {
      console.log('[add_service] SKIPPED - no service passengers');
      return { response: { status: 204 }, data: null };
    }

    const traveller = [];

    for (let i = 0; i < cartPassengers.length; i++) {
      const pid = String(cartPassengers[i].passengerId);
      const oldPid = cartPassengers[i].oldPassengerId ? String(cartPassengers[i].oldPassengerId) : '';
      let match = null;

      for (let j = 0; j < servicePassengers.length; j++) {
        const sid = String(servicePassengers[j].id);
        if (sid === pid || (oldPid && sid === oldPid)) {
          match = servicePassengers[j];
          break;
        }
      }

      if (!match) {
        console.log(`[add_service] SKIPPED - no catalogue match for passenger ${pid} | catalogue IDs: ${servicePassengers.map(p => String(p.id)).join(',')}`);
        continue;
      }

      // Merge bound-level SKUs and segment-level SKUs into one pool
      let allSkus = (match.SKUs) ? match.SKUs.slice() : [];
      if (match.segments) {
        for (let s = 0; s < match.segments.length; s++) {
          const segSkus = (match.segments[s] && match.segments[s].SKUs) || [];
          for (let sk = 0; sk < segSkus.length; sk++) {
            allSkus.push(segSkus[sk]);
          }
        }
      }

      if (!allSkus.length) {
        console.log(`[add_service] SKIPPED - no SKU for passenger ${pid} (matched but SKUs empty at bound+segment level)`);
        continue;
      }

      traveller.push({
        id: pid,
        services: [{
          id: String(allSkus[0].id),
          quantity: 1
        }]
      });
    }

    if (!traveller.length) {
      console.log('[add_service] SKIPPED - no valid service request built');
      return { response: { status: 204 }, data: null };
    }

    const mutation = addServiceMutation(checkoutId, traveller);

    const res = http.post(
      config.SEAT_SERVICES_URL,
      JSON.stringify(mutation),
      {
        headers: headers.graphql(config.BASE_URL, authToken),
        tags: { name: 'add_service' },
        timeout: '30s'
      }
    );

    checkGraphqlResponse(res, 'add service', testType);

    return { response: res, data: safeJsonParse(res.body) };
  } catch (e) {
    return { response: { status: 500 }, data: null };
  }
}

// Add seat selections
export function addSeats(checkoutId, flightId, seatNumbers, passengerIds, testType = 'smoke', authToken = null) {
  try {
    if (!flightId || !seatNumbers || !seatNumbers.length || !passengerIds || !passengerIds.length) {
      console.log('[add_seat] SKIPPED - flight/seat/passenger data missing');
      return { response: { status: 204 }, data: null };
    }

    const traveller = [];
    const count = Math.min(passengerIds.length, seatNumbers.length);

    for (let i = 0; i < count; i++) {
      traveller.push({
        id: String(passengerIds[i].passengerId),
        seat: [{
          flightId: String(flightId),
          seat: String(seatNumbers[i])
        }]
      });
    }

    if (!traveller.length) {
      console.log('[add_seat] SKIPPED - no valid seat request built');
      return { response: { status: 204 }, data: null };
    }

    const mutation = addSeatMutation(checkoutId, traveller);

    const res = http.post(
      config.SEAT_SERVICES_URL,
      JSON.stringify(mutation),
      {
        headers: headers.graphql(config.BASE_URL, authToken),
        tags: { name: 'add_seat' },
        timeout: '30s'
      }
    );

    checkGraphqlResponse(res, 'add seat', testType);

    return { response: res, data: safeJsonParse(res.body) };
  } catch (e) {
    return { response: { status: 500 }, data: null };
  }
}

// Confirm checkout
export function confirmCheckout(checkoutId, testType = 'smoke', authToken = null) {
  try {
    if (!checkoutId || checkoutId.trim() === '') {
      return { response: { status: 400 }, data: null };
    }

    const mutation = confirmCheckoutMutation(checkoutId.trim());

    const res = http.post(
      config.ORDER_CONFIRMATION_URL,
      JSON.stringify(mutation),
      {
        headers: headers.graphql(config.BASE_URL, authToken),
        tags: { name: 'checkout_confirmation' },
        timeout: '30s'
      }
    );
    
    checkGraphqlResponse(res, 'checkout confirmation', testType);
    
    return { response: res, data: safeJsonParse(res.body) };
  } catch (e) {
    return { response: { status: 500 }, data: null };
  }
}

// Retrieve order
export function retrieveOrder(orderId, testType = 'smoke', authToken = null) {
  try {
    if (!orderId || String(orderId).trim() === '') {
      return { response: { status: 400 }, data: null };
    }

    const query = retrieveOrderQuery(String(orderId).trim());

    const res = http.post(
      config.ORDER_RETRIEVE_URL,
      JSON.stringify(query),
      {
        headers: headers.graphql(config.BASE_URL, authToken),
        tags: { name: 'retrieve_order' },
        timeout: '30s'
      }
    );

    checkGraphqlResponse(res, 'retrieve order', testType);

    return { response: res, data: safeJsonParse(res.body) };
  } catch (e) {
    return { response: { status: 500 }, data: null };
  }
}

// Complete booking flow
export function completeBookingFlow(testType = 'smoke', iter = 0) {
  // Rotate through all WireMock scenarios deterministically using the iteration number
  const scenario = getScenario(iter);

  // Step 0: Acquire auth token
  const authToken = getAuthToken();
  if (!authToken) {
    console.log('ERROR: Failed to acquire auth token, stopping flow');
    return { success: false, step: 'auth' };
  }

  // Step 1: Load landing page
  const landingPageResult = loadLandingPage(testType, authToken);
  
  // Step 2: Search for flights using scenario parameters
  const { skuId } = searchFlightOffers(
    scenario.origin,
    scenario.destination,
    scenario.departureDate,
    testType,
    authToken,
    scenario.tripType,
    scenario.returnDate || null,
    scenario.fareType,
    scenario.passengers
  );
  
  if (!skuId) {
    return { success: false, step: 'search' };
  }
  
  // Step 3: Create cart with scenario airline/agent
  const { checkoutId, passengerIds, flightId } = createCart(skuId, testType, authToken, scenario.airlineId, scenario.agentId);
  
  if (!checkoutId || passengerIds.length === 0) {
    return { success: false, step: 'cart', checkoutId };
  }
  
  // Step 4: Update passengers with scenario DOBs and randomised valid names
  const passengerResult = updatePassengersFromScenario(checkoutId, scenario, passengerIds, testType, authToken, iter);

  // After updatePassengerInformation the API may assign new passenger IDs.
  // The services catalogue returns passengers keyed by these new IDs, so
  // passing the original createCart IDs to addServices/addSeats causes a
  // lookup miss ("SKIPPED - no SKU for passenger ...").
  // Extract the refreshed IDs from the mutation response and use them downstream.
  let effectivePassengerIds = passengerIds;
  try {
    const updatedPax = passengerResult.data
      && passengerResult.data.data
      && passengerResult.data.data.updatePassengerInformation
      && passengerResult.data.data.updatePassengerInformation.passengers;
    if (updatedPax && updatedPax.length) {
      effectivePassengerIds = updatedPax.map(function(p) {
        return { passengerId: p.id, passengerTypeCode: p.passengerTypeCode };
      });
      console.log('[completeBookingFlow] Refreshed passenger IDs from updatePassengerInformation: ' + effectivePassengerIds.length);
    }
  } catch (e) {
    console.log('[completeBookingFlow] Could not extract updated passenger IDs, falling back to cart IDs: ' + e);
  }

  // Step 5: Get services catalogue
  const servicesResult = getServicesCatalogue(checkoutId, testType, authToken);

  // Step 6: Get seat map
  let seatNumbers = [];
  let seatMapResult = { response: { status: 204 }, data: null };
  if (flightId) {
    seatMapResult = getSeatMap(checkoutId, flightId, testType, authToken);
    seatNumbers = extractAvailableSeatNumbers(seatMapResult.data || {});
  }

  // Step 7: Add services
  const addServicesResult = addServices(
    checkoutId,
    effectivePassengerIds,
    servicesResult.passengers,
    testType,
    authToken
  );

  // Step 8: Add seats
  const addSeatsResult = addSeats(checkoutId, flightId, seatNumbers, effectivePassengerIds, testType, authToken);
  
  // Step 9: Confirm checkout (attempt even if previous steps failed)
  const confirmResult = confirmCheckout(checkoutId, testType, authToken);
  
  let orderId = null;
  if (confirmResult.data && confirmResult.data.data && confirmResult.data.data.ConfirmCheckout) {
    orderId = confirmResult.data.data.ConfirmCheckout.id;
  }

  // Step 10: Retrieve order (best effort)
  const retrieveResult = orderId ? retrieveOrder(orderId, testType, authToken) : { response: { status: 204 } };

  const completedSteps = {
    landingPage: landingPageResult && landingPageResult.status === 200,
    search: !!skuId,
    cart: !!checkoutId,
    passengers: passengerResult.response.status === 200,
    services: servicesResult.response.status === 200,
    seatMap: seatMapResult.response.status === 200 || seatMapResult.response.status === 204,
    addServices: addServicesResult.response.status === 200 || addServicesResult.response.status === 204,
    addSeats: addSeatsResult.response.status === 200 || addSeatsResult.response.status === 204,
    checkout: confirmResult.response && confirmResult.response.status === 200,
    retrieveOrder: retrieveResult.response && (retrieveResult.response.status === 200 || retrieveResult.response.status === 204)
  };

  const success = (
    completedSteps.landingPage &&
    completedSteps.search &&
    completedSteps.cart &&
    completedSteps.passengers &&
    completedSteps.services &&
    completedSteps.checkout &&
    completedSteps.retrieveOrder
  );
  
  return {
    success,
    scenario: scenario.name,
    checkoutId,
    orderId: orderId,
    completedSteps
  };
}
