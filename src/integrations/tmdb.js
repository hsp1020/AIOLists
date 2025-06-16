/**
 * TMDB Integration - OAuth Authentication for User Lists
 * 
 * TMDB API v3 authentication flow:
 * 1. Create a request token via /3/authentication/token/new
 * 2. User authorization through TMDB website  
 * 3. Create session ID via /3/authentication/session/new
 * 
 * This allows access to user's watchlists, favorites, and custom lists.
 */

const axios = require('axios');
const Cache = require('../utils/cache');
const { ITEMS_PER_PAGE, TMDB_REDIRECT_URI, TMDB_BEARER_TOKEN, TMDB_CONCURRENT_REQUESTS } = require('../config');

// Create a cache instance for TMDB data with 24 hour TTL
const tmdbCache = new Cache({ defaultTTL: 24 * 3600 * 1000 }); // 24 hours
const imdbToTmdbCache = new Cache({ defaultTTL: 7 * 24 * 3600 * 1000 }); // 7 days

const TMDB_BASE_URL_V3 = 'https://api.themoviedb.org/3';
const TMDB_REQUEST_TIMEOUT = 15000;

// TMDB Bearer Token - Read Access Token from environment variable (for server-side operations)
const DEFAULT_TMDB_BEARER_TOKEN = TMDB_BEARER_TOKEN;

/**
 * Create TMDB request token (Step 1)
 * @param {string} userBearerToken - User's TMDB Read Access Token
 * @returns {Promise<Object>} Request token data
 */
async function createTmdbRequestToken(userBearerToken) {
  if (!userBearerToken) {
    throw new Error('TMDB Bearer Token is required');
  }
  
  try {
    const response = await axios.get(`${TMDB_BASE_URL_V3}/authentication/token/new`, {
      headers: {
        'accept': 'application/json',
        'Authorization': `Bearer ${userBearerToken}`
      },
      timeout: TMDB_REQUEST_TIMEOUT
    });

    if (response.data && response.data.success) {
      const baseAuthUrl = `https://www.themoviedb.org/authenticate/${response.data.request_token}`;
      const authUrl = TMDB_REDIRECT_URI ? 
        `${baseAuthUrl}?redirect_to=${encodeURIComponent(TMDB_REDIRECT_URI)}` : 
        baseAuthUrl;
      
      return {
        success: true,
        requestToken: response.data.request_token,
        expiresAt: response.data.expires_at,
        authUrl: authUrl
      };
    }
    throw new Error('Failed to create TMDB request token');
  } catch (error) {
    console.error('Error creating TMDB request token:', error.message);
    throw new Error(`Failed to create TMDB request token: ${error.message}`);
  }
}

/**
 * Create TMDB session ID from approved request token (Step 3)
 * @param {string} requestToken - Approved request token from TMDB
 * @param {string} userBearerToken - User's TMDB Read Access Token
 * @returns {Promise<Object>} Session data
 */
async function createTmdbSession(requestToken, userBearerToken) {
  if (!userBearerToken) {
    throw new Error('TMDB Bearer Token is required');
  }
  
  try {
    const response = await axios.post(`${TMDB_BASE_URL_V3}/authentication/session/new`, {
      request_token: requestToken
    }, {
      headers: {
        'accept': 'application/json',
        'content-type': 'application/json',
        'Authorization': `Bearer ${userBearerToken}`
      },
      timeout: TMDB_REQUEST_TIMEOUT
    });

    if (response.data && response.data.success) {
      return {
        success: true,
        sessionId: response.data.session_id
      };
    }
    throw new Error('Failed to create TMDB session');
  } catch (error) {
    console.error('Error creating TMDB session:', error.message);
    throw new Error(`Failed to create TMDB session: ${error.message}`);
  }
}

/**
 * Get user account details using session ID
 * @param {string} sessionId - TMDB session ID
 * @param {string} userBearerToken - User's TMDB Read Access Token
 * @returns {Promise<Object>} Account data
 */
async function getTmdbAccountDetails(sessionId, userBearerToken) {
  if (!userBearerToken) {
    throw new Error('TMDB Bearer Token is required');
  }
  
  try {
    const response = await axios.get(`${TMDB_BASE_URL_V3}/account`, {
      params: {
        session_id: sessionId
      },
      headers: {
        'accept': 'application/json',
        'Authorization': `Bearer ${userBearerToken}`
      },
      timeout: TMDB_REQUEST_TIMEOUT
    });

    return response.data;
  } catch (error) {
    console.error('Error getting TMDB account details:', error.message);
    throw new Error(`Failed to get TMDB account details: ${error.message}`);
  }
}

/**
 * Get TMDB OAuth authorization URL
 * @param {string} userBearerToken - User's TMDB Read Access Token
 * @returns {Promise<Object>} Object with request token and auth URL
 */
async function getTmdbAuthUrl(userBearerToken) {
  return await createTmdbRequestToken(userBearerToken);
}

/**
 * Authenticate with TMDB using request token
 * @param {string} requestToken - Request token from TMDB OAuth flow
 * @param {string} userBearerToken - User's TMDB Read Access Token
 * @returns {Promise<Object>} Authentication result with session ID and account details
 */
async function authenticateTmdb(requestToken, userBearerToken) {
  const sessionData = await createTmdbSession(requestToken, userBearerToken);
  const accountData = await getTmdbAccountDetails(sessionData.sessionId, userBearerToken);
  
  return {
    sessionId: sessionData.sessionId,
    accountId: accountData.id,
    username: accountData.username,
    name: accountData.name
  };
}

/**
 * Fetch user's TMDB lists
 * @param {Object} userConfig - User configuration
 * @returns {Promise<Object>} Lists data
 */
async function fetchTmdbLists(userConfig) {
  if (!userConfig.tmdbSessionId || !userConfig.tmdbAccountId) {
    return {
      isConnected: false,
      lists: [],
      addons: [],
      message: 'TMDB not connected. Connect to access your watchlists and favorites.'
    };
  }

  try {
    // Fetch user's created lists
    const listsResponse = await axios.get(`${TMDB_BASE_URL_V3}/account/${userConfig.tmdbAccountId}/lists`, {
      params: {
        session_id: userConfig.tmdbSessionId,
        page: 1
      },
      headers: {
        'accept': 'application/json',
        'Authorization': `Bearer ${userConfig.tmdbBearerToken || DEFAULT_TMDB_BEARER_TOKEN}`
      },
      timeout: TMDB_REQUEST_TIMEOUT
    });

    const userLists = listsResponse.data?.results || [];
    
    // Add special lists (watchlist, favorites)
    const specialLists = [
      {
        id: 'tmdb_watchlist',
        name: 'TMDB Watchlist',
        isTmdbWatchlist: true,
        description: 'Your TMDB watchlist'
      },
      {
        id: 'tmdb_favorites',
        name: 'TMDB Favorites', 
        isTmdbFavorites: true,
        description: 'Your TMDB favorites'
      }
    ];

    const allLists = [
      ...specialLists,
      ...userLists.map(list => ({
        id: `tmdb_list_${list.id}`,
        name: list.name,
        description: list.description,
        tmdbListId: list.id,
        isTmdbList: true,
        itemCount: list.item_count
      }))
    ];

    return {
      isConnected: true,
      lists: allLists,
      addons: [],
      message: `TMDB connected. Found ${allLists.length} lists.`
    };

  } catch (error) {
    console.error('Error fetching TMDB lists:', error.message);
    return {
      isConnected: true,
      lists: [],
      addons: [],
      message: 'TMDB connected but failed to fetch lists. Please try again.'
    };
  }
}

/**
 * Fetch items from a TMDB list
 * @param {string} listId - List identifier
 * @param {Object} userConfig - User configuration
 * @param {number} skip - Number of items to skip
 * @param {string} sortBy - Sort option
 * @param {string} sortOrder - Sort order
 * @param {string} genre - Genre filter
 * @returns {Promise<Object>} List content
 */
async function fetchTmdbListItems(listId, userConfig, skip = 0, sortBy = 'created_at', sortOrder = 'desc', genre = null) {
  if (!userConfig.tmdbSessionId || !userConfig.tmdbAccountId) {
    return null;
  }

  const limit = ITEMS_PER_PAGE;
  const page = Math.floor(skip / limit) + 1;

  try {
    let apiUrl;
    let params = {
      session_id: userConfig.tmdbSessionId,
      page: page,
      language: userConfig.tmdbLanguage || 'en-US'
    };

    const headers = {
      'accept': 'application/json',
      'Authorization': `Bearer ${userConfig.tmdbBearerToken || DEFAULT_TMDB_BEARER_TOKEN}`
    };

    if (listId === 'tmdb_watchlist') {
      // Fetch watchlist items (both movies and TV shows)
      const [moviesResponse, tvResponse] = await Promise.all([
        axios.get(`${TMDB_BASE_URL_V3}/account/${userConfig.tmdbAccountId}/watchlist/movies`, {
          headers,
          params,
          timeout: TMDB_REQUEST_TIMEOUT
        }),
        axios.get(`${TMDB_BASE_URL_V3}/account/${userConfig.tmdbAccountId}/watchlist/tv`, {
          headers,
          params,
          timeout: TMDB_REQUEST_TIMEOUT
        })
      ]);

      const movies = moviesResponse.data?.results || [];
      const tvShows = tvResponse.data?.results || [];
      
      const allItems = [
        ...movies.map(item => ({ ...item, media_type: 'movie' })),
        ...tvShows.map(item => ({ ...item, media_type: 'tv' }))
      ];

      return processListItems(allItems, userConfig, genre);
      
    } else if (listId === 'tmdb_favorites') {
      // Fetch favorites (both movies and TV shows)
      const [moviesResponse, tvResponse] = await Promise.all([
        axios.get(`${TMDB_BASE_URL_V3}/account/${userConfig.tmdbAccountId}/favorite/movies`, {
          headers,
          params,
          timeout: TMDB_REQUEST_TIMEOUT
        }),
        axios.get(`${TMDB_BASE_URL_V3}/account/${userConfig.tmdbAccountId}/favorite/tv`, {
          headers,
          params,
          timeout: TMDB_REQUEST_TIMEOUT
        })
      ]);

      const movies = moviesResponse.data?.results || [];
      const tvShows = tvResponse.data?.results || [];
      
      const allItems = [
        ...movies.map(item => ({ ...item, media_type: 'movie' })),
        ...tvShows.map(item => ({ ...item, media_type: 'tv' }))
      ];

      return processListItems(allItems, userConfig, genre);
      
    } else if (listId.startsWith('tmdb_list_')) {
      // Fetch custom list
      const tmdbListId = listId.replace('tmdb_list_', '');
      apiUrl = `${TMDB_BASE_URL_V3}/list/${tmdbListId}`;
      
      const response = await axios.get(apiUrl, {
        headers,
        params,
        timeout: TMDB_REQUEST_TIMEOUT
      });

      const items = response.data?.items || [];
      return processListItems(items, userConfig, genre);
      
    } else {
      console.warn(`Unknown TMDB list type: ${listId}`);
      return null;
    }

  } catch (error) {
    console.error(`Error fetching TMDB list ${listId}:`, error.message);
    return null;
  }
}

/**
 * Process and enrich list items
 * @param {Array} items - Raw TMDB items
 * @param {Object} userConfig - User configuration
 * @param {string} genre - Genre filter
 * @returns {Promise<Object>} Processed items
 */
async function processListItems(items, userConfig, genre) {
  if (!items || items.length === 0) {
    return { allItems: [], hasMovies: false, hasShows: false };
  }

  let hasMovies = false;
  let hasShows = false;

  // Step 1: Process basic item data and determine types
  const processedItems = items.map(item => {
    // Determine if it's a movie or TV show
    const isMovie = item.media_type === 'movie' || 
                    (item.title && !item.name) || 
                    (item.release_date && !item.first_air_date);
    const type = isMovie ? 'movie' : 'series';
    
    if (type === 'movie') hasMovies = true;
    if (type === 'series') hasShows = true;

    return {
      tmdb_id: item.id,
      type: type,
      title: isMovie ? item.title : item.name,
      name: isMovie ? item.title : item.name,
      overview: item.overview,
      description: item.overview,
      year: isMovie ? 
        (item.release_date ? item.release_date.split('-')[0] : undefined) :
        (item.first_air_date ? item.first_air_date.split('-')[0] : undefined),
      release_date: item.release_date,
      first_air_date: item.first_air_date,
      poster: item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : undefined,
      background: item.backdrop_path ? `https://image.tmdb.org/t/p/w1280${item.backdrop_path}` : undefined,
      poster_path: item.poster_path,
      backdrop_path: item.backdrop_path,
      vote_average: item.vote_average,
      vote_count: item.vote_count,
      popularity: item.popularity,
      genre_ids: item.genre_ids,
      genres: [], // Will be populated later if needed
      imdbRating: item.vote_average ? item.vote_average.toFixed(1) : undefined
    };
  });

  // Step 2: Get IMDB IDs for the items (required for Stremio compatibility)
  const itemsWithTmdbIds = processedItems.filter(item => item.tmdb_id);
  
  if (itemsWithTmdbIds.length > 0) {
    // Fetch external IDs with concurrency control to avoid overwhelming the API
    const CONCURRENCY_LIMIT = TMDB_CONCURRENT_REQUESTS || 5;
  
    
    const chunks = [];
    for (let i = 0; i < itemsWithTmdbIds.length; i += CONCURRENCY_LIMIT) {
      chunks.push(itemsWithTmdbIds.slice(i, i + CONCURRENCY_LIMIT));
    }

    const externalIdsResults = [];
    for (const chunk of chunks) {
      const chunkPromises = chunk.map(async (item) => {
        try {
          const endpoint = item.type === 'movie' ? 'movie' : 'tv';
          const response = await axios.get(`${TMDB_BASE_URL_V3}/${endpoint}/${item.tmdb_id}/external_ids`, {
            headers: {
              'accept': 'application/json',
              'Authorization': `Bearer ${userConfig.tmdbBearerToken || DEFAULT_TMDB_BEARER_TOKEN}`
            },
            timeout: TMDB_REQUEST_TIMEOUT
          });
          
          const externalIds = response.data;
          return {
            tmdb_id: item.tmdb_id,
            imdb_id: externalIds.imdb_id
          };
        } catch (error) {
          console.error(`Error fetching external IDs for TMDB ID ${item.tmdb_id}:`, error.message);
          return {
            tmdb_id: item.tmdb_id,
            imdb_id: null
          };
        }
      });

      const chunkResults = await Promise.all(chunkPromises);
      externalIdsResults.push(...chunkResults);
      
      // Small delay between chunks to respect API rate limits
      if (chunk !== chunks[chunks.length - 1]) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    
    // Create a map for quick lookup
    const externalIdsMap = {};
    externalIdsResults.forEach(result => {
      externalIdsMap[result.tmdb_id] = result.imdb_id;
    });

    // Step 3: Add IMDB IDs to processed items
    processedItems.forEach(item => {
      if (item.tmdb_id && externalIdsMap[item.tmdb_id]) {
        item.imdb_id = externalIdsMap[item.tmdb_id];
        item.id = item.imdb_id;
      } else {
        // Use TMDB ID as fallback if no IMDB ID is available
        item.id = `tmdb:${item.tmdb_id}`;
      }
    });
  }

  // Step 4: Filter out items without any valid ID
  const validItems = processedItems.filter(item => item.imdb_id || item.tmdb_id);

  // Step 5: Apply genre filter if specified (basic filtering on genre_ids for now)
  let finalItems = validItems;
  if (genre && genre !== 'All' && finalItems.length > 0) {
    // For TMDB, we would need to fetch genre names from genre_ids
    // For now, we'll skip genre filtering on TMDB items
    // This could be enhanced later by mapping genre_ids to genre names
    console.log(`Genre filtering for TMDB lists not yet implemented. Returning all items.`);
  }

  return {
    allItems: finalItems,
    hasMovies,
    hasShows
  };
}

/**
 * Test TMDB API connectivity using user's Bearer token
 * @param {string} userBearerToken - User's TMDB Read Access Token
 * @returns {Promise<boolean>} Whether the API is accessible
 */
async function validateTMDBKey(userBearerToken) {
  if (!userBearerToken) {
    return false;
  }
  
  try {
    const response = await axios.get(`${TMDB_BASE_URL_V3}/configuration`, {
      headers: {
        'accept': 'application/json',
        'Authorization': `Bearer ${userBearerToken}`
      },
      timeout: 10000
    });
    
    return response.status === 200 && response.data;
  } catch (error) {
    console.error('TMDB API connectivity test error:', error.message);
    return false;
  }
}

/**
 * Convert IMDB ID to TMDB ID using TMDB's find endpoint with user Bearer token
 * @param {string} imdbId - IMDB ID (e.g., "tt1234567")
 * @param {string} userBearerToken - User's TMDB Read Access Token
 * @returns {Promise<Object|null>} Object with tmdbId and type, or null if not found
 */
async function convertImdbToTmdbId(imdbId, userBearerToken = DEFAULT_TMDB_BEARER_TOKEN) {
  if (!imdbId || !imdbId.match(/^tt\d+$/)) {
    return null;
  }
  
  const cacheKey = `imdb_to_tmdb_${imdbId}`;
  const cachedResult = imdbToTmdbCache.get(cacheKey);
  if (cachedResult) {
    return cachedResult === 'null' ? null : cachedResult;
  }
  
  try {
    const response = await axios.get(`${TMDB_BASE_URL_V3}/find/${imdbId}`, {
      params: {
        external_source: 'imdb_id'
      },
      headers: {
        'accept': 'application/json',
        'Authorization': `Bearer ${userBearerToken}`
      },
      timeout: TMDB_REQUEST_TIMEOUT
    });
    
    const data = response.data;
    let result = null;
    
    // Check for movie first, then TV show
    if (data.movie_results && data.movie_results.length > 0) {
      result = {
        tmdbId: data.movie_results[0].id,
        type: 'movie'
      };
    } else if (data.tv_results && data.tv_results.length > 0) {
      result = {
        tmdbId: data.tv_results[0].id,
        type: 'series'
      };
    }
    
    // Cache the result (or null if not found)
    imdbToTmdbCache.set(cacheKey, result || 'null');
    return result;
    
  } catch (error) {
    console.error(`Error converting IMDB ID ${imdbId} to TMDB ID:`, error.message);
    // Cache negative result for a shorter time
    imdbToTmdbCache.set(cacheKey, 'null', 60 * 60 * 1000); // 1 hour
    return null;
  }
}

/**
 * Batch convert multiple IMDB IDs to TMDB IDs using user Bearer token
 * @param {string[]} imdbIds - Array of IMDB IDs
 * @param {string} userBearerToken - User's TMDB Read Access Token
 * @returns {Promise<Object>} Map of IMDB ID to TMDB conversion result
 */
async function batchConvertImdbToTmdbIds(imdbIds, userBearerToken = DEFAULT_TMDB_BEARER_TOKEN) {
  if (!imdbIds?.length) return {};
  
  const results = {};
  const uncachedIds = [];
  
  // Check cache first
  for (const imdbId of imdbIds) {
    const cacheKey = `imdb_to_tmdb_${imdbId}`;
    const cachedResult = imdbToTmdbCache.get(cacheKey);
    if (cachedResult) {
      results[imdbId] = cachedResult === 'null' ? null : cachedResult;
    } else {
      uncachedIds.push(imdbId);
    }
  }
  
  if (uncachedIds.length === 0) return results;
  
  // Process uncached IDs in parallel with concurrency control
  const CONCURRENCY_LIMIT = TMDB_CONCURRENT_REQUESTS || 15; // Use config value for consistency, optimized for conversion
  
  const processChunk = async (chunk) => {
    const chunkPromises = chunk.map(async (imdbId) => {
      try {
        const result = await convertImdbToTmdbId(imdbId, userBearerToken);
        return { imdbId, result };
      } catch (error) {
        console.error(`Error converting IMDB ID ${imdbId}:`, error.message);
        return { imdbId, result: null };
      }
    });
    
    return Promise.all(chunkPromises);
  };
  
  // Split into chunks and process them
  const chunks = [];
  for (let i = 0; i < uncachedIds.length; i += CONCURRENCY_LIMIT) {
    chunks.push(uncachedIds.slice(i, i + CONCURRENCY_LIMIT));
  }
  
  for (const chunk of chunks) {
    const chunkResults = await processChunk(chunk);
    chunkResults.forEach(({ imdbId, result }) => {
      results[imdbId] = result;
    });
    
    // Small delay between chunks to be respectful to the API
    if (chunk !== chunks[chunks.length - 1]) {
      await new Promise(resolve => setTimeout(resolve, 100)); // Reduced from 200ms to 100ms
    }
  }
  
  return results;
}

/**
 * Fetch metadata from TMDB for a single item using user Bearer token
 * @param {number} tmdbId - TMDB ID
 * @param {string} type - 'movie' or 'series'
 * @param {string} language - Language code (e.g., 'en-US')
 * @param {string} userBearerToken - User's TMDB Read Access Token
 * @returns {Promise<Object|null>} TMDB metadata or null
 */
async function fetchTmdbMetadata(tmdbId, type, language = 'en-US', userBearerToken = DEFAULT_TMDB_BEARER_TOKEN) {
  if (!tmdbId) return null;
  
  const cacheKey = `tmdb_${type}_${tmdbId}_${language}`;
  const cachedResult = tmdbCache.get(cacheKey);
  if (cachedResult) {
    return cachedResult === 'null' ? null : cachedResult;
  }
  
  try {
    const endpoint = type === 'movie' ? 'movie' : 'tv';
    const response = await axios.get(`${TMDB_BASE_URL_V3}/${endpoint}/${tmdbId}`, {
      params: {
        language: language,
        append_to_response: 'credits,videos,external_ids,images'
      },
      headers: {
        'accept': 'application/json',
        'Authorization': `Bearer ${userBearerToken || DEFAULT_TMDB_BEARER_TOKEN}`
      },
      timeout: TMDB_REQUEST_TIMEOUT
    });
    
    const data = response.data;
    
    // For series, also fetch season and episode data
    if (type === 'series' && data.number_of_seasons) {
      try {
    
        
        // Fetch episode data for all seasons (no limit)
        const totalSeasons = data.number_of_seasons;
        const seasonPromises = [];
        
        for (let seasonNum = 0; seasonNum <= totalSeasons; seasonNum++) {
          // Skip season 0 if it has no episodes or if there are too many seasons
          if (seasonNum === 0 && data.number_of_seasons > 5) continue;
          
          seasonPromises.push(
            axios.get(`${TMDB_BASE_URL_V3}/tv/${tmdbId}/season/${seasonNum}`, {
              params: { language: language },
              headers: {
                'accept': 'application/json',
                'Authorization': `Bearer ${userBearerToken || DEFAULT_TMDB_BEARER_TOKEN}`
              },
              timeout: TMDB_REQUEST_TIMEOUT
            }).catch(error => {
              console.warn(`[TMDB] Failed to fetch season ${seasonNum} for series ${tmdbId}:`, error.message);
              return null;
            })
          );
        }
        
        const seasonResponses = await Promise.all(seasonPromises);
        const validSeasons = seasonResponses.filter(response => response && response.data);
        
        // Add episode data to the main data object
        data.seasons_with_episodes = validSeasons.map(response => response.data);
        

      } catch (error) {
        console.warn(`[TMDB] Failed to fetch episode data for series ${tmdbId}:`, error.message);
        // Continue without episode data if fetching fails
      }
    }

    // Convert TMDB format to Stremio-compatible format
    const stremioMeta = convertTmdbToStremioFormat(data, type);
    
    tmdbCache.set(cacheKey, stremioMeta);
    return stremioMeta;
    
  } catch (error) {
    console.error(`Error fetching TMDB metadata for ${type} ${tmdbId}:`, error.message);
    tmdbCache.set(cacheKey, 'null', 60 * 60 * 1000); // Cache error for 1 hour
    return null;
  }
}

/**
 * Convert TMDB data format to Stremio-compatible format
 * @param {Object} tmdbData - Raw TMDB data
 * @param {string} type - 'movie' or 'series'
 * @returns {Object} Stremio-compatible metadata
 */
function convertTmdbToStremioFormat(tmdbData, type) {
  const isMovie = type === 'movie';
  
  // Use tmdb: format for ID, preserve IMDB ID separately
  const tmdbId = `tmdb:${tmdbData.id}`;
  const imdbId = tmdbData.external_ids?.imdb_id || tmdbData.imdb_id;
  
  // Extract cast and crew
  const cast = tmdbData.credits?.cast?.slice(0, 10).map(person => person.name) || [];
  const crew = tmdbData.credits?.crew || [];
  const directors = crew.filter(person => person.job === 'Director').map(person => person.name);
  const writers = crew.filter(person => 
    person.job === 'Writer' || person.job === 'Screenplay' || person.job === 'Story'
  ).map(person => person.name);
  
  // Extract and format trailers
  const trailerVideos = tmdbData.videos?.results?.filter(video => 
    video.type === 'Trailer' && video.site === 'YouTube'
  ) || [];
  
  const trailers = trailerVideos.map(video => `https://www.youtube.com/watch?v=${video.key}`);
  const trailerStreams = trailerVideos.map(video => ({
    title: tmdbData.title || tmdbData.name,
    ytId: video.key
  }));
  
  // Format release date
  const releaseDate = isMovie ? tmdbData.release_date : tmdbData.first_air_date;
  const releaseYear = releaseDate ? releaseDate.split('-')[0] : undefined;
  const releasedFormatted = releaseDate ? `${releaseDate}T00:00:00.000Z` : undefined;

  // Format year and releaseInfo for series to match Cinemeta format
  let formattedYear = releaseYear;
  let formattedReleaseInfo = releaseYear;
  
  if (!isMovie && releaseYear) {
    // For series, check if it's still ongoing or ended
    const lastAirDate = tmdbData.last_air_date;
    const status = tmdbData.status;
    
    if (status === 'Returning Series' || status === 'In Production' || !lastAirDate) {
      // Ongoing series - format as "1999-"
      formattedYear = `${releaseYear}-`;
      formattedReleaseInfo = `${releaseYear}-`;
    } else if (lastAirDate && lastAirDate !== releaseDate) {
      // Ended series - format as "1999-2009"
      const endYear = lastAirDate.split('-')[0];
      if (endYear !== releaseYear) {
        formattedYear = `${releaseYear}-${endYear}`;
        formattedReleaseInfo = `${releaseYear}-${endYear}`;
      }
    }
  }

  // Get logos from TMDB images
  let logo = undefined;
  if (tmdbData.images?.logos && tmdbData.images.logos.length > 0) {
    // Prefer English logos or the first available
    const englishLogo = tmdbData.images.logos.find(img => img.iso_639_1 === 'en') || tmdbData.images.logos[0];
    logo = `https://image.tmdb.org/t/p/original${englishLogo.file_path}`;
  }

  // Build detailed cast information for app_extras
  const detailedCast = tmdbData.credits?.cast?.slice(0, 10).map(person => ({
    name: person.name,
    character: person.character || undefined,
    photo: person.profile_path ? `https://image.tmdb.org/t/p/w276_and_h350_face${person.profile_path}` : undefined
  })) || [];


  // Process episodes for series
  let videos = [];
  if (!isMovie && tmdbData.seasons_with_episodes) {

    
    tmdbData.seasons_with_episodes.forEach(season => {
      if (season.episodes && Array.isArray(season.episodes)) {
        season.episodes.forEach(episode => {
          // Use IMDB ID for episode IDs if available, otherwise use TMDB format
          const episodeId = imdbId && imdbId.startsWith('tt') ? 
            `${imdbId}:${season.season_number}:${episode.episode_number}` :
            `${tmdbId}:${season.season_number}:${episode.episode_number}`;
          
          // Format air date if available
          let airDateFormatted = null;
          if (episode.air_date) {
            airDateFormatted = `${episode.air_date}T00:00:00.001Z`;
          }
          
          videos.push({
            id: episodeId,
            name: episode.name || `Episode ${episode.episode_number}`,
            season: season.season_number,
            number: episode.episode_number,
            episode: episode.episode_number,
            thumbnail: episode.still_path ? `https://image.tmdb.org/t/p/w500${episode.still_path}` : undefined,
            overview: episode.overview || "",
            description: episode.overview || "",
            rating: episode.vote_average ? parseFloat(episode.vote_average).toFixed(1) : "0",
            firstAired: airDateFormatted,
            released: airDateFormatted
          });
        });
      }
    });
    
    // Sort episodes by season and episode number
    videos.sort((a, b) => {
      if (a.season !== b.season) {
        return a.season - b.season;
      }
      return a.episode - b.episode;
    });
    

  }

  // Build comprehensive metadata object similar to Cinemeta structure
  const metadata = {
    id: tmdbId,
    imdb_id: imdbId,
    type: type,
    name: isMovie ? tmdbData.title : tmdbData.name,
    description: tmdbData.overview || "",
    poster: tmdbData.poster_path ? `https://image.tmdb.org/t/p/w500${tmdbData.poster_path}` : undefined,
    background: tmdbData.backdrop_path ? `https://image.tmdb.org/t/p/w1280${tmdbData.backdrop_path}` : undefined,
    releaseInfo: formattedReleaseInfo,
    year: formattedYear,
    released: releasedFormatted,
    runtime: isMovie ? 
      (tmdbData.runtime ? `${tmdbData.runtime} min` : undefined) :
      (tmdbData.episode_run_time?.[0] ? `${tmdbData.episode_run_time[0]} min` : undefined),
    genres: tmdbData.genres?.map(genre => genre.name) || [],
    genre: tmdbData.genres?.map(genre => genre.name) || [], // Cinemeta uses 'genre' as well
    cast: cast.length > 0 ? cast : undefined,
    director: directors.length > 0 ? directors : undefined,
    writer: writers.length > 0 ? writers : undefined,
    imdbRating: tmdbData.vote_average ? tmdbData.vote_average.toFixed(1) : undefined,
    country: isMovie ? 
      (tmdbData.production_countries?.map(country => country.name)?.[0] || 'Unknown') :
      (tmdbData.origin_country?.[0] || 'Unknown'),
    trailers: trailers.length > 0 ? trailerVideos.map(video => ({ source: video.key, type: 'Trailer' })) : undefined,
    trailerStreams: trailerStreams.length > 0 ? trailerStreams : undefined,
    videos: videos, // Cinemeta compatibility - empty array for now
    status: !isMovie ? tmdbData.status : undefined,
    tmdbId: tmdbData.id,
    moviedb_id: tmdbData.id, // Cinemeta compatibility
    tmdbRating: tmdbData.vote_average,
    tmdbVotes: tmdbData.vote_count,
    popularity: tmdbData.popularity ? (tmdbData.popularity / 100) : 0, // Normalize to match Cinemeta scale
    
    // Add logo if available
    logo: logo,
    
    // Add Stremio-specific fields for better integration
    popularities: {
      moviedb: tmdbData.popularity || 0,
      tmdb: tmdbData.popularity || 0,
      stremio: tmdbData.popularity ? (tmdbData.popularity / 100) : 0
    },
    
    // Create links similar to Cinemeta
    links: [],
    
    // Enhanced behavior hints for better Stremio integration
    behaviorHints: {
      defaultVideoId: !isMovie ? null : (imdbId && imdbId.startsWith('tt') ? imdbId : tmdbId),
      hasScheduledVideos: !isMovie, // TV shows have scheduled videos
      p2p: false,
      configurable: false,
      configurationRequired: false
    },
    
    // Add detailed cast information in app_extras for richer metadata
    app_extras: {
      cast: detailedCast.length > 0 ? detailedCast : undefined
    }
  };
  
  // Build links array similar to Cinemeta
  if (metadata.links) {
    // IMDb rating link
    if (metadata.imdbRating && imdbId && imdbId.startsWith('tt')) {
      metadata.links.push({
        name: metadata.imdbRating,
        category: "imdb",
        url: `https://imdb.com/title/${imdbId}`
      });
    }
    

    
    // Genre links
    if (metadata.genres && metadata.genres.length > 0) {
      metadata.genres.forEach(genre => {
        metadata.links.push({
          name: genre,
          category: "Genres",
          url: `stremio:///discover/tmdb/${type}/popular?genre=${encodeURIComponent(genre)}`
        });
      });
    }
    
    // Cast links
    if (metadata.cast && metadata.cast.length > 0) {
      metadata.cast.slice(0, 5).forEach(actor => { // Limit to 5 cast members
        metadata.links.push({
          name: actor,
          category: "Cast",
          url: `stremio:///search?search=${encodeURIComponent(actor)}`
        });
      });
    }
    
    // Director links
    if (metadata.director && metadata.director.length > 0) {
      metadata.director.forEach(dir => {
        metadata.links.push({
          name: dir,
          category: "Directors",
          url: `stremio:///search?search=${encodeURIComponent(dir)}`
        });
      });
    }
    
    // Writer links
    if (metadata.writer && metadata.writer.length > 0) {
      metadata.writer.forEach(writer => {
        metadata.links.push({
          name: writer,
          category: "Writers", 
          url: `stremio:///search?search=${encodeURIComponent(writer)}`
        });
      });
    }
  }
  
  // Add slug for Stremio compatibility
  if (metadata.name && imdbId && imdbId.startsWith('tt')) {
    // Use IMDB ID for slug to match expected format (series/name-imdbNumber)
    const imdbNumber = imdbId.replace('tt', '');
    metadata.slug = `${type}/${metadata.name}-${imdbNumber}`;
  } else if (metadata.name) {
    // Fallback to TMDB ID if no IMDB ID
    metadata.slug = `${type}/content-${tmdbData.id}`;
  }
  
  return metadata;
}

/**
 * Batch fetch metadata from TMDB for multiple items
 * @param {Object[]} items - Array of items with tmdbId, type, and optionally imdbId
 * @param {string} language - Language code
 * @param {string} userBearerToken - User's TMDB Read Access Token
 * @returns {Promise<Object>} Map of item identifier to metadata
 */
async function batchFetchTmdbMetadata(items, language = 'en-US', userBearerToken = DEFAULT_TMDB_BEARER_TOKEN) {
  if (!items?.length) return {};
  
  const CONCURRENCY_LIMIT = TMDB_CONCURRENT_REQUESTS || 12; // Use config value, increased from 8
  const results = {};
  
  const processChunk = async (chunk) => {
    const chunkPromises = chunk.map(async (item) => {
      const identifier = item.imdbId || `tmdb:${item.tmdbId}`;
      try {
        const metadata = await fetchTmdbMetadata(item.tmdbId, item.type, language, userBearerToken);
        if (metadata) {
          // Ensure the ID is set to the IMDB ID if we have it
          if (item.imdbId) {
            metadata.id = item.imdbId;
            metadata.imdb_id = item.imdbId;
          }
          return { identifier, metadata };
        }
        return { identifier, metadata: null };
      } catch (error) {
        console.error(`Error fetching TMDB metadata for item ${identifier}:`, error.message);
        return { identifier, metadata: null };
      }
    });
    
    return Promise.all(chunkPromises);
  };
  
  // Split into chunks and process them
  const chunks = [];
  for (let i = 0; i < items.length; i += CONCURRENCY_LIMIT) {
    chunks.push(items.slice(i, i + CONCURRENCY_LIMIT));
  }
  
  for (const chunk of chunks) {
    const chunkResults = await processChunk(chunk);
    chunkResults.forEach(({ identifier, metadata }) => {
      if (metadata) {
        results[identifier] = metadata;
      }
    });
    
    // Small delay between chunks to respect API rate limits
    if (chunk !== chunks[chunks.length - 1]) {
      await new Promise(resolve => setTimeout(resolve, 100)); // Reduced from 150ms to 100ms
    }
  }
  
  return results;
}

/**
 * Fetch translated genres from TMDB
 * @param {string} language - Language code (e.g., 'en-US', 'fr-FR')
 * @param {string} userBearerToken - User's TMDB Read Access Token
 * @returns {Promise<string[]>} Array of translated genre names
 */
async function fetchTmdbGenres(language = 'en-US', userBearerToken = DEFAULT_TMDB_BEARER_TOKEN) {
  if (!language) return [];
  
  const cacheKey = `tmdb_genres_${language}`;
  const cachedGenres = tmdbCache.get(cacheKey);
  if (cachedGenres) {
    return cachedGenres === 'null' ? [] : cachedGenres;
  }
  
  try {
    // Fetch both movie and TV genres
    const [movieResponse, tvResponse] = await Promise.all([
      axios.get(`${TMDB_BASE_URL_V3}/genre/movie/list`, {
        params: {
          language: language
        },
        headers: {
          'accept': 'application/json',
          'Authorization': `Bearer ${userBearerToken}`
        },
        timeout: TMDB_REQUEST_TIMEOUT
      }),
      axios.get(`${TMDB_BASE_URL_V3}/genre/tv/list`, {
        params: {
          language: language
        },
        headers: {
          'accept': 'application/json',
          'Authorization': `Bearer ${userBearerToken}`
        },
        timeout: TMDB_REQUEST_TIMEOUT
      })
    ]);
    
    // Combine and deduplicate genres
    const movieGenres = movieResponse.data.genres || [];
    const tvGenres = tvResponse.data.genres || [];
    const allGenres = [...movieGenres, ...tvGenres];
    
    // Create a map to deduplicate by name (case-insensitive)
    const genreMap = new Map();
    allGenres.forEach(genre => {
      const key = genre.name.toLowerCase();
      if (!genreMap.has(key)) {
        genreMap.set(key, genre.name);
      }
    });
    
    // Add "All" option at the beginning
    const translatedGenres = ['All', ...Array.from(genreMap.values()).sort()];
    
    // Cache for 24 hours
    tmdbCache.set(cacheKey, translatedGenres, 24 * 3600 * 1000);
    return translatedGenres;
    
  } catch (error) {
    console.error(`Error fetching TMDB genres for language ${language}:`, error.message);
    tmdbCache.set(cacheKey, 'null', 60 * 60 * 1000); // Cache error for 1 hour
    return [];
  }
}

/**
 * Create a mapping between localized genre names and English names using TMDB genre IDs
 * @param {string} language - User's language code (e.g., 'fr-FR', 'es-ES')
 * @param {string} userBearerToken - User's TMDB Read Access Token
 * @returns {Promise<Map>} Map from localized genre name to English genre name
 */
async function createTmdbGenreTranslationMap(language = 'en-US', userBearerToken = DEFAULT_TMDB_BEARER_TOKEN) {
  // No translation needed for English
  if (!language || language === 'en-US' || language === 'en') {
    return new Map();
  }
  
  const cacheKey = `tmdb_genre_translation_${language}`;
  const cachedMap = tmdbCache.get(cacheKey);
  if (cachedMap) {
    return cachedMap === 'null' ? new Map() : new Map(cachedMap);
  }
  
  try {
    const headers = {
      'accept': 'application/json',
      'Authorization': `Bearer ${userBearerToken}`
    };

    // Fetch both English and localized versions in parallel
    const [
      movieResponseEn, tvResponseEn,
      movieResponseLoc, tvResponseLoc
    ] = await Promise.all([
      axios.get(`${TMDB_BASE_URL_V3}/genre/movie/list`, {
        params: { language: 'en-US' },
        headers,
        timeout: TMDB_REQUEST_TIMEOUT
      }),
      axios.get(`${TMDB_BASE_URL_V3}/genre/tv/list`, {
        params: { language: 'en-US' },
        headers,
        timeout: TMDB_REQUEST_TIMEOUT
      }),
      axios.get(`${TMDB_BASE_URL_V3}/genre/movie/list`, {
        params: { language: language },
        headers,
        timeout: TMDB_REQUEST_TIMEOUT
      }),
      axios.get(`${TMDB_BASE_URL_V3}/genre/tv/list`, {
        params: { language: language },
        headers,
        timeout: TMDB_REQUEST_TIMEOUT
      })
    ]);

    const movieGenresEn = movieResponseEn.data?.genres || [];
    const tvGenresEn = tvResponseEn.data?.genres || [];
    const movieGenresLoc = movieResponseLoc.data?.genres || [];
    const tvGenresLoc = tvResponseLoc.data?.genres || [];

    // Create ID-based mapping from English genres
    const genreIdToEnglish = new Map();
    [...movieGenresEn, ...tvGenresEn].forEach(genre => {
      genreIdToEnglish.set(genre.id, genre.name);
    });

    // Create localized-to-English mapping using genre IDs
    const translationMap = new Map();
    [...movieGenresLoc, ...tvGenresLoc].forEach(genre => {
      const englishName = genreIdToEnglish.get(genre.id);
      if (englishName && genre.name !== englishName) {
        // Map localized name to English name
        translationMap.set(genre.name, englishName);
        // Also add lowercase versions for better matching
        translationMap.set(genre.name.toLowerCase(), englishName.toLowerCase());
      }
    });

    console.log(`[TMDB] Created genre translation map for ${language} with ${translationMap.size / 2} unique mappings`);
    
    // Cache for 24 hours (store as array of entries for JSON serialization)
    tmdbCache.set(cacheKey, Array.from(translationMap.entries()), 24 * 3600 * 1000);
    return translationMap;

  } catch (error) {
    console.error(`[TMDB] Error creating genre translation map for ${language}:`, error.message);
    tmdbCache.set(cacheKey, 'null', 60 * 60 * 1000); // Cache error for 1 hour
    return new Map();
  }
}

/**
 * Translate a localized genre name to English for API filtering with MDBList/Trakt
 * @param {string} localizedGenre - Genre name in user's language
 * @param {Map} translationMap - Translation map from createTmdbGenreTranslationMap
 * @returns {string} English genre name or original if no translation found
 */
function translateGenreToEnglish(localizedGenre, translationMap) {
  if (!localizedGenre || localizedGenre === 'All' || !translationMap || translationMap.size === 0) {
    return localizedGenre;
  }

  // Try exact match first
  const exactMatch = translationMap.get(localizedGenre);
  if (exactMatch) {
    return exactMatch;
  }

  // Try lowercase match
  const lowercaseMatch = translationMap.get(localizedGenre.toLowerCase());
  if (lowercaseMatch) {
    return lowercaseMatch;
  }

  // No translation found, return original
  console.log(`[TMDB] No translation found for genre "${localizedGenre}", using original for API filtering`);
  return localizedGenre;
}

/**
 * Clear all TMDB caches
 */
function clearTmdbCaches() {
  tmdbCache.clear();
  imdbToTmdbCache.clear();
}

/**
 * Map TMDB genre names to MDBList genre names for API filtering
 * @param {string} tmdbGenre - Genre name from TMDB (could be in any language)
 * @param {Map} translationMap - Translation map from localized to English
 * @returns {string} MDBList-compatible genre name
 */
function mapTmdbGenreToMdblist(tmdbGenre, translationMap = new Map()) {
  if (!tmdbGenre || tmdbGenre === 'All') {
    return tmdbGenre;
  }

  // First translate to English if needed
  let englishGenre = tmdbGenre;
  if (translationMap && translationMap.size > 0) {
    const translated = translateGenreToEnglish(tmdbGenre, translationMap);
    if (translated) {
      englishGenre = translated;
    }
  }

  // Map TMDB English genres to MDBList genres
  const tmdbToMdblistMap = {
    'Action': 'action',
    'Adventure': 'adventure', 
    'Animation': 'animation',
    'Comedy': 'comedy',
    'Crime': 'crime',
    'Documentary': 'documentary',
    'Drama': 'drama',
    'Family': 'family',
    'Fantasy': 'fantasy',
    'History': 'history',
    'Horror': 'horror',
    'Music': 'music',
    'Musical': 'musical',
    'Mystery': 'mystery',
    'Romance': 'romance',
    'Science Fiction': 'science-fiction',
    'Thriller': 'thriller',
    'War': 'war',
    'Western': 'western',
    'Biography': 'biography',
    'Sport': 'sport',
    'Short': 'short',
    // Additional mappings for common variations
    'Sci-Fi': 'science-fiction',
    'Sci-Fi & Fantasy': 'science-fiction',
    'Action & Adventure': 'action-adventure',
    'War & Politics': 'war-politics',
    'Kids': 'kids',
    'Reality': 'reality',
    'Talk': 'talk',
    'News': 'news',
    'Soap': 'soap',
    'TV Movie': 'tv-movie'
  };

  // Try exact match first
  const exactMatch = tmdbToMdblistMap[englishGenre];
  if (exactMatch) {
    return exactMatch;
  }

  // Try case-insensitive match
  const lowerGenre = englishGenre.toLowerCase();
  for (const [tmdbKey, mdblistValue] of Object.entries(tmdbToMdblistMap)) {
    if (tmdbKey.toLowerCase() === lowerGenre) {
      return mdblistValue;
    }
  }

  // If no mapping found, return lowercase version
  console.log(`[TMDB->MDBList] No mapping found for genre "${englishGenre}", using lowercase version`);
  return englishGenre.toLowerCase();
}

module.exports = {
  validateTMDBKey,
  getTmdbAuthUrl,
  authenticateTmdb,
  fetchTmdbLists,
  fetchTmdbListItems,
  convertImdbToTmdbId,
  batchConvertImdbToTmdbIds,
  fetchTmdbMetadata,
  batchFetchTmdbMetadata,
  fetchTmdbGenres,
  createTmdbGenreTranslationMap,
  translateGenreToEnglish,
  clearTmdbCaches,
  mapTmdbGenreToMdblist
}; 