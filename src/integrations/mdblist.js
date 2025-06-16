// src/integrations/mdblist.js
const axios = require('axios');
const { ITEMS_PER_PAGE, MDB_LIST_CONCURRENT_REQUESTS } = require('../config');
const { enrichItemsWithMetadata } = require('../utils/metadataFetcher');

// Helper function for delay
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const MAX_RETRIES = 4;
const INITIAL_RETRY_DELAY_MS = 5000;

async function validateMDBListKey(apiKey) {
  if (!apiKey) return null;
  try {
    const response = await axios.get(`https://api.mdblist.com/user?apikey=${apiKey}`, { timeout: 5000 });
    return (response.status === 200 && response.data) ? response.data : null;
  } catch (error) {
    console.error('Error validating MDBList Key:', error.message);
    return null;
  }
}

/**
 * Convert public access MDBList imports to premium API-based lists when an API key is provided
 * @param {Object} userConfig - User configuration containing importedAddons
 * @param {string} apiKey - Valid MDBList API key
 * @returns {Promise<Object>} Object with success status and any changes made
 */
async function convertPublicListsToPremium(userConfig, apiKey) {
  if (!apiKey || !userConfig.importedAddons) {
    return { success: true, conversions: 0, errors: [] };
  }

  console.log('[MDBList] Converting public access lists to premium API access...');
  
  let conversions = 0;
  const errors = [];
  
  // Find all MDBList imports that need conversion:
  // 1. Explicit public access lists (isPublicAccess: true)
  // 2. Legacy URL imports without API access (no isPublicAccess field, mdblistId is slug-like)
  const publicListAddons = Object.entries(userConfig.importedAddons).filter(([id, addon]) => {
    if (!addon.isMDBListUrlImport || !addon.mdblistUsername || !addon.mdblistSlug) {
      return false;
    }
    
    // Explicit public access
    if (addon.isPublicAccess === true) {
      return true;
    }
    
    // Legacy imports (no isPublicAccess field) that likely need conversion
    // These are imports made before API key was available
    if (addon.isPublicAccess === undefined && addon.mdblistId) {
      // If mdblistId is the same as mdblistSlug, it's likely a legacy import
      if (addon.mdblistId === addon.mdblistSlug) {
        return true;
      }
      // If mdblistId is not a pure numeric string, it might be a slug
      if (isNaN(parseInt(addon.mdblistId)) || addon.mdblistId.includes('-')) {
        return true;
      }
    }
    
    return false;
  });

  if (publicListAddons.length === 0) {
    console.log('[MDBList] No public access or legacy lists found to convert');
    return { success: true, conversions: 0, errors: [] };
  }

  console.log(`[MDBList] Found ${publicListAddons.length} MDBList imports to convert to API access`);

  // Process each list that needs conversion
  const convertedLists = []; // Track successfully converted lists
  for (const [addonId, addon] of publicListAddons) {
    try {
      const conversionType = addon.isPublicAccess === true ? 'public access' : 'legacy import';
      console.log(`[MDBList] Converting ${conversionType} list: ${addon.name} (${addon.mdblistUsername}/${addon.mdblistSlug})`);
      
      // Construct the URL for re-extraction with API key
      const listUrl = `https://mdblist.com/lists/${addon.mdblistUsername}/${addon.mdblistSlug}`;
      
      // Extract list info using API key
      const apiListData = await extractListFromUrl(listUrl, apiKey);
      
      if (apiListData && !apiListData.isPublicAccess) {
        // Successfully converted to API access
        console.log(`[MDBList] Successfully converted ${addon.name} to API access (ID: ${apiListData.listId})`);
        
        // Update the addon with API-based data
        userConfig.importedAddons[addonId] = {
          ...addon,
          // Update with API-based properties
          mdblistId: apiListData.listId, // Numeric ID from API
          isPublicAccess: false, // No longer public access
          hasMovies: apiListData.hasMovies,
          hasShows: apiListData.hasShows,
          // Keep the original username/slug for fallback compatibility
          mdblistUsername: addon.mdblistUsername,
          mdblistSlug: addon.mdblistSlug
        };
        
        conversions++;
        convertedLists.push({
          id: addonId,
          name: addon.name,
          username: addon.mdblistUsername,
          slug: addon.mdblistSlug,
          newApiId: apiListData.listId
        });
      } else {
        console.warn(`[MDBList] Failed to convert ${addon.name} to API access - API extraction returned public access or failed`);
        errors.push(`Failed to convert "${addon.name}" to API access`);
      }
      
    } catch (error) {
      console.error(`[MDBList] Error converting ${addon.name}:`, error.message);
      errors.push(`Error converting "${addon.name}": ${error.message}`);
      
      // Continue with other lists even if one fails
    }
    
    // Small delay between conversions to be respectful to the API
    if (publicListAddons.indexOf([addonId, addon]) < publicListAddons.length - 1) {
      await delay(1000);
    }
  }

  const result = {
    success: true,
    conversions,
    errors,
    message: conversions > 0 ? 
      `Successfully converted ${conversions} public lists to premium API access` :
      'No lists were converted',
    // Add detailed conversion info for better UI feedback
    convertedLists: convertedLists
  };

  if (conversions > 0) {
    console.log(`[MDBList] Conversion complete: ${conversions} lists converted to premium access`);
  }
  
  if (errors.length > 0) {
    console.warn(`[MDBList] Conversion completed with ${errors.length} errors:`, errors);
  }

  return result;
}

async function fetchAllLists(apiKey) {
  if (!apiKey) return [];
  
  const fetchStartTime = Date.now();
  
  let allLists = [];
  const listEndpoints = [
    { url: `https://api.mdblist.com/lists/user?apikey=${apiKey}`, type: 'L' },
    { url: `https://api.mdblist.com/external/lists/user?apikey=${apiKey}`, type: 'E' }
  ];
  
  // Use parallel requests with concurrency control
  const MDBLIST_FETCH_CONCURRENCY = MDB_LIST_CONCURRENT_REQUESTS;

  for (const endpoint of listEndpoints) {
    const endpointStartTime = Date.now();

    
    let currentRetries = 0;
    let success = false;
    while (currentRetries < MAX_RETRIES && !success) {
      try {
        const response = await axios.get(endpoint.url, { timeout: 15000 });
        if (response.data && Array.isArray(response.data)) {
          const listCount = response.data.length;
          allLists.push(...response.data.map(list => ({ ...list, listType: endpoint.type, name: list.name })));

        }
        success = true;
      } catch (err) {
        currentRetries++;
        console.error(`Error fetching MDBList ${endpoint.type} lists (attempt ${currentRetries}/${MAX_RETRIES}):`, err.message);
        if (err.response && (err.response.status === 503 || err.response.status === 429) && currentRetries < MAX_RETRIES) {
          const retryDelay = INITIAL_RETRY_DELAY_MS * Math.pow(2, currentRetries - 1);
          console.log(`Rate limit or server error for ${endpoint.type}, retrying after ${retryDelay}ms...`);
          await delay(retryDelay);
        } else {
          console.error(`Failed to fetch MDBList ${endpoint.type} lists after ${currentRetries} attempts.`);
          break;
        }
      }
    }
    if (success && listEndpoints.indexOf(endpoint) < listEndpoints.length - 1) {
      await delay(2000);
    }
  }
  allLists.push({ id: 'watchlist', name: 'My Watchlist', listType: 'W', isWatchlist: true });
  
  const fetchEndTime = Date.now();
  return allLists;
}

// Updated function to fetch all lists for a specific MDBList username
async function fetchAllListsForUser(apiKey, username) {
  if (!apiKey || !username) return [];
  let userLists = [];

  // Fetch user's "standard" public lists
  try {
    // Using the path structure you confirmed works: /lists/user/{username}
    const response = await axios.get(`https://api.mdblist.com/lists/user/${username}?apikey=${apiKey}`, { timeout: 10000 });
    if (response.data && Array.isArray(response.data)) {
      // Add a property to distinguish if needed, or rely on list.user_name if present in response
      userLists.push(...response.data.map(list => ({ ...list, listType: 'L', fetchedForUser: username })));
    }
  } catch (error) {
    console.error(`Error fetching lists for MDBList user ${username} (path /lists/user/${username}):`, error.message);
    if (error.response) {
        console.error(`Response status: ${error.response.status}`, error.response.data ? `Data: ${JSON.stringify(error.response.data).substring(0, 200)}` : '');
    }
  }

  // Fetch user's "external" public lists
  try {
    await delay(1000); // Be respectful to the API
    // Assuming a similar structure for external lists of another user
    const extResponse = await axios.get(`https://api.mdblist.com/external/lists/user/${username}?apikey=${apiKey}`, { timeout: 10000 });
    if (extResponse.data && Array.isArray(extResponse.data)) {
      userLists.push(...extResponse.data.map(list => ({ ...list, listType: 'E', fetchedForUser: username })));
    }
  } catch (error) {
    console.error(`Error fetching external lists for MDBList user ${username} (path /external/lists/user/${username}):`, error.message);
     if (error.response) {
        console.error(`Response status: ${error.response.status}`, error.response.data ? `Data: ${JSON.stringify(error.response.data).substring(0, 200)}` : '');
    }
  }

  // Filter for public lists (MDBList API usually handles this, but an explicit check is good)
  // and ensure the list has items.
  return userLists.filter(list =>
    (list.private === false || list.public === true) && list.items > 0 // Simplified check for public and ensure items
  );
}


function processMDBListApiResponse(data, isWatchlistUnified = false) {
    if (!data || data.error) {
      console.error('MDBList API error:', data?.error || 'No data received from MDBList');
      return { items: [], hasMovies: false, hasShows: false };
    }
  
    let rawItems = [];
    let hasMovies = false;
    let hasShows = false;
  
    if (isWatchlistUnified && Array.isArray(data)) {
      rawItems = data.map(item => {
        const type = (item.type === 'show' || item.mediatype === 'show' || item.media_type === 'show') ? 'series' : 'movie';
        if (type === 'movie') hasMovies = true;
        if (type === 'series') hasShows = true;
        return {
          ...item,
          type,
          imdb_id: item.imdb_id || item.imdbid,
          id: item.imdb_id || item.imdbid,
        };
      });
    } else {
      if (Array.isArray(data.movies) && data.movies.length > 0) {
        rawItems.push(...data.movies.map(m => ({ ...m, type: 'movie' })));
        hasMovies = true;
      }
      if (Array.isArray(data.shows) && data.shows.length > 0) {
        rawItems.push(...data.shows.map(s => ({ ...s, type: 'series' })));
        hasShows = true;
      }
  
      if (rawItems.length === 0) {
        let itemsInput = [];
        if (Array.isArray(data)) itemsInput = data;
        else if (Array.isArray(data.items)) itemsInput = data.items;
        else if (Array.isArray(data.results)) itemsInput = data.results;
  
        rawItems = itemsInput.map(item => {
          const type = (item.type === 'show' || item.mediatype === 'show' || item.media_type === 'show') ? 'series' : 'movie';
          if (type === 'movie') hasMovies = true;
          if (type === 'series') hasShows = true;
          return {
            ...item,
            type
          };
        });
      }
    }
  
    const finalItems = rawItems.map(item => ({
      ...item,
      imdb_id: item.imdb_id || item.imdbid,
      id: item.imdb_id || item.imdbid,
    })).filter(item => item.imdb_id);
  
    return { items: finalItems, hasMovies, hasShows };
  }

/**
 * Fetch items from MDBList public JSON endpoint (no API key required)
 * @param {string} username - MDBList username
 * @param {string} listSlug - List slug/identifier  
 * @param {number} skip - Number of items to skip for pagination
 * @param {string} sort - Sort parameter (supports all MDBList sort options)
 * @param {string} order - Order parameter (asc/desc)
 * @param {string} genre - Genre filter
 * @param {Object} userConfig - User configuration for metadata enrichment
 * @param {boolean} isMergedByUser - Whether this is a merged/unified list
 * @returns {Promise<Object|null>} Formatted list content or null if failed
 */
async function fetchListItemsFromPublicJson(username, listSlug, skip = 0, sort = 'rank', order = 'asc', genre = null, userConfig = null, isMergedByUser = false) {
  try {
    // Construct the public JSON URL with full parameter support
    const params = new URLSearchParams();
    params.append('limit', ITEMS_PER_PAGE.toString());
    
    // Use offset instead of skip for MDBList API compatibility
    if (skip > 0) {
      params.append('offset', skip.toString());
    }
    
    // Add sort parameter - MDBList public JSON supports most sort options
    if (sort && sort !== 'default') {
      params.append('sort', sort);
    }
    
    // Add order parameter
    if (order === 'desc') {
      params.append('order', 'desc');
    } else if (order === 'asc') {
      params.append('order', 'asc');
    }
    
    // Add genre filtering for public JSON if specified
    if (genre && genre !== 'All') {
      params.append('filter_genre', genre.toLowerCase());
    }
    
    // Add unified parameter for mergeable lists (combines movies and shows)
    if (isMergedByUser) {
      params.append('unified', 'true');
    }
    
    // Add append_to_response for additional metadata (if supported)
    params.append('append_to_response', 'ratings');

    const publicJsonUrl = `https://mdblist.com/lists/${username}/${listSlug}/json/?${params.toString()}`;
    

    
    const response = await axios.get(publicJsonUrl, { 
      timeout: 15000,
      headers: {
        'User-Agent': 'AIOLists-Stremio-Addon/1.0'
      }
    });

    if (!response.data || !Array.isArray(response.data)) {
      console.error('[MDBList Public] Invalid response format from public JSON endpoint');
      return null;
    }

    const rawItems = response.data;


    // Process the public JSON response format
    let hasMovies = false;
    let hasShows = false;
    
    const processedItems = rawItems.map(item => {
      // Convert public JSON format to internal format
      const type = (item.mediatype === 'show' || item.mediatype === 'series') ? 'series' : 'movie';
      if (type === 'movie') hasMovies = true;
      if (type === 'series') hasShows = true;

      return {
        id: item.imdb_id,
        imdb_id: item.imdb_id,
        type: type,
        title: item.title,
        name: item.title,
        year: item.release_year,
        release_year: item.release_year,
        rank: item.rank,
        // Add other fields that might be present
        tvdb_id: item.tvdbid,
        adult: item.adult
      };
    }).filter(item => item.imdb_id); // Only keep items with valid IMDB IDs

    // API-level filtering is already applied via URL parameters
    // No need for additional client-side filtering
    let filteredItems = processedItems;

    // No metadata enrichment here - this will be done in the addon builder when serving to Stremio
    let enrichedItems = filteredItems;

    // Note: Genre filtering is now handled after metadata enrichment in the addon builder
    // This ensures TMDB-enriched genres are properly used for filtering

    return {
      allItems: enrichedItems,
      hasMovies,
      hasShows
    };

  } catch (error) {
    console.error(`[MDBList Public] Error fetching from public JSON endpoint:`, error.message);
    if (error.response) {
      console.error(`[MDBList Public] HTTP ${error.response.status}: ${error.response.statusText}`);
    }
    return null;
  }
}

async function fetchListItems(
    listId, // This will be the MDBList list ID (numeric) or slug
    apiKey,
    listsMetadata, // Generally not used when fetching a specific list's items directly
    stremioSkip = 0,
    sort = 'default',
    order = 'desc',
    isUrlImported = false, // Not directly relevant here, but part of original signature
    genre = null,
    usernameForRandomList = null, // The username whose list we are fetching
    isMergedByUser = false,
    userConfig = null // Added to access metadata preferences
) {
  // If no API key is provided, try to use public JSON endpoint if we have the necessary information
  if (!apiKey) {

    
    // Check if we have the necessary information for public JSON access
    let username = usernameForRandomList;
    let listSlug = String(listId);
    
    // Try to extract username and slug from userConfig.importedAddons if this is a URL import
    if (!username && userConfig?.importedAddons) {
      for (const addon of Object.values(userConfig.importedAddons)) {
        if (addon.isMDBListUrlImport && (addon.mdblistId === listId || addon.id === listId)) {
          username = addon.mdblistUsername;
          listSlug = addon.mdblistSlug || addon.mdblistId;
          break;
        }
      }
    }
    
    // Also check if this is from randomMDBListUsernames feature
    if (!username && userConfig?.enableRandomListFeature && userConfig?.randomMDBListUsernames?.length > 0) {
      // For random lists, we might have the username stored differently
      // This would need to be coordinated with how the random list selection works
      
    }
    
    if (username && listSlug) {
              const publicResult = await fetchListItemsFromPublicJson(username, listSlug, stremioSkip, sort, order, genre, userConfig, isMergedByUser);
        if (publicResult) {
          return publicResult;
        }
      }
    return null;
  }

  const MAX_ATTEMPTS_FOR_GENRE_FILTER = 10; // Allow more attempts for proper pagination with genre filtering
  const MDBLIST_PAGE_LIMIT = ITEMS_PER_PAGE;

  let effectiveMdbListId = String(listId); // Ensure it's a string (could be numeric ID or slug)
  // No need to strip prefixes if we are directly passing the listId/slug for a random list

  let mdbListOffset = 0;
  let attemptsForGenreCompletion = 0;
  let allEnrichedGenreItems = [];
  let morePagesFromMdbList = true;
  let allItems = [];
  let hasMovies = false;
  let hasShows = false;

  // The usernameForRandomList parameter indicates we are fetching items for a list from a specific user (not the API key owner)
  const listOwnerUsername = usernameForRandomList;

  if (genre && genre !== 'All') { // If genre filtering is needed
    while (allEnrichedGenreItems.length < stremioSkip + MDBLIST_PAGE_LIMIT && attemptsForGenreCompletion < MAX_ATTEMPTS_FOR_GENRE_FILTER && morePagesFromMdbList) {
      let apiUrl;
      const params = new URLSearchParams({
        apikey: apiKey,
        sort: sort,
        order: order,
        limit: MDBLIST_PAGE_LIMIT,
        offset: mdbListOffset
      });

      // Add MDBList native genre filtering
      if (genre && genre !== 'All') {
        params.append('filter_genre', genre.toLowerCase());
      }

      if (isMergedByUser && effectiveMdbListId !== 'watchlist' && effectiveMdbListId !== 'watchlist-W' && !listOwnerUsername) {
          params.append('unified', 'true');
        }

      if (listOwnerUsername) { // Fetching specific user's list (e.g., random catalog's chosen list)
        apiUrl = `https://api.mdblist.com/lists/${listOwnerUsername}/${effectiveMdbListId}/items?${params.toString()}`;
      } else if (effectiveMdbListId === 'watchlist' || effectiveMdbListId === 'watchlist-W') { // Authenticated user's watchlist
        params.append('unified', 'true');
        apiUrl = `https://api.mdblist.com/watchlist/items?${params.toString()}`;
      } else { // Authenticated user's own list (not a URL import or random)
        let listPrefix = '';
        // This part is for API key owner's lists, might need listsMetadata to determine if it's 'L' or 'E' type
        // However, for the random catalog, listOwnerUsername will be set, so this branch won't be hit for that.
        const metadata = listsMetadata && (listsMetadata[listId] || listsMetadata[`aiolists-${listId}-L`] || listsMetadata[`aiolists-${listId}-E`]);
        let effectiveListType = metadata?.listType;
        if (!isUrlImported && !effectiveListType) {
            const allUserLists = await fetchAllLists(apiKey); // Fetches for the API key owner
            const listObj = allUserLists.find(l => String(l.id) === String(effectiveMdbListId));
            effectiveListType = listObj?.listType;
        }
        if (effectiveListType === 'E') listPrefix = 'external/';
        apiUrl = `https://api.mdblist.com/${listPrefix}lists/${effectiveMdbListId}/items?${params.toString()}`;
      }

      let response;
      let success = false;
      let currentRetries = 0;
      while(currentRetries < MAX_RETRIES && !success) {
        try {
          response = await axios.get(apiUrl, { timeout: 15000 });
          if (response.status === 429 && currentRetries < MAX_RETRIES) {
            // ... (rate limit handling as before)
            currentRetries++;
            const retryDelay = INITIAL_RETRY_DELAY_MS * Math.pow(2, currentRetries - 1);
            console.error(`Rate limited by MDBList API for list ${effectiveMdbListId} of user ${listOwnerUsername || 'self'} (offset ${mdbListOffset}), attempt ${currentRetries}/${MAX_RETRIES}. Retrying after ${retryDelay}ms...`);
            await delay(retryDelay);
            continue;
          }
          success = true;
        } catch (error) {
          // Check if this is an API key validation error and we have fallback info
          if (!success && error.response && (error.response.status === 401 || error.response.status === 403)) {
            
            // Try to extract username and slug for public JSON fallback
            let username = listOwnerUsername;
            let listSlug = effectiveMdbListId;
            
            if (!username && userConfig?.importedAddons) {
              for (const addon of Object.values(userConfig.importedAddons)) {
                if (addon.isMDBListUrlImport && (addon.mdblistId === listId || addon.id === listId)) {
                  username = addon.mdblistUsername;
                  listSlug = addon.mdblistSlug || addon.mdblistId;
                  break;
                }
              }
            }
            
            if (username && listSlug) {
              const publicResult = await fetchListItemsFromPublicJson(username, listSlug, stremioSkip, sort, order, genre, userConfig, isMergedByUser);
              if (publicResult) {
                return publicResult;
              }
            }
          }
          
          // ... (existing error handling)
          currentRetries++;
          console.error(`Error fetching MDBList page for list ${effectiveMdbListId} of user ${listOwnerUsername || 'self'} (offset ${mdbListOffset}, attempt ${currentRetries}/${MAX_RETRIES}):`, error.message);
          if (error.response && (error.response.status === 503 || error.response.status === 429) && currentRetries < MAX_RETRIES) {
              const retryDelay = INITIAL_RETRY_DELAY_MS * Math.pow(2, currentRetries - 1);
              console.log(`Rate limit or server error during genre filtering for ${effectiveMdbListId}, retrying after ${retryDelay}ms...`);
              await delay(retryDelay);
          } else if (error.response && error.response.status === 404 && listOwnerUsername) {
             console.warn(`MDBList user ${listOwnerUsername} or list ${effectiveMdbListId} not found (genre fetch). Returning null.`);
             return null;
          } else {
              console.error(`Failed to fetch page for ${effectiveMdbListId} (genre filter) after ${currentRetries} attempts.`);
              morePagesFromMdbList = false;
              break;
          }
        }
      }
      if (!success || !morePagesFromMdbList) break;
      const mdbApiResponseData = response.data;
      const isWatchlistCall = !listOwnerUsername && (effectiveMdbListId === 'watchlist' || effectiveMdbListId === 'watchlist-W');
      const { items: initialItemsFlat, hasMovies: pageHasMovies, hasShows: pageHasShows } = processMDBListApiResponse(mdbApiResponseData, isWatchlistCall);
      if (pageHasMovies) hasMovies = true;
      if (pageHasShows) hasShows = true;

      if (!initialItemsFlat || initialItemsFlat.length === 0) { morePagesFromMdbList = false; break; }
      
      // With API-level filtering, we can now directly use the items from MDBList
      // No need for post-processing genre filtering since MDBList handles it natively
      allEnrichedGenreItems.push(...initialItemsFlat);
      mdbListOffset += MDBLIST_PAGE_LIMIT;
      attemptsForGenreCompletion++;
      if (morePagesFromMdbList && attemptsForGenreCompletion < MAX_ATTEMPTS_FOR_GENRE_FILTER) await delay(1250);
    }
    allItems = allEnrichedGenreItems.slice(stremioSkip, stremioSkip + ITEMS_PER_PAGE);

  } else { // No genre filtering or All genre selected, direct fetch
    let apiUrl;
    mdbListOffset = stremioSkip;
    const params = new URLSearchParams({
        apikey: apiKey,
        sort: sort,
        order: order,
        limit: ITEMS_PER_PAGE, // Use ITEMS_PER_PAGE from config
        offset: mdbListOffset
      });

    // Add MDBList native genre filtering even for direct fetch if genre is specified
    if (genre && genre !== 'All') {
      params.append('filter_genre', genre.toLowerCase());
    }

    if (isMergedByUser && effectiveMdbListId !== 'watchlist' && effectiveMdbListId !== 'watchlist-W' && !listOwnerUsername) {
        params.append('unified', 'true');
      }

    if (listOwnerUsername) { // Fetching specific user's list (e.g., random catalog's chosen list)
        apiUrl = `https://api.mdblist.com/lists/${listOwnerUsername}/${effectiveMdbListId}/items?${params.toString()}`;
    } else if (effectiveMdbListId === 'watchlist' || effectiveMdbListId === 'watchlist-W') { // Authenticated user's watchlist
        params.append('unified', 'true');
        apiUrl = `https://api.mdblist.com/watchlist/items?${params.toString()}`;
    } else { // Authenticated user's own list
        let listPrefix = '';
        // This logic is primarily for the API key owner's lists
        if (!isUrlImported) { // This check might be redundant if listOwnerUsername is the primary switch
            const metadata = listsMetadata && (listsMetadata[listId] || listsMetadata[`aiolists-${listId}-L`] || listsMetadata[`aiolists-${listId}-E`]);
            let originalListType = metadata?.listType;
             if (!originalListType) {
                const allUserLists = await fetchAllLists(apiKey);
                const listObj = allUserLists.find(l => String(l.id) === String(effectiveMdbListId));
                originalListType = listObj?.listType;
            }
            if (originalListType === 'E') listPrefix = 'external/';
        }
        apiUrl = `https://api.mdblist.com/${listPrefix}lists/${effectiveMdbListId}/items?${params.toString()}`;
    }
    // ... (axios call and error handling as before for single page fetch)
    let response;
    let success = false;
    let currentRetries = 0;
    while(currentRetries < MAX_RETRIES && !success) {
      try {
          response = await axios.get(apiUrl, { timeout: 15000 });
          if (response.status === 429 && currentRetries < MAX_RETRIES) {
             currentRetries++;
             const retryDelay = INITIAL_RETRY_DELAY_MS * Math.pow(2, currentRetries - 1);
             console.error(`Rate limited by MDBList API for list ${effectiveMdbListId} of user ${listOwnerUsername || 'self'} (single page), attempt ${currentRetries}/${MAX_RETRIES}. Retrying after ${retryDelay}ms...`);
             await delay(retryDelay);
             continue;
          }
          success = true;
      } catch (error) {
          // Check if this is an API key validation error and we have fallback info
          if (!success && error.response && (error.response.status === 401 || error.response.status === 403)) {
            
            // Try to extract username and slug for public JSON fallback
            let username = listOwnerUsername;
            let listSlug = effectiveMdbListId;
            
            if (!username && userConfig?.importedAddons) {
              for (const addon of Object.values(userConfig.importedAddons)) {
                if (addon.isMDBListUrlImport && (addon.mdblistId === listId || addon.id === listId)) {
                  username = addon.mdblistUsername;
                  listSlug = addon.mdblistSlug || addon.mdblistId;
                  break;
                }
              }
            }
            
            if (username && listSlug) {
              const publicResult = await fetchListItemsFromPublicJson(username, listSlug, stremioSkip, sort, order, genre, userConfig, isMergedByUser);
              if (publicResult) {
                return publicResult;
              }
            }
          }
          
          currentRetries++;
          console.error(`Error fetching MDBList items for list ${effectiveMdbListId} of user ${listOwnerUsername || 'self'} (offset ${mdbListOffset}, attempt ${currentRetries}/${MAX_RETRIES}):`, error.message);
          if (error.response && (error.response.status === 503 || error.response.status === 429) && currentRetries < MAX_RETRIES) {
              const retryDelay = INITIAL_RETRY_DELAY_MS * Math.pow(2, currentRetries - 1);
              console.log(`Rate limit or server error fetching single page for ${effectiveMdbListId}, retrying after ${retryDelay}ms...`);
              await delay(retryDelay);
          } else if (error.response && error.response.status === 404 && listOwnerUsername) {
             console.warn(`MDBList user ${listOwnerUsername} or list ${effectiveMdbListId} not found. Returning null.`);
             return null;
          } else {
              console.error(`Failed to fetch items for ${effectiveMdbListId} after ${currentRetries} attempts.`);
              return null;
          }
      }
    }

    if (!success) {
        console.error(`All retries failed for fetching items for list ID ${effectiveMdbListId} of user ${listOwnerUsername || 'self'}.`);
        return null;
    }

    const mdbApiResponseData = response.data;
    const isWatchlistCall = !listOwnerUsername && (effectiveMdbListId === 'watchlist' || effectiveMdbListId === 'watchlist-W');
    const { items: initialItemsFlat, hasMovies: pageHasMovies, hasShows: pageHasShows } = processMDBListApiResponse(mdbApiResponseData, isWatchlistCall);
    if (pageHasMovies) hasMovies = true;
    if (pageHasShows) hasShows = true;

    if (!initialItemsFlat || initialItemsFlat.length === 0) {
        return { allItems: [], hasMovies: false, hasShows: false };
    }
    
    // No metadata enrichment here - this will be done in the addon builder when serving to Stremio
    allItems = initialItemsFlat;
  }

  const finalResult = { allItems: allItems, hasMovies, hasShows };

  return finalResult;
}

async function extractListFromUrl(url, apiKey) {
  // Parse URL first to extract username and list slug
  const urlPattern = /^https?:\/\/mdblist\.com\/lists\/([\w-]+)\/([\w-]+)\/?$/;
  const urlMatch = url.match(urlPattern);
  if (!urlMatch) {
    throw new Error('Invalid MDBList URL format. Expected: https://mdblist.com/lists/username/list-slug');
  }
  const [, usernameFromUrl, listSlug] = urlMatch;

  // If no API key is provided, try to use public JSON endpoint to extract basic list info
  if (!apiKey) {
    console.log('[MDBList] No API key provided for URL extraction, attempting public JSON approach...');
    try {
      // Try to fetch just a small sample to verify the list exists and get basic info
      const sampleUrl = `https://mdblist.com/lists/${usernameFromUrl}/${listSlug}/json/?limit=1`;
      const response = await axios.get(sampleUrl, { 
        timeout: 10000,
        headers: {
          'User-Agent': 'AIOLists-Stremio-Addon/1.0'
        }
      });

      if (!response.data || !Array.isArray(response.data)) {
        throw new Error('Public JSON endpoint returned invalid format');
      }

      // For public JSON, we can't get exact count or list details, so we'll make reasonable assumptions
      const hasItems = response.data.length > 0;
      
      // Analyze the sample to determine content types
      let hasMovies = false;
      let hasShows = false;
      
      if (hasItems) {
        response.data.forEach(item => {
          if (item.mediatype === 'movie') hasMovies = true;
          if (item.mediatype === 'show' || item.mediatype === 'series') hasShows = true;
        });
      }
      
      // If we couldn't determine from sample, assume both types are possible
      if (!hasMovies && !hasShows) {
        hasMovies = true;
        hasShows = true;
      }
      
      // Convert slug to human-readable name
      const humanReadableName = listSlug
        .split('-')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
      
      return {
        listId: listSlug, // Use slug as ID for public access
        listSlug: listSlug,
        username: usernameFromUrl,
        listName: humanReadableName, // Convert slug to readable name
        isUrlImport: true,
        isPublicAccess: true, // Flag to indicate this was accessed via public JSON
        hasMovies: hasMovies,
        hasShows: hasShows,
        // Store info needed for public JSON access
        mdblistUsername: usernameFromUrl,
        mdblistSlug: listSlug
      };
    } catch (error) {
      console.error(`[MDBList] Public JSON extraction failed for ${usernameFromUrl}/${listSlug}:`, error.message);
      throw new Error(`Failed to extract MDBList via public JSON: ${error.message}. An API key may be required for this list.`);
    }
  }

  // Original API-based extraction when API key is available
  let currentRetries = 0;
  while (currentRetries < MAX_RETRIES) {
    try {
      const apiResponse = await axios.get(`https://api.mdblist.com/lists/${usernameFromUrl}/${listSlug}?apikey=${apiKey}`, { timeout: 15000 });

      if (!apiResponse.data || !Array.isArray(apiResponse.data) || apiResponse.data.length === 0) {
        throw new Error('Could not fetch list details from MDBList API or list is empty/not found. Response: ' + JSON.stringify(apiResponse.data));
      }

      const listData = apiResponse.data[0]; // Correct: Access the first (and only) object in the array

      if (typeof listData.user_name === 'undefined') {
        const actualResponse = JSON.stringify(listData);
        throw new Error(`API response did not include expected 'user_name'. Response: ${actualResponse}`);
      }

      return {
        listId: String(listData.id),
        listSlug: listData.slug,
        username: listData.user_name,
        listName: listData.name,
        isUrlImport: true,
        hasMovies: listData.movies > 0,
        hasShows: listData.shows > 0,
        // Store info needed for public JSON access as fallback
        mdblistUsername: usernameFromUrl,
        mdblistSlug: listSlug
      };
    } catch (error) {
      currentRetries++;
      console.error(`Error extracting MDBList from URL (attempt ${currentRetries}/${MAX_RETRIES}):`, error.response ? (error.response.data || error.response.status) : error.message);
      
      // If API key is invalid/expired, try public JSON fallback
      if (error.response && (error.response.status === 401 || error.response.status === 403)) {
        console.log(`[MDBList] API authentication failed during URL extraction, attempting public JSON fallback...`);
        try {
          const sampleUrl = `https://mdblist.com/lists/${usernameFromUrl}/${listSlug}/json/?limit=1`;
          const publicResponse = await axios.get(sampleUrl, { 
            timeout: 10000,
            headers: {
              'User-Agent': 'AIOLists-Stremio-Addon/1.0'
            }
          });

          if (publicResponse.data && Array.isArray(publicResponse.data)) {
            const hasItems = publicResponse.data.length > 0;
            let hasMovies = false;
            let hasShows = false;
            
            if (hasItems) {
              publicResponse.data.forEach(item => {
                if (item.mediatype === 'movie') hasMovies = true;
                if (item.mediatype === 'show' || item.mediatype === 'series') hasShows = true;
              });
            }
            
            if (!hasMovies && !hasShows) {
              hasMovies = true;
              hasShows = true;
            }
            
            // Convert slug to human-readable name
            const humanReadableName = listSlug
              .split('-')
              .map(word => word.charAt(0).toUpperCase() + word.slice(1))
              .join(' ');
            
            return {
              listId: listSlug,
              listSlug: listSlug,
              username: usernameFromUrl,
              listName: humanReadableName,
              isUrlImport: true,
              isPublicAccess: true,
              hasMovies: hasMovies,
              hasShows: hasShows,
              mdblistUsername: usernameFromUrl,
              mdblistSlug: listSlug
            };
          }
        } catch (publicError) {
          console.error(`[MDBList] Public JSON fallback also failed:`, publicError.message);
        }
      }
      
      if (error.response && (error.response.status === 503 || error.response.status === 429) && currentRetries < MAX_RETRIES) {
        const retryDelay = INITIAL_RETRY_DELAY_MS * Math.pow(2, currentRetries - 1);
        console.log(`Retrying after ${retryDelay}ms...`);
        await delay(retryDelay);
      } else {
        const errorMessage = error.response?.data?.error || error.message;
        const actualResponseContent = error.response?.data ? JSON.stringify(error.response.data) : (error.message.includes("Response:") ? error.message.split("Response:")[1] : "No detailed response data in error.");
        throw new Error(`Failed to extract MDBList: ${errorMessage}. Actual API response structure: ${actualResponseContent}`);
      }
    }
  }
  throw new Error('Failed to extract MDBList from URL after multiple retries.');
}

module.exports = {
  fetchAllLists,
  fetchAllListsForUser,
  fetchListItems,
  fetchListItemsFromPublicJson,
  validateMDBListKey,
  extractListFromUrl,
  convertPublicListsToPremium
};