// GraphQL query for getting flight offers
export function getOffersQuery(origin, destination, departureDate, tripType = 'OW', cabin = 'Economy', returnDate = null, passengers = null) {
  const paxList = (passengers && passengers.length > 0)
    ? passengers
    : [{ passengerTypeCode: 'ADT' }];

  const passengersGql = paxList
    .map(p => `{ passengerTypeCode: ${p.passengerTypeCode} discountCode: "${p.passengerTypeCode}" }`)
    .join('\n              ');

  const tripsGql = (tripType === 'RT' && returnDate)
    ? `[
              {
                departureLocationCode: "${origin}"
                arrivalLocationCode: "${destination}"
                departureDateTime: "${departureDate}"
                isRequestedBound: true
              }
              {
                departureLocationCode: "${destination}"
                arrivalLocationCode: "${origin}"
                departureDateTime: "${returnDate}"
                isRequestedBound: true
              }
            ]`
    : `{
              departureLocationCode: "${origin}"
              arrivalLocationCode: "${destination}"
              departureDateTime: "${departureDate}"
              isRequestedBound: true
            }`;

  return {
    query: `
      query GetOffers {
        getOffers(
          OfferRequest: {
            tripType: ${tripType}
            trips: ${tripsGql}
            passengers: [
              ${passengersGql}
            ]
            fareTypes: "${cabin}"
          }
        ) {
          response {
            dataLists
            connections {
              departureLocationCode
              arrivalLocationCode
              flightProducts {
                ranking
                duration
                segments {
                  flightId
                  connectionTime
                }
                flightSKUs {
                  SKUId
                  SKUCode
                  SKUName
                  cabinClass
                  seatsLeft
                  restrictions
                  prices {
                    unitPrices {
                      paxID
                      prices {
                        baseAmount
                        totalAmount
                        curCode
                        totalTaxAmount
                        taxSummary {
                          amount
                          taxCode
                          taxName
                        }
                      }
                    }
                    totalPrices {
                      baseAmount
                      totalAmount
                      curCode
                      totalTaxAmount
                      taxSummary {
                        amount
                        taxCode
                        taxName
                      }
                    }
                  }
                  services {
                    services
                    flightId
                  }
                }
              }
            }
          }
        }
      }
    `
  };
}

// GraphQL mutation for creating cart
export function createCartMutation(skuId, airlineId = 'AY', agentId = '1234567890') {
  return {
    query: `
      mutation CreateCart($requestBody: CreateCart!) {
        createCart(requestBody: $requestBody) {
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
            }
            air {
              price {
                unitPrices {
                  travelerIds
                  prices {
                    base
                    total
                    taxes {
                      code
                      currencyCode
                      value
                    }
                    totalTaxes
                    fees {
                      value
                      currencyCode
                      nature
                    }
                    totalFees
                  }
                }
                totalPrices {
                  base
                  total
                  totalTaxes
                  fees {
                    value
                    currencyCode
                    nature
                  }
                  totalFees
                }
              }
              connections {
                originLocationCode
                destinationLocationCode
                flights {
                  id
                  cabin
                  bookingClass
                  statusCode
                  connectionTime
                  fareFamilyCode
                }
                duration
              }
            }
          }
          warnings {
            severity
            message
            code
          }
        }
      }
    `,
    variables: {
      requestBody: {
        skuIds: [skuId],
        airlineId: airlineId,
        agentId: agentId
      }
    }
  };
}

// GraphQL mutation for updating passenger information
export function updatePassengerMutation(checkoutId, passengers) {
  return {
    query: `
      mutation Mutation($passengerInput: AddPassengerInput!) {
        updatePassengerInformation(passengerInput: $passengerInput) {
          checkoutId
          passengers {
            id
            tid
            associatedPassengerId
            passengerTypeCode
            identityDetails {
              title
              firstName
              lastName
              nameType
              dateOfBirth
              gender
            }
            contactDetails {
              mobile {
                tid
                id
                isDefault
                category
                number
                countryCode
                purposes
                addresseeName
              }
              email {
                id
                tid
                isDefault
                category
                emailAddress
                purposes
              }
            }
          }
        }
      }
    `,
    variables: {
      passengerInput: {
        checkoutId: checkoutId,
        passengers: passengers
      }
    }
  };
}

// GraphQL query for getting seat map
export function getSeatMapQuery(checkoutId, flightId) {
  return {
    query: `
      query ExampleQuery($input: SeatMapInput!) {
        getSeatMap(input: $input) {
          warnings {
            code
            detail
          }
          data {
            flight {
              marketingAirlineCode
              marketingFlightNumber
              departure {
                locationCode
              }
              arrival {
                locationCode
              }
              aircraftCode
              aircraftConfigurationVersion
              cabin
            }
            seatmaps {
              computedCoordinates
              decks {
                deckType
                deckDimensions {
                  width
                  length
                  exitRowsX
                  startWingsX
                  endWingsX
                }
                firstAvailableSeat {
                  seatNumber
                  x
                }
                cheapestSeat {
                  cabin
                  seatNumber
                  travelers {
                    id
                    seatCharacteristicsCodes
                    seatAvailabilityStatus
                    prices {
                      base
                      total
                      currencyCode
                      totalTaxes
                      discount {
                        originalTotal
                        discountCode
                      }
                    }
                  }
                  coordinates {
                    x
                    y
                  }
                }
                facilities {
                  code
                  column
                  row
                  position
                }
                seats {
                  cabin
                  seatNumber
                  travelers {
                    id
                    seatAvailabilityStatus
                    seatCharacteristicsCodes
                    prices {
                      base
                      currencyCode
                      total
                      totalTaxes
                      discount {
                        discountCode
                        originalTotal
                      }
                    }
                  }
                  coordinates {
                    x
                    y
                  }
                }
              }
            }
          }
          dataLists
        }
      }
    `,
    variables: {
      input: {
        checkoutId: checkoutId,
        flightId: flightId
      }
    }
  };
}

// GraphQL mutation for confirming checkout
export function confirmCheckoutMutation(checkoutId) {
  return {
    query: `
      mutation ConfirmCheckout($checkoutID: String!) {
        ConfirmCheckout(CheckoutConfirmRequest: { checkoutID: $checkoutID }) {
          id
          creationDateTime
          expirationDateTime
          paymentTimeLimit
          air {
            price {
              totalPrices {
                base {
                  value
                  currencyCode
                }
                total {
                  value
                  currencyCode
                }
              }
            }
            connections {
              originLocationCode
              destinationLocationCode
              flights {
                id
                cabin
                bookingClass
                statusCode
              }
            }
          }
          passengers {
            passengerTypeCode
            id
            identityDetails {
              firstName
              lastName
              title
              dateOfBirth
            }
          }
        }
      }
    `,
    variables: {
      checkoutID: checkoutId
    }
  };
}

// GraphQL query for getting services catalogue
export function getServicesCatalogueQuery(checkoutId) {
  return {
    query: `
      query GetServicesCatalogue($checkoutId: String!) {
        getServicesCatalogue(checkoutId: $checkoutId) {
          connections {
            passengers {
              id
              type
              SKUs {
                id
                name
                serviceCategory
                code
                oncePerPassengerPerFlight
              }
              segments {
                flightId
                SKUs {
                  id
                  name
                  serviceCategory
                  code
                  oncePerPassengerPerFlight
                }
              }
            }
          }
        }
      }
    `,
    variables: {
      checkoutId: checkoutId
    }
  };
}

// GraphQL mutation for adding services
export function addServiceMutation(checkoutId, traveller) {
  return {
    query: `
      mutation AddService($input: ServicesInput!) {
        addService(input: $input) {
          data {
            id
          }
        }
      }
    `,
    variables: {
      input: {
        checkoutId: checkoutId,
        traveller: traveller
      }
    }
  };
}

// GraphQL mutation for adding seats
export function addSeatMutation(checkoutId, traveller) {
  return {
    query: `
      mutation AddSeat($input: SeatInput!) {
        addSeat(input: $input) {
          data {
            id
          }
        }
      }
    `,
    variables: {
      input: {
        checkoutId: checkoutId,
        traveller: traveller
      }
    }
  };
}

// GraphQL query for retrieving order details
export function retrieveOrderQuery(orderId) {
  return {
    query: `
      query RetrieveOrder($orderId: String!) {
        retrieveOrder(orderID: $orderId) {
          response {
            id
            pnrId
          }
          warnings {
            code
            message
          }
        }
      }
    `,
    variables: {
      orderId: orderId
    }
  };
}
