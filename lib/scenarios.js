// Test scenario configurations

export const smokeTestOptions = {
  scenarios: {
    smoke_tps_controlled: {
      executor: 'constant-arrival-rate',
      rate: 60,                    // 60 requests per minute = 1 TPS
      timeUnit: '1m',              // Per minute
      duration: '3m',
      preAllocatedVUs: 5,          // 5 VUs
      maxVUs: 5,                   // Cap at 5 VUs
    },
  },
  
  thresholds: {
    http_req_failed: ['rate<0.10'],
    http_req_duration: ['p(95)<30000'],
    checks: ['rate>0.95'],
    
    'http_req_duration{name:01_JWT_Token}': ['p(95)<2000'],
    'http_req_duration{name:02_Shop_Offer}': ['p(95)<15000'],
  },
  
  tags: {
    test_type: 'smoke',
    app: 'ui-performance',
  },
};

export const normalLoadTestOptions = {
  // Normal Load: 150-200 VUs, 30-60 min, Steady pattern
  stages: [
    { duration: '1m', target: 10 },   // Ramp up to 150 VUs
    //{ duration: '15m', target: 175 },  // Steady at 175 VUs
    //{ duration: '5m', target: 200 },  // Steady at 200 VUs
    //{ duration: '5m', target: 0 },     // Ramp down
  ],
  
  thresholds: {
    http_req_failed: ['rate<0.15'],
    http_req_duration: ['p(95)<8000'],
    http_req_duration: ['p(99)<12000'],
    checks: ['rate>0.85'],
    
    'http_req_duration{name:landing_page}': ['p(95)<4000'],
    'http_req_duration{name:get_offers}': ['p(95)<12000'],
    'http_req_duration{name:create_cart}': ['p(95)<15000'],
    'http_req_duration{name:update_passenger}': ['p(95)<15000'],
    'http_req_duration{name:seat_map}': ['p(95)<15000'],
    'http_req_duration{name:checkout_confirmation}': ['p(95)<18000'],
  },
  
  tags: {
    test_type: 'normal_load',
    app: 'ui-performance',
  },
};

export const peakLoadTestOptions = {
  // Peak Load: 200-250 VUs, 15-30 min, Ramp-up pattern
  stages: [
    { duration: '3m', target: 200 },   // Ramp up to 200 VUs
    { duration: '5m', target: 200 },   // Hold at 200 VUs
    { duration: '3m', target: 225 },   // Ramp to 225 VUs
    { duration: '5m', target: 225 },   // Hold at 225 VUs
    { duration: '3m', target: 250 },   // Ramp to peak 250 VUs
    { duration: '8m', target: 250 },   // Hold at peak
    { duration: '3m', target: 0 },     // Ramp down
  ],
  
  thresholds: {
    http_req_failed: ['rate<0.25'],
    http_req_duration: ['p(95)<15000'],
    http_req_duration: ['p(99)<25000'],
    checks: ['rate>0.75'],
    
    'http_req_duration{name:landing_page}': ['p(95)<8000'],
    'http_req_duration{name:get_offers}': ['p(95)<20000'],
    'http_req_duration{name:create_cart}': ['p(95)<25000'],
    'http_req_duration{name:update_passenger}': ['p(95)<25000'],
    'http_req_duration{name:seat_map}': ['p(95)<25000'],
    'http_req_duration{name:checkout_confirmation}': ['p(95)<30000'],
    
    http_reqs: ['rate>=1'],
    vus: ['value>0'],
  },
  
  tags: {
    test_type: 'peak_load',
    app: 'ui-performance',
  },
};

export const stressTestOptions = {
  // Stress Test: 250 -> 300+ VUs, 15-20 min, Breakpoint pattern
  stages: [
    { duration: '2m', target: 250 },   // Ramp to baseline
    { duration: '3m', target: 250 },   // Hold at baseline
    { duration: '2m', target: 275 },   // Increase load
    { duration: '3m', target: 275 },   // Hold
    { duration: '2m', target: 300 },   // Push to breakpoint
    { duration: '3m', target: 300 },   // Hold at breakpoint
    { duration: '2m', target: 350 },   // Beyond breakpoint
    { duration: '3m', target: 350 },   // Observe failure behavior
    { duration: '2m', target: 0 },     // Ramp down
  ],
  
  thresholds: {
    http_req_failed: ['rate<0.40'],
    http_req_duration: ['p(95)<20000'],
    http_req_duration: ['p(99)<35000'],
    checks: ['rate>0.60'],
    
    'http_req_duration{name:landing_page}': ['p(95)<10000'],
    'http_req_duration{name:get_offers}': ['p(95)<25000'],
    'http_req_duration{name:create_cart}': ['p(95)<30000'],
    'http_req_duration{name:update_passenger}': ['p(95)<30000'],
    'http_req_duration{name:seat_map}': ['p(95)<30000'],
    'http_req_duration{name:checkout_confirmation}': ['p(95)<35000'],
    
    http_reqs: ['rate>=1'],
    vus: ['value>0'],
  },
  
  tags: {
    test_type: 'stress',
    app: 'ui-performance',
  },
};

export const volumeTestOptions = {
  // Volume Test: Moderate VUs + Large payload, 30 min, Data-heavy pattern
  vus: 100,
  duration: '30m',
  
  thresholds: {
    http_req_failed: ['rate<0.20'],
    http_req_duration: ['p(95)<12000'],
    http_req_duration: ['p(99)<20000'],
    checks: ['rate>0.80'],
    
    'http_req_duration{name:landing_page}': ['p(95)<5000'],
    'http_req_duration{name:get_offers}': ['p(95)<15000'],
    'http_req_duration{name:create_cart}': ['p(95)<20000'],
    'http_req_duration{name:update_passenger}': ['p(95)<20000'],
    'http_req_duration{name:seat_map}': ['p(95)<20000'],
    'http_req_duration{name:checkout_confirmation}': ['p(95)<25000'],
    
    http_reqs: ['rate>=1'],
  },
  
  tags: {
    test_type: 'volume',
    app: 'ui-performance',
  },
};

export const enduranceTestOptions = {
  // Endurance Test: 150-200 VUs, 8 hours, Sustained pattern
  stages: [
    { duration: '10m', target: 150 },  // Ramp up
    { duration: '7h30m', target: 175 }, // Sustained load for 7.5 hours
    { duration: '20m', target: 0 },    // Ramp down
  ],
  
  thresholds: {
    http_req_failed: ['rate<0.10'],
    http_req_duration: ['p(95)<10000'],
    http_req_duration: ['p(99)<15000'],
    checks: ['rate>0.90'],
    
    'http_req_duration{name:landing_page}': ['p(95)<4000'],
    'http_req_duration{name:get_offers}': ['p(95)<12000'],
    'http_req_duration{name:create_cart}': ['p(95)<15000'],
    'http_req_duration{name:update_passenger}': ['p(95)<15000'],
    'http_req_duration{name:seat_map}': ['p(95)<15000'],
    'http_req_duration{name:checkout_confirmation}': ['p(95)<18000'],
    
    http_reqs: ['rate>=1'],
  },
  
  tags: {
    test_type: 'endurance',
    app: 'ui-performance',
  },
};

export const concurrencyTestOptions = {
  // Concurrency Test: 200+ VUs, Short bursts, High overlap pattern
  scenarios: {
    burst1: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 250 },
        { duration: '1m', target: 250 },
        { duration: '30s', target: 0 },
      ],
      startTime: '0s',
    },
    burst2: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 250 },
        { duration: '1m', target: 250 },
        { duration: '30s', target: 0 },
      ],
      startTime: '3m',
    },
    burst3: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 300 },
        { duration: '1m', target: 300 },
        { duration: '30s', target: 0 },
      ],
      startTime: '6m',
    },
    burst4: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 300 },
        { duration: '1m', target: 300 },
        { duration: '30s', target: 0 },
      ],
      startTime: '9m',
    },
  },
  
  thresholds: {
    http_req_failed: ['rate<0.30'],
    http_req_duration: ['p(95)<18000'],
    http_req_duration: ['p(99)<30000'],
    checks: ['rate>0.70'],
    
    'http_req_duration{name:landing_page}': ['p(95)<8000'],
    'http_req_duration{name:get_offers}': ['p(95)<20000'],
    'http_req_duration{name:create_cart}': ['p(95)<25000'],
    'http_req_duration{name:update_passenger}': ['p(95)<25000'],
    'http_req_duration{name:seat_map}': ['p(95)<25000'],
    'http_req_duration{name:checkout_confirmation}': ['p(95)<30000'],
    
    http_reqs: ['rate>=1'],
  },
  
  tags: {
    test_type: 'concurrency',
    app: 'ui-performance',
  },
};
