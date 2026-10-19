// Configuration for UI performance tests
export const config = {
  // Base URLs
  APIM_URL: __ENV.APIM_URL || 'https://app-aai-perf-wapp-neu-01-fnfne0bdasg4a2an.northeurope-01.azurewebsites.net',
  TOKEN_URL: __ENV.TOKEN_URL || 'https://app-aai-perf-wapp-neu-01-fnfne0bdasg4a2an.northeurope-01.azurewebsites.net/api/auth/callback/simple-auth',
  CSRF_URL: __ENV.CSRF_URL || 'https://app-aai-perf-wapp-neu-01-fnfne0bdasg4a2an.northeurope-01.azurewebsites.net/api/auth/csrf',
  BASE_URL: __ENV.BASE_URL || 'https://app-aai-perf-wapp-neu-01-fnfne0bdasg4a2an.northeurope-01.azurewebsites.net/en',
  FLIGHT_URL: 'https://app-aai-perf-wapp-neu-01-fnfne0bdasg4a2an.northeurope-01.azurewebsites.net/api/flight-search',
  ONE_SHOT_CART_URL: __ENV.ONE_SHOT_CART_URL || 'https://app-aai-perf-wapp-neu-01-fnfne0bdasg4a2an.northeurope-01.azurewebsites.net/api/one-shot-cart',
  PASSENGERS_URL: __ENV.PASSENGERS_URL || 'https://app-aai-perf-wapp-neu-01-fnfne0bdasg4a2an.northeurope-01.azurewebsites.net/api/passengers',
  SERVICES_URL: __ENV.SERVICES_URL || 'https://app-aai-perf-wapp-neu-01-fnfne0bdasg4a2an.northeurope-01.azurewebsites.net/api/services',
  SEAT_MAP_URL: __ENV.SEAT_MAP_URL || 'https://app-aai-perf-wapp-neu-01-fnfne0bdasg4a2an.northeurope-01.azurewebsites.net/api/seat-map',
  ADD_SEAT_URL: __ENV.ADD_SERVICES_URL || 'https://app-aai-perf-wapp-neu-01-fnfne0bdasg4a2an.northeurope-01.azurewebsites.net/api/add-seat',
  ADD_SERVICES_URL: __ENV.SEAT_SERVICES_URL || 'https://app-aai-perf-wapp-neu-01-fnfne0bdasg4a2an.northeurope-01.azurewebsites.net/api/add-services',
  ORDER_CONFIRMATION_URL: __ENV.ORDER_CONFIRMATION_URL || 'https://app-aai-perf-wapp-neu-01-fnfne0bdasg4a2an.northeurope-01.azurewebsites.net/api/order-confirmation',
  ORDER_RETRIEVE_URL: __ENV.ORDER_RETRIEVE_URL || 'https://app-aai-perf-wapp-neu-01-fnfne0bdasg4a2an.northeurope-01.azurewebsites.net/api/order-retrieve',
  CART_RETRIEVE_URL: __ENV.ORDER_RETRIEVE_URL || 'https://app-aai-perf-wapp-neu-01-fnfne0bdasg4a2an.northeurope-01.azurewebsites.net/api/retrieve-cart',
  
  // Default flight search parameters
  DEFAULT_ORIGIN: __ENV.ORIGIN || 'HEL',
  DEFAULT_DESTINATION: __ENV.DEST || 'OUL',
  DEFAULT_TRIP_TYPE: __ENV.TRIP_TYPE || 'OW',
  DEFAULT_CABIN: __ENV.CABIN || 'Economy',
  
  // Test configuration
  DAYS_AHEAD: parseInt(__ENV.DAYS_AHEAD || '30'),
};

// Common headers
export const headers = {
  html: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  },
  graphql: (baseUrl, authToken) => {
    const h = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': baseUrl,
    };
    if (authToken) {
      h['Authorization'] = authToken;
      h['Cookie'] = authToken;
    }
    return h;
  },
};
