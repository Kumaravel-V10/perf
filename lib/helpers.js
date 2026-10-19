import { check } from 'k6';

// Generate future date for flight search
export function getFutureDate(daysAhead = 30) {
  const currentDate = new Date();
  const searchDate = new Date(currentDate.getTime() + (daysAhead * 24 * 60 * 60 * 1000));
  return searchDate.toISOString().split('T')[0]; // YYYY-MM-DD format
}

// Extract SKU ID from offers response
export function extractSkuId(offersData) {
  try {
    if (offersData.data && offersData.data.getOffers && offersData.data.getOffers.response && offersData.data.getOffers.response.connections) {
      const connections = offersData.data.getOffers.response.connections;
      if (connections.length > 0 && connections[0].flightProducts && connections[0].flightProducts.length > 0) {
        const flightProduct = connections[0].flightProducts[0];
        if (flightProduct.flightSKUs && flightProduct.flightSKUs.length > 0) {
          return flightProduct.flightSKUs[0].SKUId;
        }
      }
    }
  } catch (e) {
    // Silent error handling
  }
  return null;
}

// Extract checkout ID from cart response
export function extractCheckoutId(cartData) {
  if (cartData.data && cartData.data.createCart && cartData.data.createCart.response && cartData.data.createCart.response.checkoutId) {
    return cartData.data.createCart.response.checkoutId;
  } else if (cartData.response && cartData.response.checkoutId) {
    return cartData.response.checkoutId;
  } else if (cartData.checkoutId) {
    return cartData.checkoutId;
  }
  return null;
}

// Extract passenger IDs from cart response
export function extractPassengerIds(cartData) {
  let passengersArray = null;
  
  if (cartData.data && cartData.data.createCart && cartData.data.createCart.response && cartData.data.createCart.response.passengers) {
    passengersArray = cartData.data.createCart.response.passengers;
  } else if (cartData.response && cartData.response.passengers) {
    passengersArray = cartData.response.passengers;
  } else if (cartData.passengers) {
    passengersArray = cartData.passengers;
  }
  
  if (passengersArray && passengersArray.length > 0) {
    return passengersArray.map(passenger => ({
      passengerId: passenger.passengerId,
      passengerTypeCode: passenger.passengerTypeCode
    }));
  }
  
  return [];
}

// Extract flight ID from cart response
export function extractFlightId(cartData) {
  try {
    if (cartData.data && cartData.data.createCart && cartData.data.createCart.response && cartData.data.createCart.response.air && cartData.data.createCart.response.air.connections) {
      const connections = cartData.data.createCart.response.air.connections;
      if (connections.length > 0 && connections[0].flights && connections[0].flights.length > 0) {
        return connections[0].flights[0].id;
      }
    }

    if (cartData.data && cartData.data.createCart && cartData.data.createCart.dataList && cartData.data.createCart.dataList.flights) {
      const flightKeys = Object.keys(cartData.data.createCart.dataList.flights);
      if (flightKeys.length > 0) {
        return flightKeys[0];
      }
    }
  } catch (e) {
    // Silent error handling
  }
  return null;
}

// Safe JSON parse with error handling
export function safeJsonParse(body) {
  try {
    return JSON.parse(body);
  } catch (e) {
    return null;
  }
}

// Check if response is valid JSON
export function isValidJson(response) {
  try {
    JSON.parse(response.body);
    return true;
  } catch (e) {
    return false;
  }
}

// Check if GraphQL response has errors
export function hasGraphqlErrors(response) {
  try {
    const data = JSON.parse(response.body);
    return data.errors && data.errors.length > 0;
  } catch (e) {
    return true;
  }
}

// Common check for landing page
export function checkLandingPage(response, testType = 'smoke') {
  const thresholds = {
    smoke: 3000,
    load: 5000,
    stress: 10000,
    spike: 10000
  };
  
  return check(response, {
    'landing page status is 200': (r) => r.status === 200,
    [`landing page response time < ${thresholds[testType]}ms`]: (r) => r.timings.duration < thresholds[testType],
    'has content': (r) => r.body && r.body.length > 500,
    'content-type is html': (r) => String(r.headers['Content-Type'] || '').includes('text/html'),
    'no error page': (r) => !r.body || !r.body.toLowerCase().includes('something went wrong'),
  });
}

// Common check for GraphQL responses
export function checkGraphqlResponse(response, name, testType = 'smoke') {
  const thresholds = {
    smoke: 10000,
    load: 15000,
    stress: 25000,
    spike: 15000
  };
  
  const result = check(response, {
    [`${name} status is 200`]: (r) => r.status === 200,
    [`${name} response time < ${thresholds[testType]}ms`]: (r) => r.timings.duration < thresholds[testType],
    [`${name} is valid json`]: isValidJson,
    [`${name} has no errors`]: (r) => !hasGraphqlErrors(r),
  });
  
  return result;
}
