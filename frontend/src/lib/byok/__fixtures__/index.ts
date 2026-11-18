/**
 * Real catalog payloads generated from `backend.byok.ledger.catalog_payload`
 * for every key combination. `tests/test_byok_catalog_fixture.py` keeps them
 * identical to the ledger. Test-only.
 */
import type { ProviderCatalog } from '../types'
import kiePiapi from './catalog.kie_piapi.json'
import kie from './catalog.kie.json'
import piapi from './catalog.piapi.json'
import none from './catalog.none.json'

export const CATALOG_BOTH = kiePiapi as unknown as ProviderCatalog
export const CATALOG_KIE = kie as unknown as ProviderCatalog
export const CATALOG_PIAPI = piapi as unknown as ProviderCatalog
export const CATALOG_NONE = none as unknown as ProviderCatalog

export const CATALOGS = {
  both: CATALOG_BOTH,
  kie: CATALOG_KIE,
  piapi: CATALOG_PIAPI,
  none: CATALOG_NONE,
} as const
