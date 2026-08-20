import { apiSurface } from './api.ts';
import { searchSurface } from './search.ts';
import { toolsSurface } from './tools.ts';
import type { Dispatch, Manifest, Surface, SurfaceKind } from './types.ts';

export { apiSurface, openApiDoc, matchRoute } from './api.ts';
export { toolsSurface, toolName, opTool } from './tools.ts';
export { searchSurface } from './search.ts';
export { manifestFor, narrow as narrowManifest, validate as validateManifest } from './manifest.ts';
export type { Dispatch, Manifest, OpSpec, Surface, SurfaceCall, SurfaceKind, ToolRegistry } from './types.ts';

export function openSurface(kind: SurfaceKind, manifest: Manifest, dispatch: Dispatch): Surface {
  if (kind === 'api') return apiSurface(manifest, dispatch);
  if (kind === 'search') return searchSurface(manifest, dispatch);
  return toolsSurface(manifest, dispatch);
}
