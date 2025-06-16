// src/integrations/externalAddons.js
const axios = require('axios');
const { enrichItemsWithMetadata } = require('../utils/metadataFetcher');

class ExternalAddon {
  constructor(manifestUrl) {
    this.originalManifestUrl = this.normalizeUrl(manifestUrl);
    this.manifest = null;
    this.apiBaseUrl = '';
  }

  normalizeUrl(url) {
    if (url.startsWith('stremio://')) {
      return 'https://' + url.substring(10);
    }
    return url;
  }

  setApiBaseUrlFromManifestUrl() {
    const fullUrl = this.originalManifestUrl;
    const manifestPathSegment = "/manifest.json";

    if (fullUrl.endsWith(manifestPathSegment)) {
      this.apiBaseUrl = fullUrl.substring(0, fullUrl.length - manifestPathSegment.length + 1);
    } else {
      this.apiBaseUrl = fullUrl.endsWith('/') ? fullUrl : fullUrl + '/';
    }
  }

  async import(userConfig) {
    try {
      const response = await axios.get(this.originalManifestUrl);
      this.manifest = response.data;

      if (!this.manifest || !this.manifest.id || !this.manifest.catalogs) {
        throw new Error('Invalid external manifest format: missing id or catalogs');
      }
      
      this.setApiBaseUrlFromManifestUrl();

      const letterboxdStaticPrefix = "github.megadrive.stremio.letterboxd";
      let isSourceManifestALetterboxdList = false;
      if (typeof this.manifest.id === 'string') {
          isSourceManifestALetterboxdList = this.manifest.id.trim().startsWith(letterboxdStaticPrefix + ":");
      }

      if (isSourceManifestALetterboxdList && userConfig && typeof userConfig.letterboxdImportCounter === 'undefined') {
          userConfig.letterboxdImportCounter = 0;
      }

      const idUsageMap = new Map();

      const processedCatalogs = this.manifest.catalogs.map(catalog => {
        if (!catalog.id || !catalog.type) {
            return null;
        }
        const originalCatalogIdFromSource = catalog.id;
        const originalCatalogType = catalog.type;
        
        let stremioFinalCatalogType = originalCatalogType;

        if (originalCatalogType === 'tv') {
            stremioFinalCatalogType = 'series';
        }

        const hasSearchRequirement = (catalog.extra || []).some(e => e.name === 'search' && e.isRequired);
        if (hasSearchRequirement) {
            return null;
        }
        let aiolistsUniqueCatalogId;
        if (isSourceManifestALetterboxdList && userConfig) {
            userConfig.letterboxdImportCounter++;
            aiolistsUniqueCatalogId = `${letterboxdStaticPrefix}:${userConfig.letterboxdImportCounter}`;
        } else {
            const uniquenessTrackingKey = `${originalCatalogIdFromSource}|${originalCatalogType}`;
            const instanceCount = (idUsageMap.get(uniquenessTrackingKey) || 0) + 1;
            idUsageMap.set(uniquenessTrackingKey, instanceCount);
            aiolistsUniqueCatalogId = `${this.manifest.id.trim()}_${originalCatalogIdFromSource}_${originalCatalogType}`;
            if (instanceCount > 1) {
              aiolistsUniqueCatalogId += `_${instanceCount}`;
            }
        }
        let processedExtraSupported = [];
        const originalExtra = catalog.extraSupported || catalog.extra || [];
        originalExtra.forEach(extraItem => {
            if (typeof extraItem === 'string' && extraItem === "genre") {
                // Handle simple string format - convert to object without options
                processedExtraSupported.push({ name: "genre" });
            } else if (typeof extraItem === 'object' && extraItem.name === "genre") {
                // Preserve the full genre extra with options from manifest.json
                processedExtraSupported.push({
                    name: "genre",
                    options: extraItem.options || [], // Keep native genre options
                    isRequired: extraItem.isRequired || false
                });
            } else {
                processedExtraSupported.push(extraItem);
            }
        });
        return {
          id: aiolistsUniqueCatalogId,
          originalId: originalCatalogIdFromSource,
          originalManifestId: this.manifest.id.trim(),
          originalType: originalCatalogType,
          name: catalog.name || 'Unnamed Catalog',
          type: stremioFinalCatalogType,
          extraSupported: processedExtraSupported,
          extraRequired: catalog.extraRequired || (catalog.extra || []).filter(e => e.isRequired)
        };
      }).filter(catalog => catalog !== null);

      let tentativeLogo = this.manifest.logo;
      const defaultLogoUrl = "https://cdn-icons-png.flaticon.com/512/32/32465.png";

      if (tentativeLogo && typeof tentativeLogo === 'string') {
        tentativeLogo = tentativeLogo.trim();
        if (!tentativeLogo.startsWith('http://') && !tentativeLogo.startsWith('https://') && !tentativeLogo.startsWith('data:')) {
          try { 
            tentativeLogo = new URL(tentativeLogo, this.apiBaseUrl).href; 
          } catch (e) {
            console.warn(`[ExternalAddon] Malformed logo URL or base URL for: ${this.manifest.logo}, base: ${this.apiBaseUrl}. Using default logo.`);
            tentativeLogo = defaultLogoUrl;
          }
        }
      } else {
        // No logo URL provided or it's not a string
        if (this.manifest.hasOwnProperty('logo') && this.manifest.logo !== null && typeof this.manifest.logo !== 'undefined') { // if 'logo' key exists but value is weird
          console.warn(`[ExternalAddon] Invalid logo value specified for addon ${this.manifest.id}: ${this.manifest.logo}. Using default logo.`);
        }
        tentativeLogo = defaultLogoUrl;
      }

      let finalLogo = tentativeLogo;

      // If the tentativeLogo is an HTTP/HTTPS URL, try to verify its accessibility
      if (finalLogo && finalLogo.startsWith('http')) {
        try {
          await axios.head(finalLogo, { timeout: 3500 }); // Short timeout for HEAD request
        } catch (error) {
          console.warn(`[ExternalAddon] Logo URL ${finalLogo} for addon ${this.manifest.id.trim()} appears broken or inaccessible. Error: ${error.message}. Falling back to default logo.`);
          finalLogo = defaultLogoUrl;
        }
      } else if (!finalLogo || typeof finalLogo !== 'string' || (!finalLogo.startsWith('data:') && !finalLogo.startsWith('http'))) {
        if (finalLogo !== defaultLogoUrl) { // Avoid redundant console log if it was already set to default
            console.warn(`[ExternalAddon] Final logo for ${this.manifest.id.trim()} is invalid (${finalLogo}). Using default logo.`);
        }
        finalLogo = defaultLogoUrl;
      }

      return {
        id: this.manifest.id.trim(),
        name: this.manifest.name || 'Unknown Addon',
        version: this.manifest.version || '0.0.0',
        logo: finalLogo, // Use the validated or default logo
        apiBaseUrl: this.apiBaseUrl,
        catalogs: processedCatalogs,
        types: this.manifest.types || [],
        resources: this.manifest.resources || [],
        isAnime: this.detectAnimeCatalogs()
      };
    } catch (error) {
      console.error(`[AIOLists ExternalAddon] Error importing addon from ${this.originalManifestUrl}:`, error.message, error.stack);
      let specificError = error.message;
      if (error.response) {
        specificError += ` (Status: ${error.response.status})`;
      }
      throw new Error(`Failed to import addon: ${specificError}`);
    }
  }

  detectAnimeCatalogs() {
    // ... (detectAnimeCatalogs method remains the same)
    const nameIncludesAnime = this.manifest?.name?.toLowerCase().includes('anime');
    const urlIncludesAnimeSource = ['myanimelist', 'anilist', 'anidb', 'kitsu', 'livechart', 'notify.moe'].some(src => this.originalManifestUrl.toLowerCase().includes(src));
    const hasAnimeTypeInManifestTypes = this.manifest?.types?.includes('anime');
    const hasAnimeTypeCatalog = this.manifest?.catalogs?.some(cat => cat.type === 'anime');
    return !!(nameIncludesAnime || urlIncludesAnimeSource || hasAnimeTypeInManifestTypes || hasAnimeTypeCatalog);
  }

  buildCatalogUrl(catalogOriginalId, catalogOriginalType, skip = 0, genre = null) {
    let urlPath = `catalog/${catalogOriginalType}/${encodeURIComponent(catalogOriginalId)}`;
    const extraParams = [];
    if (skip > 0) extraParams.push(`skip=${skip}`);
    if (genre) extraParams.push(`genre=${encodeURIComponent(genre)}`); 
    if (extraParams.length > 0) {
      urlPath += `/${extraParams.join('&')}`;
    }
    urlPath += '.json';
    return this.apiBaseUrl + urlPath;
  }
}

async function importExternalAddon(manifestUrl, userConfig) {
  const addon = new ExternalAddon(manifestUrl);
  return await addon.import(userConfig);
}

async function fetchExternalAddonItems(targetOriginalId, targetOriginalType, sourceAddonConfig, skip = 0, rpdbApiKey = null, genre = null, userConfig = null) {
  let attemptedUrl = "Unknown (URL could not be constructed before error)";
  try {
    if (!sourceAddonConfig || !sourceAddonConfig.apiBaseUrl || !sourceAddonConfig.catalogs) {
      console.error('[AIOLists ExternalAddon] Invalid source addon configuration for fetching items. Config:', sourceAddonConfig);
      return { metas: [], hasMovies: false, hasShows: false };
    }
    const catalogEntry = sourceAddonConfig.catalogs.find(
      c => c.originalId === targetOriginalId && c.originalType === targetOriginalType
    );
    if (!catalogEntry) {
      const fallbackCatalogEntry = sourceAddonConfig.catalogs.find(c => c.id === targetOriginalId && c.originalType === targetOriginalType);
      if (!fallbackCatalogEntry) {
        console.warn(`[AIOLists ExternalAddon] Catalog not found for originalId: ${targetOriginalId}, type: ${targetOriginalType} in addon ${sourceAddonConfig.name}`);
        return { metas: [], hasMovies: false, hasShows: false };
      }
    }
    
    // Use native external addon genre filtering when available
    // Only skip if the external addon doesn't support genre filtering natively
    const catalogSupportsGenres = catalogEntry?.extraSupported?.some(e => 
      (typeof e === 'object' && e.name === 'genre') || e === 'genre'
    );
    
    const genreForExternalAddon = (catalogSupportsGenres && genre && genre !== 'All') ? genre : null;
    
    if (catalogSupportsGenres && genre && genre !== 'All') {
      console.log(`[ExternalAddon] Using native genre filtering for "${genre}" on ${sourceAddonConfig.name}`);
    } else if (genre && genre !== 'All') {
      console.log(`[ExternalAddon] External addon does not support native genre filtering - will filter after enrichment`);
    }
    
    const tempExternalAddon = new ExternalAddon(sourceAddonConfig.apiBaseUrl); 
    tempExternalAddon.apiBaseUrl = sourceAddonConfig.apiBaseUrl;
    attemptedUrl = tempExternalAddon.buildCatalogUrl(catalogEntry.originalId, catalogEntry.originalType, skip, genreForExternalAddon);
    const response = await axios.get(attemptedUrl, { timeout: 20000 });
    if (!response.data || !Array.isArray(response.data.metas)) {
      console.error(`[AIOLists ExternalAddon] Invalid metadata response from ${attemptedUrl}: Data or metas array missing. Response:`, response.data);
      return { metas: [], hasMovies: false, hasShows: false };
    }
    let metasFromExternal = response.data.metas;
    if (sourceAddonConfig && typeof sourceAddonConfig.name === 'string' && sourceAddonConfig.name.toLowerCase().includes('trakt up next')) {
        metasFromExternal = metasFromExternal.map(meta => {
            if (meta && typeof meta.id === 'string' && meta.id.startsWith('tun_')) {
                const correctedId = meta.id.substring(4);
                if (/^tt\d+$/.test(correctedId)) {
                    return { ...meta, id: correctedId };
                }
            }
            return meta;
        });
    }
    // No metadata enrichment here - this will be done in the addon builder when serving to Stremio
    let enrichedMetas = metasFromExternal;
    let finalMetas = enrichedMetas;
    // Note: Genre filtering is handled at different levels:
    // 1. Native addon filtering (when supported) - handled above via genreForExternalAddon
    // 2. Post-enrichment filtering (for addons without native support) - handled in addon builder
    const hasMovies = finalMetas.some(m => m.type === 'movie');
    const hasShows = finalMetas.some(m => m.type === 'series');
    return { metas: finalMetas, hasMovies, hasShows };
  } catch (error) {
    console.error(`[AIOLists ExternalAddon] Error fetching items for external catalog ID '${targetOriginalId}' (type: '${targetOriginalType}', from addon '${sourceAddonConfig?.name}'). Attempted URL: ${attemptedUrl}. Error:`, error.message);
    if (error.response) {
        console.error("[AIOLists ExternalAddon] Error response status:", error.response.status);
    } else {
        console.error("[AIOLists ExternalAddon] Error stack:", error.stack);
    }
    return { metas: [], hasMovies: false, hasShows: false };
  }
}

module.exports = {
  importExternalAddon,
  fetchExternalAddonItems,
  ExternalAddon 
};