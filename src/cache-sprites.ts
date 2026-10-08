/**
 * Renders the piece sprites once at build time and caches them beside the build, so reading a
 * screenshot starts without rendering any SVG.
 */

import { cacheSprites } from './sprites.js';

await cacheSprites();
