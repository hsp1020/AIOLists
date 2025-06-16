// src/utils/metadataFetcher.js
const axios = require('axios');
const { batchFetchPosters } = require('./posters');
const { METADATA_BATCH_SIZE } = require('../config');

// Import TMDB functions that use the built-in Bearer token
const { 
  batchConvertImdbToTmdbIds, 
  batchFetchTmdbMetadata
} = require('../integrations/tmdb');

const CINEMETA_BASE = 'https://v3-cinemeta.strem.io';
const BATCH_SIZE = METADATA_BATCH_SIZE || 200;

// Helper function to normalize IMDB IDs
function normalizeImdbId(id) {
  if (!id) return null;
  
  // If it's already a valid IMDB ID
  if (/^tt\d{7,8}$/.test(id)) {
    return id;
  }
  
  // If it's a numeric ID, add 'tt' prefix
  if (/^\d{7,8}$/.test(id)) {
    return `tt${id}`;
  }
  
  // If it's a TMDB ID format, we can't convert it here
  if (id.startsWith('tmdb:')) {
    return null;
  }
  
  return null;
}

// Fetch metadata from Cinemeta for a chunk of IMDB IDs
async function fetchCinemetaChunk(imdbIdChunk, type) {
  const CINEMETA_TIMEOUT = 5000; // Reduced timeout for faster failure
  
  try {
    const promises = imdbIdChunk.map(async (imdbId) => {
      try {
        // Add circuit breaker - fail fast if Cinemeta is slow
        const response = await Promise.race([
          axios.get(`${CINEMETA_BASE}/meta/${type}/${imdbId}.json`, {
            timeout: CINEMETA_TIMEOUT
          }),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Circuit breaker timeout')), CINEMETA_TIMEOUT + 1000)
          )
        ]);
        
        return { imdbId, data: response.data?.meta };
      } catch (error) {
        if (error.message.includes('Circuit breaker timeout')) {
          console.warn(`[METADATA PERF] Circuit breaker triggered for ${imdbId} (Cinemeta too slow)`);
        }
        return { imdbId, data: null };
      }
    });

    const results = await Promise.all(promises);
    const metadataMap = {};
    
    results.forEach(({ imdbId, data }) => {
      if (data) {
        metadataMap[imdbId] = data;
      }
    });

    return metadataMap;
  } catch (error) {
    console.error('Error fetching Cinemeta chunk:', error.message);
    return {};
  }
}

/**
 * Enrich items with metadata from the specified source
 * @param {Array} items - Array of items to enrich
 * @param {string} metadataSource - 'cinemeta' or 'tmdb'
 * @param {boolean} hasTmdbOAuth - Whether user has TMDB OAuth connected
 * @param {string} tmdbLanguage - TMDB language preference
 * @param {string} tmdbBearerToken - User's TMDB Bearer Token
 * @returns {Promise<Array>} Enriched items
 */
async function enrichItemsWithMetadata(items, metadataSource = 'cinemeta', hasTmdbOAuth = false, tmdbLanguage = 'en-US', tmdbBearerToken = null) {
  if (!items || items.length === 0) return [];
  
  // Skip enrichment if metadataSource is 'none' (used for lightweight checks during manifest generation)
  if (metadataSource === 'none') {
    return items;
  }
  
  const enrichStartTime = Date.now();
  
  // Use TMDB enrichment if requested and we have either OAuth or bearer token
  if (metadataSource === 'tmdb' && (hasTmdbOAuth || tmdbBearerToken)) {
    try {
      const result = await enrichItemsWithTMDB(items, tmdbLanguage, tmdbBearerToken);
      const enrichEndTime = Date.now();
      return result;
    } catch (error) {
      console.error('[DEBUG] TMDB enrichment failed:', error.message);
      const result = await enrichItemsWithCinemeta(items);
      const enrichEndTime = Date.now();
      return result;
    }
  }
  
  // Use Trakt enrichment if requested
  if (metadataSource === 'trakt') {
    try {
      const result = await enrichItemsWithTrakt(items);
      const enrichEndTime = Date.now();
      return result;
    } catch (error) {
      console.error('[DEBUG] Trakt enrichment failed:', error.message);
      const result = await enrichItemsWithCinemeta(items);
      const enrichEndTime = Date.now();
      return result;
    }
  }
  
  // Default to Cinemeta enrichment
  const result = await enrichItemsWithCinemeta(items);
  const enrichEndTime = Date.now();
  return result;
}

/**
 * Enrich items with TMDB metadata (requires OAuth)
 * @param {Array} items - Items to enrich
 * @param {string} language - TMDB language preference
 * @param {string} userBearerToken - User's TMDB Bearer Token
 * @returns {Promise<Array>} Enriched items
 */
async function enrichItemsWithTMDB(items, language = 'en-US', userBearerToken = null) {
  if (!items || items.length === 0) return [];
  
  const { batchConvertImdbToTmdbIds, batchFetchTmdbMetadata } = require('../integrations/tmdb');
  
  // Step 1: Extract and normalize IMDB IDs from items
  const itemsWithIds = [];
  items.forEach((item, index) => {
    const originalId = item.imdb_id || item.id;
    const normalizedId = normalizeImdbId(originalId);
    
    if (normalizedId) {
      itemsWithIds.push({
        originalIndex: index,
        imdbId: normalizedId,
        originalItem: item
      });
    } else if (originalId) {
      console.log(`[TMDB] Skipping item with invalid ID format: "${originalId}" (item: ${item.name || item.title || 'Unknown'})`);
    }
  });
  
  // If no valid IMDB IDs found, try to enrich with Cinemeta as fallback
  if (itemsWithIds.length === 0) {
    console.log('[TMDB] No valid IMDB IDs found for TMDB enrichment, falling back to Cinemeta');
    return await enrichItemsWithCinemeta(items);
  }
  
  try {
    const conversionStartTime = Date.now();
    const imdbIds = itemsWithIds.map(item => item.imdbId);
    const imdbToTmdbMap = await batchConvertImdbToTmdbIds(imdbIds, userBearerToken);
    
    // Step 2: Prepare items for TMDB metadata fetch
    const tmdbItems = [];
    itemsWithIds.forEach(({ imdbId, originalItem }) => {
      if (imdbToTmdbMap[imdbId]) {
        tmdbItems.push({
          imdbId: imdbId,
          tmdbId: imdbToTmdbMap[imdbId].tmdbId,
          type: imdbToTmdbMap[imdbId].type
        });
      }
    });
    
    // If no TMDB conversions found, try Cinemeta fallback for all items
    if (tmdbItems.length === 0) {
      console.log('[TMDB] No TMDB conversions found, falling back to Cinemeta');
      return await enrichItemsWithCinemeta(items);
    }
    
    const metadataStartTime = Date.now();
    const tmdbMetadataMap = await batchFetchTmdbMetadata(tmdbItems, language, userBearerToken);
    
    // Step 3: Create a result array preserving original order
    const enrichedItems = items.map((originalItem, index) => {
      // Find if this item had a valid IMDB ID
      const itemWithId = itemsWithIds.find(item => item.originalIndex === index);
      
      if (itemWithId) {
        const tmdbMetadata = tmdbMetadataMap[itemWithId.imdbId];
        
        if (tmdbMetadata) {
          // Get the TMDB ID for this item
          const tmdbConversion = imdbToTmdbMap[itemWithId.imdbId];
          const newId = tmdbConversion ? `tmdb:${tmdbConversion.tmdbId}` : originalItem.id;
          
          return {
            ...originalItem,
            ...tmdbMetadata,
            // Use tmdb: format for ID when enriched with TMDB
            id: newId,
            imdb_id: itemWithId.imdbId, // Use normalized IMDB ID
            type: originalItem.type
          };
        }
      }
      
      // If no TMDB metadata found, return original item
      return originalItem;
    });
    
    // Count how many items were successfully enriched
    const enrichedCount = enrichedItems.filter((item, index) => {
      const itemWithId = itemsWithIds.find(i => i.originalIndex === index);
      return itemWithId && tmdbMetadataMap[itemWithId.imdbId];
    }).length;
        
    // Count items with genre information after TMDB enrichment
    const itemsWithGenres = enrichedItems.filter(item => item.genres && item.genres.length > 0);
    
    // If less than 50% of items were enriched, fall back to Cinemeta for better genre coverage
    if (enrichedCount < items.length * 0.5) {
      console.log('[TMDB] Low enrichment success rate, falling back to Cinemeta for better coverage');
      return await enrichItemsWithCinemeta(items);
    }

    return enrichedItems;
    
  } catch (error) {
    console.error(`[DEBUG] Error in TMDB enrichment process:`, error.message);
    console.error(`[DEBUG] Error stack:`, error.stack);
    // Fall back to Cinemeta on any error
    console.log('[TMDB] TMDB enrichment failed, falling back to Cinemeta');
    return await enrichItemsWithCinemeta(items);
  }
}

/**
 * Enrich items with Cinemeta metadata
 * @param {Array} items - Items to enrich
 * @returns {Promise<Array>} Enriched items
 */
async function enrichItemsWithCinemeta(items) {
  if (!items || items.length === 0) return [];

  try {
    // Normalize and extract valid IMDB IDs
    const processedItems = items.map((item, index) => {
      const originalId = item.imdb_id || item.id;
      const normalizedId = normalizeImdbId(originalId);
      
      if (!normalizedId && originalId) {
        console.log(`[Cinemeta] Skipping item with invalid ID format: "${originalId}" (item: ${item.name || item.title || 'Unknown'})`);
      }
      
      return {
        originalIndex: index,
        imdbId: normalizedId,
        originalItem: item
      };
    });
    
    // Group items by type for efficient batching
    const movieItems = processedItems.filter(item => item.originalItem.type === 'movie' && item.imdbId);
    const seriesItems = processedItems.filter(item => item.originalItem.type === 'series' && item.imdbId);
    
    const movieIds = movieItems.map(item => item.imdbId);
    const seriesIds = seriesItems.map(item => item.imdbId);
    
    // Fetch metadata in batches
    const [movieMetadata, seriesMetadata] = await Promise.all([
      fetchCinemetaBatched(movieIds, 'movie'),
      fetchCinemetaBatched(seriesIds, 'series')
    ]);
    
    // Combine all metadata
    const allMetadata = { ...movieMetadata, ...seriesMetadata };
    
    // Merge metadata back into items, preserving original order
    const enrichedItems = items.map((originalItem, index) => {
      const processedItem = processedItems[index];
      
      if (processedItem.imdbId && allMetadata[processedItem.imdbId]) {
        const metadata = allMetadata[processedItem.imdbId];
        return {
          ...originalItem,
          ...metadata,
          // Preserve essential fields
          imdb_id: processedItem.imdbId, // Use normalized IMDB ID
          id: processedItem.imdbId,
          type: originalItem.type
        };
      }
      
      // Return original item if no metadata found
      return originalItem;
    });
    
    // Count successful enrichments
    const enrichedCount = enrichedItems.filter((item, index) => {
      const processedItem = processedItems[index];
      return processedItem.imdbId && allMetadata[processedItem.imdbId];
    }).length;
    
    console.log(`[Cinemeta] Enriched ${enrichedCount}/${items.length} items with Cinemeta metadata`);
    
    // Count items with genre information after Cinemeta enrichment
    const itemsWithGenres = enrichedItems.filter(item => item.genres && item.genres.length > 0);

    return enrichedItems;
    
  } catch (error) {
    console.error('Error enriching items with Cinemeta:', error.message);
    return items;
  }
}

async function fetchCinemetaBatched(imdbIds, type) {
  if (!imdbIds || imdbIds.length === 0) return {};
  
  const allMetadata = {};
  
  // Use smaller batch size for Cinemeta to avoid overwhelming it
  const CINEMETA_BATCH_SIZE = Math.min(BATCH_SIZE, 10); // Max 10 at a time for Cinemeta
  const CINEMETA_DELAY = 150; // Increased delay between batches
  

  
  // Process in batches to avoid overwhelming the API
  for (let i = 0; i < imdbIds.length; i += CINEMETA_BATCH_SIZE) {
    const batch = imdbIds.slice(i, i + CINEMETA_BATCH_SIZE);
    const batchStartTime = Date.now();
    
    try {
      const batchMetadata = await fetchCinemetaChunk(batch, type);
      Object.assign(allMetadata, batchMetadata);
      
      const batchEndTime = Date.now();
      // Adaptive delay based on response time
      if (i + CINEMETA_BATCH_SIZE < imdbIds.length) {
        const responseTime = batchEndTime - batchStartTime;
        const adaptiveDelay = responseTime > 2000 ? CINEMETA_DELAY * 2 : CINEMETA_DELAY;
        await new Promise(resolve => setTimeout(resolve, adaptiveDelay));
      }
    } catch (error) {
             console.error(`[METADATA PERF] Cinemeta batch failed, continuing with next batch:`, error.message);
       // Continue with next batch even if this one fails
     }
  }
  
  return allMetadata;
}

module.exports = {
  enrichItemsWithMetadata,
  enrichItemsWithTMDB,
  enrichItemsWithCinemeta
};
