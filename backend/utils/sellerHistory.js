const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()
const { logInfo } = require('../../frontend/src/services/loggingService');
const getDaysOnMarket = require('./time')
const { MIN_LISTINGS_TO_FACTOR_IN_SELLER_LISTINGS, SMOOTHING_K, SELLER_FACTOR_MIN, SELLER_FACTOR_MAX, ROUNDING_DIGIT_DELTA, PERCENTAGE_CONVERTER } = require('./constants')

async function computeSellerDelta(sellerId) {
  const soldSellerListings = await prisma.listing.findMany({
    where: {
      ownerId: sellerId,
      sold: true
    },
    select: {
      condition: true,
      make: true,
      model: true,
      createdAt: true,
      soldAt: true
    }
  });

  if ((Array.isArray(soldSellerListings) && soldSellerListings.length < MIN_LISTINGS_TO_FACTOR_IN_SELLER_LISTINGS) || !(Array.isArray(soldSellerListings))) {
    logInfo('Not enough seller history')
    return 0.0;
  }

  const soldSellerListingStats = soldSellerListings.reduce((obj, listing) => {
    const key = `${listing.condition}|${listing.make}|${listing.model}`
    const daysOnMarket = getDaysOnMarket(listing);
    if (!obj[key]) {
      obj[key] = { count: 0, daysOnMarketSum: 0, condition: listing.condition, make: listing.make, model: listing.model }
    }
    obj[key].count++;
    obj[key].daysOnMarketSum += daysOnMarket;
    return obj;
  }, {})

  // For each unique condition/make/model listing, fetch market stats
  const weights = { weightedRatioSum: 0, totalWeights: 0 }
  
  for (const { count, daysOnMarketSum, condition, make, model } of Object.values(soldSellerListingStats)) {
    const soldMarketListings = await prisma.listing.findMany({
      where: {
        ownerId: {
          not: sellerId
        },
        condition,
        make,
        model,
        sold: true
      },
      select: {
        createdAt: true,
        soldAt: true
      }
    })

    if ((Array.isArray(soldMarketListings) && soldMarketListings.length === 0) || !(Array.isArray(soldSellerListings))) {
      continue;
    }

    const marketAvgDaysOnMarket = soldMarketListings.reduce((daysOnMarket, listing) => daysOnMarket + getDaysOnMarket(listing), 0) / soldMarketListings.length;

    const sellerAvgDaysOnMarket = daysOnMarketSum / count;

    // combat outliers
    const balancedSellerAvgDaysOnMarket = (sellerAvgDaysOnMarket * count + marketAvgDaysOnMarket * SMOOTHING_K) / (count + SMOOTHING_K)

    const timeSoldRatio = marketAvgDaysOnMarket / balancedSellerAvgDaysOnMarket;

    weights.weightedRatioSum += timeSoldRatio * count;
    weights.totalWeights += count;
  }

  const { weightedRatioSum, totalWeights } = weights;

  if (totalWeights === 0) {
    return 0.0;
  }

  const finalWeightedRatio = weightedRatioSum / totalWeights;
  const sellerMultiplier = Math.min(SELLER_FACTOR_MAX, Math.max(SELLER_FACTOR_MIN, finalWeightedRatio));

  const delta = parseFloat((sellerMultiplier - 1).toFixed(ROUNDING_DIGIT_DELTA));
  const percentage = Math.abs(delta) * PERCENTAGE_CONVERTER;

  logInfo(`Based on past seller history, listings should be marked ${percentage}% ${delta < 0 ? 'lower' : 'higher'}`)
  return delta
}

module.exports = computeSellerDelta